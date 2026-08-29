import { sql, type SQL } from "drizzle-orm";
import type { Deps, Principal } from "./deps.js";
import type {
  BrandShelf,
  BrowseBrandsArgs,
  BrowseBrandsResult,
  CatalogCigarTile,
  CigarType,
  GetBrandResult,
  LineGroup,
  BrowseCatalogArgs,
  BrowseCatalogResult,
  OwnershipFacet,
  Verification,
  CatalogSort,
} from "./types.js";
import { CigarNotFoundError } from "./errors.js";

// The poster library reads (PRD-002 phase 2 / PRD-003 R-UNI). Browse descends
// brand → line → cigar; the personal overlay (caller's smoke count + average
// rating + want mark + ownership) folds in via pre-aggregated LEFT JOINs per read,
// so the surface never issues an N+1 and one user's history never leaks into
// another's tiles.

const DEFAULT_BROWSE_LIMIT = 48;
const MAX_BROWSE_LIMIT = 96;

// The All-view sorts this level answers, a typed const tuple so callers can
// derive a zod enum rather than scattering the literals — a level declares what
// it sorts by. Stays in step with the CatalogSort union in types.ts. `price`
// deliberately WAITS for ADR-009's per-stick offer column (do not fake it from
// raw offer price); adding it here is the only change the price-surfaces issue
// makes to this registry.
export const CATALOG_SORTS = ["name", "my-rating", "recently-added"] as const satisfies readonly CatalogSort[];

// A URL/data-model-stable brand key: lowercase, every run of non-alphanumerics
// collapsed to one hyphen, ends trimmed. Deterministic, so the same brand slugs
// identically in the domain (browseBrands) and the web (tile links) with no
// stored column — getBrand resolves back by scanning distinct brands through it.
export function brandSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clampLimit(value: number | undefined): number {
  const n = value ?? DEFAULT_BROWSE_LIMIT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BROWSE_LIMIT;
  return Math.min(Math.floor(n), MAX_BROWSE_LIMIT);
}

// A keyset cursor carries the active sort plus the last row's ordering key and
// id. Encoding the sort lets a cursor minted under one ordering be rejected when
// the sort changes (the page then restarts cleanly) rather than paging garbage.
interface Cursor {
  sort: CatalogSort;
  key: string; // the primary sort value of the last row, serialized to a string
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.sort, c.key, c.id]), "utf8").toString("base64url");
}

// Decode a keyset cursor for a given active sort; a malformed value, or one from
// a different sort, is treated as absent (start of the list) rather than an error
// — a stale share link or a sort switch degrades to the first page.
function decodeCursor(raw: string | null | undefined, sort: CatalogSort): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string" &&
      parsed[0] === sort
    ) {
      return { sort, key: parsed[1], id: parsed[2] };
    }
    return null;
  } catch {
    return null;
  }
}

// LIKE metacharacters are escaped so a user's `%`/`_` search literally, with `\`
// as the (default) escape character.
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

// The caller's ownership overlay joins (PRD-003 R-UNI-2), shared by every tile
// read and the brand wall. Each is PRE-AGGREGATED to one row per cigar, so they
// fold the caller's acquisitions, explicit consumptions, and want mark in without
// fanning out the smokes join or issuing an N+1:
//   pur.acquired  — sum of the caller's purchase quantities for the cigar
//   con.consumed  — the caller's explicit smoke→humidor links (ADR-008)
//   w             — the caller's want mark row (1:1 via UNIQUE(user,cigar))
// `remaining` derives as acquired − consumed (floored elsewhere); the facet
// filters on it directly. Every subquery is principal-scoped, so no other user's
// state ever reaches a tile.
function ownershipJoins(principal: Principal): SQL {
  return sql`
    LEFT JOIN (
      SELECT cigar_id, sum(quantity)::int AS acquired
      FROM purchases WHERE user_id = ${principal.userId}
      GROUP BY cigar_id
    ) pur ON pur.cigar_id = c.id
    LEFT JOIN (
      SELECT s2.cigar_id, count(sc.smoke_id)::int AS consumed
      FROM smokes s2 JOIN smoke_consumptions sc ON sc.smoke_id = s2.id
      WHERE s2.user_id = ${principal.userId}
      GROUP BY s2.cigar_id
    ) con ON con.cigar_id = c.id
    LEFT JOIN wants w ON w.cigar_id = c.id AND w.user_id = ${principal.userId}
  `;
}

