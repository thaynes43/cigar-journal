import { sql, type SQL } from "drizzle-orm";
import type { Deps, Principal } from "./deps.js";
import type {
  BrandShelf,
  BrowseBrandsArgs,
  BrowseBrandsResult,
  CatalogCigarTile,
  CatalogTilePrice,
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
// keys off ADR-009's stored per-stick offer column (`price_per_stick_cents`),
// unpriced cigars grouped last (see sortSpec / OFFER_JOIN).
export const CATALOG_SORTS = ["name", "my-rating", "recently-added", "price"] as const satisfies readonly CatalogSort[];

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

// The same scalar in an AGGREGATE form, for SELECTing `remaining` on a grouped
// tile query (the page groups by c.id, so the 1:1 ownership-join columns must be
// wrapped in an aggregate). max() over the per-cigar value returns that value;
// floored at zero to match inventory's displayed remaining (ADR-008).
const REMAINING_AGG = sql`greatest(coalesce(max(pur.acquired), 0) - coalesce(max(con.consumed), 0), 0)`;

// The per-cigar best-offer aggregate (PRD-003 R-PRICE-2 / R-UNI-3, ADR-009),
// catalog/market-scoped so it takes no principal. One pre-aggregated row per
// cigar — folded into a tile read as a 1:1 LEFT JOIN, so it never fans out the
// GROUP BY and the unfiltered/unpriced browse pays nothing (co is null). It
// mirrors reads.ts `latestSeries`/`getCigarPricing`: the current observation per
// (source, packaging) series (the two offer paths unioned — crawler rows through
// their auto|confirmed listing match, ad-hoc/chat rows direct via cigar_id), then
// the single best row per cigar — in-stock preferred, cheapest per-stick where
// derivable (ties toward singles), else the lowest package price. `best_pps_cents`
// is the price sort key and the per-stick display figure (null → the tile shows
// the package price); `has_in_stock` backs the inStock filter.
const OFFER_JOIN = sql`
  LEFT JOIN (
    WITH obs AS (
      SELECT lm.cigar_id AS cigar_id, v.name AS source,
             o.in_stock, o.price, o.currency, o.seen_at, o.created_at, o.id,
             o.packaging, o.sticks_per_package, o.price_per_stick_cents
      FROM offers o
      JOIN listing_matches lm ON lm.id = o.listing_match_id
      JOIN vendors v ON v.id = o.vendor_id
      WHERE lm.status IN ('auto', 'confirmed')
      UNION ALL
      SELECT o.cigar_id AS cigar_id, COALESCE(v.name, o.source_name) AS source,
             o.in_stock, o.price, o.currency, o.seen_at, o.created_at, o.id,
             o.packaging, o.sticks_per_package, o.price_per_stick_cents
      FROM offers o
      LEFT JOIN vendors v ON v.id = o.vendor_id
      WHERE o.listing_match_id IS NULL AND o.cigar_id IS NOT NULL
    ),
    latest AS (
      SELECT DISTINCT ON (cigar_id, source, packaging) *
      FROM obs
      ORDER BY cigar_id, source, packaging, seen_at DESC, created_at DESC, id DESC
    ),
    best AS (
      SELECT DISTINCT ON (cigar_id)
        cigar_id, price_per_stick_cents, price, currency, packaging,
        sticks_per_package, seen_at
      FROM latest
      ORDER BY cigar_id,
        (in_stock IS FALSE) ASC,
        (price_per_stick_cents IS NULL) ASC,
        price_per_stick_cents ASC NULLS LAST,
        price ASC NULLS LAST,
        sticks_per_package ASC NULLS LAST,
        seen_at DESC, id DESC
    )
    SELECT b.cigar_id,
      b.price_per_stick_cents AS best_pps_cents,
      b.price AS best_price,
      b.currency AS best_currency,
      b.packaging AS best_packaging,
      b.sticks_per_package AS best_sticks,
      b.seen_at::text AS best_seen_at,
      bool_or(l.in_stock IS NOT FALSE) AS has_in_stock
    FROM best b
    JOIN latest l ON l.cigar_id = b.cigar_id
    GROUP BY b.cigar_id, b.price_per_stick_cents, b.price, b.currency,
             b.packaging, b.sticks_per_package, b.seen_at
  ) co ON co.cigar_id = c.id
`;

// The price-sort keyset encodes an unpriced (null per-stick) tail row with this
// sentinel key, since the sort orders `best_pps_cents ASC NULLS LAST`: a numeric
// key pages within the priced rows (and then into the null tail), this sentinel
// walks the null tail alone. Not a valid number, so it never collides with a
// real cents key.
const NULL_PRICE_KEY = "~";

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

// The MCP surface's independent, composable overlay filters (DESIGN-002, PRD-003
// R-MCP-1). Each is tri-state — undefined skips, true requires the property,
// false requires its absence — and they AND together (and with the web's `own`
// facet), unlike that one exclusive control. `inHumidor`/`wanted` reference the
// pre-aggregated ownershipJoins columns; `inStock` the OFFER_JOIN's has_in_stock;
// `smoked`/`favorited` a principal-scoped EXISTS. All pre-group, so they belong
// in WHERE, and none leak another user's state. Callers must ensure the
// referenced joins are present (tileSelect always carries them; the count query
// adds them per filter — the EXISTS-form filters are self-contained, needing none).
function overlayFilters(principal: Principal, args: BrowseCatalogArgs): SQL[] {
  const conds: SQL[] = [];
  if (args.inHumidor === true) conds.push(sql`${REMAINING} > 0`);
  if (args.inHumidor === false) conds.push(sql`${REMAINING} <= 0`);
  if (args.wanted === true) conds.push(sql`w.id IS NOT NULL`);
  if (args.wanted === false) conds.push(sql`w.id IS NULL`);
  if (args.smoked === true)
    conds.push(
      sql`EXISTS (SELECT 1 FROM smokes sx WHERE sx.cigar_id = c.id AND sx.user_id = ${principal.userId})`,
    );
  if (args.smoked === false)
    conds.push(
      sql`NOT EXISTS (SELECT 1 FROM smokes sx WHERE sx.cigar_id = c.id AND sx.user_id = ${principal.userId})`,
    );
  if (args.favorited === true)
    conds.push(
      sql`EXISTS (SELECT 1 FROM favorites fx WHERE fx.cigar_id = c.id AND fx.user_id = ${principal.userId})`,
    );
  if (args.favorited === false)
    conds.push(
      sql`NOT EXISTS (SELECT 1 FROM favorites fx WHERE fx.cigar_id = c.id AND fx.user_id = ${principal.userId})`,
    );
  if (args.inStock === true) conds.push(sql`co.has_in_stock IS TRUE`);
  if (args.inStock === false) conds.push(sql`co.has_in_stock IS NOT TRUE`);
  return conds;
}

// Which joins the COUNT query needs for the active filters (the page query's
// tileSelect always carries all of them). `own`/inHumidor/wanted need the
// ownershipJoins; inStock needs the OFFER_JOIN; brand/type/q/smoked/favorited
// need neither (plain columns or a self-contained EXISTS).
function countJoinsFor(principal: Principal, args: BrowseCatalogArgs, facet: SQL | null): SQL {
  const needsOwnership =
    facet != null || args.inHumidor !== undefined || args.wanted !== undefined;
  const needsOffers = args.inStock !== undefined;
  return sql`${needsOwnership ? ownershipJoins(principal) : sql``}${needsOffers ? OFFER_JOIN : sql``}`;
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
    case "price":
      // best current per-stick offer ASC (cheapest first), NULLS LAST so unpriced
      // cigars group after priced ones (R-UNI-3), id ASC to break ties. The key is
      // a per-cigar column of the OFFER_JOIN, available pre-group, so the cursor
      // continues the page in WHERE (not HAVING); the null tail is walked via the
      // NULL_PRICE_KEY sentinel. ORDER BY reads the aggregated max() form (the page
      // groups by c.id), which equals the 1:1 join's value.
      return {
        orderBy: sql`max(co.best_pps_cents) ASC NULLS LAST, c.id ASC`,
        cursorKey: (row) =>
          row.best_pps_cents != null ? String(Number(row.best_pps_cents)) : NULL_PRICE_KEY,
        where: (cur) =>
          cur.key === NULL_PRICE_KEY
            ? sql`(co.best_pps_cents IS NULL AND c.id > ${cur.id}::uuid)`
            : sql`(co.best_pps_cents > ${Number(cur.key)} OR (co.best_pps_cents = ${Number(cur.key)} AND c.id > ${cur.id}::uuid) OR co.best_pps_cents IS NULL)`,
        having: null,
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
  cover_photo_id: string | null;
}

// The library root: every distinct brand (whitespace-trimmed, empty → null) with
// its stick count, line count, the cigar types it spans, and a borrowed poster
// cover. The cover is the brand's first-by-name cigar that has a SERVABLE product
// photo (the join excludes `suppressed` — DESIGN-003 §Curation), picked in the
// same grouped LEFT JOIN (product_photos is 1:1 so it never fans out the counts)
// — no N+1. Sorted by brand name with the unbranded shelf last.
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
  // Only active rows populate the brand wall (DESIGN-003 §Curation): excluded
  // pollution and merged tombstones drop out of the counts, covers, and shelves.
  conds.push(sql`c.catalog_status = 'active'`);
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
        FILTER (WHERE pp.id IS NOT NULL))[1] AS cover_cigar_id,
      (array_agg(pp.id::text ORDER BY c.canonical_name ASC, c.id ASC)
        FILTER (WHERE pp.id IS NOT NULL))[1] AS cover_photo_id
    FROM cigars c
    LEFT JOIN product_photos pp ON pp.cigar_id = c.id AND pp.rights <> 'suppressed'
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
    coverProductPhotoId: row.cover_photo_id ?? null,
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
  // The servable photo's id (null when none) — fingerprints the tile thumb (#127).
  product_photo_id: string | null;
  wanted: boolean | null;
  favorited: boolean | null;
  // The caller's derived stock (acquired − consumed, floored), for the tile's
  // "in humidor" overlay (ADR-008).
  remaining: number | string | null;
  // Price-at-a-glance columns from OFFER_JOIN (the single best current offer).
  // `best_pps_cents` is also the `price` sort key. All null when no offer exists.
  best_pps_cents: number | string | null;
  best_price: number | string | null;
  best_currency: string | null;
  best_packaging: string | null;
  best_sticks: number | string | null;
  best_seen_at: string | null;
  // Ordering-only column for the "recently added" keyset cursor; not surfaced on
  // the public tile (CatalogCigarTile stays personal-overlay-only).
  created_at: string | Date;
}