// The `remaining` scalar over the ownership joins: acquired − consumed. A NULL
// (never purchased / never consumed) coalesces to 0, so a cigar the caller has
// never touched reads remaining 0 (a "don't have").
const REMAINING = sql`(coalesce(pur.acquired, 0) - coalesce(con.consumed, 0))`;

// The exclusive facet condition (DESIGN-002 §IA): `have` = remaining > 0, `want`
// = the mark exists, `dont` = no active holding. `all`/undefined applies none.
// References only the ownershipJoins columns, so it belongs in WHERE (pre-group).
function ownershipCondition(own: OwnershipFacet | undefined): SQL | null {
  switch (own) {
    case "have":
      return sql`${REMAINING} > 0`;
    case "want":
      return sql`w.id IS NOT NULL`;
    case "dont":
      return sql`${REMAINING} <= 0`;
    default:
      return null; // "all" or undefined — no filter
  }
}

// The caller's rounded average rating as a NON-NULL sort key: unrated cigars
// (never smoked, or smoked without a number) collapse to -1 so they sort last
// under a DESC "my rating" ordering. Matches the `user_rating` the tile exposes.
const RATING_KEY = sql`coalesce(round(avg(s.rating)), -1)`;

// Per-sort ordering + keyset plumbing (PRD-003 R-UNI-3). `orderBy` is the ORDER
// BY tail; `cursorKey` reads the last row's serialized primary value for the next
// cursor; the cursor CONDITION lives in WHERE for plain-column sorts and in
// HAVING for `my-rating` (an aggregate). Every ordering ends on c.id, which is
// unique, giving a strict total order so pages never dup or gap.
interface SortSpec {
  orderBy: SQL;
  cursorKey: (row: CatalogTileRow) => string;
  // WHERE-form cursor condition (plain columns), or null when the sort keys off
  // an aggregate and uses `having` instead.
  where: ((c: Cursor) => SQL) | null;
  having: ((c: Cursor) => SQL) | null;
}

function sortSpec(sort: CatalogSort): SortSpec {
  switch (sort) {
    case "my-rating":
      // rating DESC (best first), id ASC to break ties. The cursor compares the
      // aggregate, so it must be a HAVING clause.
      return {
        orderBy: sql`${RATING_KEY} DESC, c.id ASC`,
        cursorKey: (row) => String(row.user_rating != null ? Number(row.user_rating) : -1),
        where: null,
        having: (cur) =>
          sql`(${RATING_KEY} < ${Number(cur.key)} OR (${RATING_KEY} = ${Number(cur.key)} AND c.id > ${cur.id}::uuid))`,
      };
    case "recently-added":
      // created_at DESC (newest first), id DESC to break ties — a plain-column
      // keyset, so a single row-value comparison in WHERE continues the page.
      // The key is the DB's own full-precision ::text rendering (tileSelect emits
      // created_at cast to text) so the cursor round-trips losslessly — a JS Date
      // would truncate to milliseconds and could skip rows sharing a millisecond.
      return {
        orderBy: sql`c.created_at DESC, c.id DESC`,
        cursorKey: (row) => String(row.created_at),
        where: (cur) => sql`(c.created_at, c.id) < (${cur.key}::timestamptz, ${cur.id}::uuid)`,
        having: null,
      };
    case "name":
    default:
      return {
        orderBy: sql`c.canonical_name ASC, c.id ASC`,
        cursorKey: (row) => row.canonical_name,
        where: (cur) => sql`(c.canonical_name, c.id) > (${cur.key}, ${cur.id}::uuid)`,
        having: null,
      };
  }
}

interface BrandRow {
  brand: string | null;
  cigar_count: number;
  line_count: number;
  types: string[] | null;
  cover_cigar_id: string | null;
}