// The tile's price-at-a-glance from the best-offer columns (ADR-009). A per-stick
// figure when one is derivable (`best_pps_cents` set), else the package price;
// either way carrying its packaging, so a bare per-stick figure never travels.
// Null when the cigar has no offer (co is null → best_seen_at null).
function toTilePrice(row: CatalogTileRow): CatalogTilePrice | null {
  if (row.best_seen_at == null) return null;
  const seenAt = new Date(row.best_seen_at).toISOString();
  const sticksPerPackage = row.best_sticks != null ? Number(row.best_sticks) : null;
  const pps = row.best_pps_cents != null ? Number(row.best_pps_cents) : null;
  if (pps != null) {
    return { perStick: true, amount: pps / 100, packaging: row.best_packaging, sticksPerPackage, currency: row.best_currency, seenAt };
  }
  if (row.best_price != null) {
    return { perStick: false, amount: Number(row.best_price), packaging: row.best_packaging, sticksPerPackage, currency: row.best_currency, seenAt };
  }
  return null;
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
    remaining: row.remaining != null ? Number(row.remaining) : 0,
    hasProductPhoto: row.has_product_photo === true,
    productPhotoId: row.product_photo_id ?? null,
    wanted: row.wanted === true,
    favorited: row.favorited === true,
    price: toTilePrice(row),
  };
}

// The caller-scoped overlay expression, shared by every tile read: a LEFT JOIN
// to the caller's smokes only, aggregated per cigar. `count` is 0 and `rating`
// is null when the caller has never smoked the cigar. A LEFT JOIN to
// product_photos (1:1 with a cigar) folds in whether a servable crawler photo
// exists, without a second query (ADR-007). The join excludes `suppressed`
// photos (rights takedown, DESIGN-003 §Curation), so a cigar whose only photo is
// suppressed reads has_product_photo=false and falls back to its monogram. The
// ownershipJoins fold in the want mark
// (for the badge — PRD-003 R-WANT-3) and the acquired/consumed aggregates (for
// the ownership facet and sorts), all pre-aggregated so nothing fans out and no
// user's state leaks into another's tiles. `created_at` rides along for the
// recently-added keyset cursor. One more LEFT JOIN to the caller's favorites
// (1:1 by the UNIQUE (user_id, cigar_id) pair) folds in the favorite mark the
// same way (PRD-003, DESIGN-002) — the second cigar-level mark, mirroring want.
function tileSelect(principal: Principal): SQL {
  return sql`
    SELECT c.id, c.canonical_name, c.brand, c.line, c.vitola_name, c.length_inches,
      c.ring_gauge, c.type, c.verification, c.created_at::text AS created_at,
      count(s.id)::int AS user_smoke_count,
      round(avg(s.rating))::int AS user_rating,
      ${REMAINING_AGG}::int AS remaining,
      bool_or(pp.id IS NOT NULL) AS has_product_photo,
      max(pp.id::text) AS product_photo_id,
      bool_or(w.id IS NOT NULL) AS wanted,
      bool_or(f.id IS NOT NULL) AS favorited,
      max(co.best_pps_cents)::int AS best_pps_cents,
      max(co.best_price) AS best_price,
      max(co.best_currency) AS best_currency,
      max(co.best_packaging) AS best_packaging,
      max(co.best_sticks)::int AS best_sticks,
      max(co.best_seen_at) AS best_seen_at
    FROM cigars c
    LEFT JOIN smokes s ON s.cigar_id = c.id AND s.user_id = ${principal.userId}
    LEFT JOIN product_photos pp ON pp.cigar_id = c.id AND pp.rights <> 'suppressed'
    ${ownershipJoins(principal)}
    LEFT JOIN favorites f ON f.cigar_id = c.id AND f.user_id = ${principal.userId}
    ${OFFER_JOIN}
  `;
}