// The library root: every distinct brand (whitespace-trimmed, empty → null) with
// its stick count, line count, the cigar types it spans, and a borrowed poster
// cover. The cover is the brand's first-by-name cigar that has a product photo,
// picked in the same grouped LEFT JOIN (product_photos is 1:1 so it never fans
// out the counts) — no N+1. Sorted by brand name with the unbranded shelf last.
//
// The ownership and type facets (DESIGN-002 §IA) filter the wall BEFORE the
// grouping and compose: only cigars matching BOTH survive, so a brand with zero
// matches produces no group (drops off the wall) and every shelf's counts/cover
// re-badge to the matching subset. The ownershipJoins are added only when the
// ownership facet is active — the type filter is a plain column, so it needs
// none. The unfiltered root pays for neither.
export async function browseBrands(
  deps: Deps,
  principal: Principal,
  args: BrowseBrandsArgs = {},
): Promise<BrowseBrandsResult> {
  const facet = ownershipCondition(args.own);
  const conds: SQL[] = [];
  if (args.type) conds.push(sql`c.type = ${args.type}`);
  if (facet) conds.push(facet);
  const joins = facet ? ownershipJoins(principal) : sql``;
  const where = conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  const result = await deps.db.execute(sql`
    SELECT
      nullif(btrim(c.brand), '') AS brand,
      count(*)::int AS cigar_count,
      count(DISTINCT nullif(btrim(c.line), ''))::int AS line_count,
      array_agg(DISTINCT c.type) FILTER (WHERE c.type IS NOT NULL) AS types,
      (array_agg(c.id ORDER BY c.canonical_name ASC, c.id ASC)
        FILTER (WHERE pp.id IS NOT NULL))[1] AS cover_cigar_id
    FROM cigars c
    LEFT JOIN product_photos pp ON pp.cigar_id = c.id
    ${joins}
    ${where}
    GROUP BY nullif(btrim(c.brand), '')
    ORDER BY nullif(btrim(c.brand), '') ASC NULLS LAST
  `);

  const brands: BrandShelf[] = (result.rows as unknown as BrandRow[]).map((row) => ({
    brand: row.brand,
    slug: row.brand != null ? brandSlug(row.brand) : null,
    cigarCount: Number(row.cigar_count),
    lineCount: Number(row.line_count),
    types: [...((row.types ?? []) as CigarType[])].sort(),
    coverCigarId: row.cover_cigar_id ?? null,
  }));

  return { brands };
}

interface CatalogTileRow {
  id: string;
  canonical_name: string;
  brand: string | null;
  line: string | null;
  vitola_name: string | null;
  length_inches: string | null;
  ring_gauge: number | null;
  type: CigarType | null;
  verification: Verification;
  user_smoke_count: number | string;
  user_rating: number | string | null;
  has_product_photo: boolean | null;
  wanted: boolean | null;
  // Ordering-only column for the "recently added" keyset cursor; not surfaced on
  // the public tile (CatalogCigarTile stays personal-overlay-only).
  created_at: string | Date;
}

function toCatalogTile(row: CatalogTileRow): CatalogCigarTile {
  return {
    cigarId: row.id,
    canonicalName: row.canonical_name,
    brand: row.brand,
    line: row.line,
    vitola: {
      name: row.vitola_name,
      lengthInches: row.length_inches != null ? Number(row.length_inches) : null,
      ringGauge: row.ring_gauge,
    },
    type: row.type,
    verification: row.verification,
    userSmokeCount: Number(row.user_smoke_count),
    userRating: row.user_rating != null ? Number(row.user_rating) : null,
    hasProductPhoto: row.has_product_photo === true,
    wanted: row.wanted === true,
  };
}

// The caller-scoped overlay expression, shared by every tile read: a LEFT JOIN
// to the caller's smokes only, aggregated per cigar. `count` is 0 and `rating`
// is null when the caller has never smoked the cigar. A LEFT JOIN to
// product_photos (1:1 with a cigar) folds in whether a crawler photo exists,
// without a second query (ADR-007). The ownershipJoins fold in the want mark
// (for the badge — PRD-003 R-WANT-3) and the acquired/consumed aggregates (for
// the ownership facet and sorts), all pre-aggregated so nothing fans out and no
// user's state leaks into another's tiles. `created_at` rides along for the
// recently-added keyset cursor.
function tileSelect(principal: Principal): SQL {
  return sql`
    SELECT c.id, c.canonical_name, c.brand, c.line, c.vitola_name, c.length_inches,
      c.ring_gauge, c.type, c.verification, c.created_at::text AS created_at,
      count(s.id)::int AS user_smoke_count,
      round(avg(s.rating))::int AS user_rating,
      bool_or(pp.id IS NOT NULL) AS has_product_photo,
      bool_or(w.id IS NOT NULL) AS wanted
    FROM cigars c
    LEFT JOIN smokes s ON s.cigar_id = c.id AND s.user_id = ${principal.userId}
    LEFT JOIN product_photos pp ON pp.cigar_id = c.id
    ${ownershipJoins(principal)}
  `;
}

// A brand page: the brand resolved from its slug, its lines (alphabetical, each
// with its cigars by canonical name), and the loose cigars with no line. Unknown
// slug → CigarNotFoundError.
export async function getBrand(
  deps: Deps,
  principal: Principal,
  args: { slug: string },
): Promise<GetBrandResult> {
  const distinct = await deps.db.execute(sql`
    SELECT DISTINCT nullif(btrim(brand), '') AS brand
    FROM cigars
    WHERE nullif(btrim(brand), '') IS NOT NULL
  `);
  const brand = (distinct.rows as unknown as { brand: string }[])
    .map((r) => r.brand)
    .find((b) => brandSlug(b) === args.slug);
  if (brand == null) throw new CigarNotFoundError();

  const result = await deps.db.execute(sql`
    ${tileSelect(principal)}
    WHERE nullif(btrim(c.brand), '') = ${brand}
    GROUP BY c.id
    ORDER BY c.canonical_name ASC
  `);
  const tiles = (result.rows as unknown as CatalogTileRow[]).map(toCatalogTile);

  const byLine = new Map<string, CatalogCigarTile[]>();
  const loose: CatalogCigarTile[] = [];
  for (const tile of tiles) {
    const line = tile.line?.trim();
    if (line) {
      const bucket = byLine.get(line) ?? [];
      bucket.push(tile);
      byLine.set(line, bucket);
    } else {
      loose.push(tile);
    }
  }

  // Covers borrow a product photo (ADR-007). `tiles` is already canonical-name
  // sorted, so the first photographed cigar in a bucket is its first-by-name
  // one; deriving from the fetched rows adds no query.
  const lines: LineGroup[] = [...byLine.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([line, cigars]) => ({
      line,
      cigars,
      coverCigarId: cigars.find((c) => c.hasProductPhoto)?.cigarId ?? null,
    }));

  const coverCigarId = tiles.find((tile) => tile.hasProductPhoto)?.cigarId ?? null;

  return { brand, coverCigarId, lines, loose };
}

// The All-cigars browse: q/type/ownership filtered, sorted (name | my-rating |
// recently-added), keyset-paginated per sort so pages never dup or gap. Fetches
// one extra row to decide whether a next cursor exists. The ownership facet and
// the cursor thread through WHERE for plain-column sorts and HAVING for the
// aggregate `my-rating` sort (see sortSpec).
export async function browseCatalog(
  deps: Deps,
  principal: Principal,
  args: BrowseCatalogArgs = {},
): Promise<BrowseCatalogResult> {
  const limit = clampLimit(args.limit);
  const q = args.q?.trim();
  const sort: CatalogSort = args.sort ?? "name";
  const spec = sortSpec(sort);
  const cursor = decodeCursor(args.cursor, sort);

  // q/type filters plus the ownership facet, shared by the page and the count
  // query (both must apply the same membership). The facet references the
  // ownershipJoins columns, which tileSelect already carries; the count query
  // adds those joins itself when a facet is active.
  const facet = ownershipCondition(args.own);
  const filters: SQL[] = [];
  if (q) {
    const pattern = likePattern(q);
    filters.push(
      sql`(c.canonical_name ILIKE ${pattern} OR c.brand ILIKE ${pattern} OR c.line ILIKE ${pattern})`,
    );
  }
  if (args.type) filters.push(sql`c.type = ${args.type}`);
  if (facet) filters.push(facet);

  // The page WHERE adds the plain-column cursor condition; an aggregate-sort
  // cursor goes to HAVING instead (referenced below).
  const pageConds = [...filters];
  if (cursor && spec.where) pageConds.push(spec.where(cursor));
  const pageWhere = pageConds.length > 0 ? sql`WHERE ${sql.join(pageConds, sql` AND `)}` : sql``;
  const pageHaving = cursor && spec.having ? sql`HAVING ${spec.having(cursor)}` : sql``;

  const result = await deps.db.execute(sql`
    ${tileSelect(principal)}
    ${pageWhere}
    GROUP BY c.id
    ${pageHaving}
    ORDER BY ${spec.orderBy}
    LIMIT ${limit + 1}
  `);
  const rawRows = result.rows as unknown as CatalogTileRow[];

  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const page = pageRows.map(toCatalogTile);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({ sort, key: spec.cursorKey(lastRow), id: lastRow.id })
      : null;

  // Total matching the filters (q/type/facet), ignoring the cursor. The facet
  // needs the ownershipJoins here too, but only when it is active.
  const filterWhere = filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
  const countJoins = facet ? ownershipJoins(principal) : sql``;
  const totals = await deps.db.execute(sql`
    SELECT count(*)::int AS total FROM cigars c ${countJoins} ${filterWhere}
  `);
  const totalCount = Number((totals.rows as unknown as { total: number }[])[0]?.total ?? 0);

  return { cigars: page, nextCursor, totalCount };
}