// A brand page: the brand resolved from its slug, its lines (alphabetical, each
// with its cigars by canonical name), and the loose cigars with no line. Unknown
// slug → CigarNotFoundError. Only active rows count (DESIGN-003 §Curation): a
// brand whose cigars are all excluded/merged resolves to no active rows and 404s,
// and an excluded/merged member never appears on the page.
export async function getBrand(
  deps: Deps,
  principal: Principal,
  args: { slug: string },
): Promise<GetBrandResult> {
  const distinct = await deps.db.execute(sql`
    SELECT DISTINCT nullif(btrim(brand), '') AS brand
    FROM cigars
    WHERE nullif(btrim(brand), '') IS NOT NULL AND catalog_status = 'active'
  `);
  const brand = (distinct.rows as unknown as { brand: string }[])
    .map((r) => r.brand)
    .find((b) => brandSlug(b) === args.slug);
  if (brand == null) throw new CigarNotFoundError();

  const result = await deps.db.execute(sql`
    ${tileSelect(principal)}
    WHERE nullif(btrim(c.brand), '') = ${brand} AND c.catalog_status = 'active'
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
    .map(([line, cigars]) => {
      const cover = cigars.find((c) => c.hasProductPhoto) ?? null;
      return {
        line,
        cigars,
        coverCigarId: cover?.cigarId ?? null,
        coverProductPhotoId: cover?.productPhotoId ?? null,
      };
    });

  const brandCover = tiles.find((tile) => tile.hasProductPhoto) ?? null;

  return {
    brand,
    coverCigarId: brandCover?.cigarId ?? null,
    coverProductPhotoId: brandCover?.productPhotoId ?? null,
    lines,
    loose,
  };
}

// The All-cigars browse: q/brand/type/ownership filtered (the web's exclusive
// `own` facet or the independent inHumidor/wanted/smoked/favorited/inStock
// booleans), sorted (name | my-rating | recently-added | price), keyset-paginated
// per sort so pages never dup or gap. Fetches one extra row to decide whether a
// next cursor exists. The filters and cursor thread through WHERE for plain-column
// / per-cigar-join sorts and HAVING for the aggregate `my-rating` sort (sortSpec).
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

  // q/brand/type filters, the exclusive ownership facet, and the independent
  // overlay booleans — shared by the page and the count query (both must apply
  // the same membership). The overlay conditions reference the ownershipJoins /
  // OFFER_JOIN columns, which tileSelect always carries; the count query adds
  // only the joins its active filters need (countJoinsFor).
  const facet = ownershipCondition(args.own);
  const filters: SQL[] = [];
  // The unified grid shows only active rows (DESIGN-003 §Curation): excluded
  // pollution and merged tombstones never appear in browse or its total. Applied
  // to both the page and the count query (both derive from `filters`).
  filters.push(sql`c.catalog_status = 'active'`);
  if (q) {
    const pattern = likePattern(q);
    filters.push(
      sql`(c.canonical_name ILIKE ${pattern} OR c.brand ILIKE ${pattern} OR c.line ILIKE ${pattern})`,
    );
  }
  if (args.brand) filters.push(sql`lower(btrim(c.brand)) = lower(btrim(${args.brand}))`);
  if (args.type) filters.push(sql`c.type = ${args.type}`);
  if (facet) filters.push(facet);
  filters.push(...overlayFilters(principal, args));

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

  // Total matching the filters (q/brand/type/facet/overlay), ignoring the cursor.
  // The count query carries only the joins its active filters reference.
  const filterWhere = filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
  const countJoins = countJoinsFor(principal, args, facet);
  const totals = await deps.db.execute(sql`
    SELECT count(*)::int AS total FROM cigars c ${countJoins} ${filterWhere}
  `);
  const totalCount = Number((totals.rows as unknown as { total: number }[])[0]?.total ?? 0);

  return { cigars: page, nextCursor, totalCount };
}
