import { sql, type SQL } from "drizzle-orm";
import type { Deps, Principal } from "./deps.js";
import type {
  BrandShelf,
  BrowseBrandsResult,
  CatalogCigarTile,
  CigarType,
  GetBrandResult,
  LineGroup,
  BrowseCatalogArgs,
  BrowseCatalogResult,
  Verification,
  CatalogSort,
} from "./types.js";
import { CigarNotFoundError } from "./errors.js";

// The poster library reads (PRD-002 phase 2). Browse descends brand → line →
// cigar; the personal overlay (caller's smoke count + average rating) folds in
// via one grouped LEFT JOIN per read, so the surface never issues an N+1 and
// one user's history never leaks into another's tiles.

const DEFAULT_BROWSE_LIMIT = 48;
const MAX_BROWSE_LIMIT = 96;

// The All-view sorts this level answers. Single entry today; kept as a typed
// registry (a const tuple, so callers can derive a zod enum) rather than
// scattering the literal — a level declares what it sorts by. Stays in step with
// the CatalogSort union in types.ts.
export const CATALOG_SORTS = ["name"] as const satisfies readonly CatalogSort[];

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

interface Cursor {
  name: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.name, c.id]), "utf8").toString("base64url");
}

// Decode a keyset cursor; a malformed value is treated as absent (start of the
// list) rather than an error — a stale share link degrades to the first page.
function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { name: parsed[0], id: parsed[1] };
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
export async function browseBrands(deps: Deps): Promise<BrowseBrandsResult> {
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
  };
}

// The caller-scoped overlay expression, shared by every tile read: a LEFT JOIN
// to the caller's smokes only, aggregated per cigar. `count` is 0 and `rating`
// is null when the caller has never smoked the cigar. A second LEFT JOIN to
// product_photos (1:1 with a cigar) folds in whether a crawler photo exists,
// without a second query (ADR-007).
function tileSelect(principal: Principal): SQL {
  return sql`
    SELECT c.id, c.canonical_name, c.brand, c.line, c.vitola_name, c.length_inches,
      c.ring_gauge, c.type, c.verification,
      count(s.id)::int AS user_smoke_count,
      round(avg(s.rating))::int AS user_rating,
      bool_or(pp.id IS NOT NULL) AS has_product_photo
    FROM cigars c
    LEFT JOIN smokes s ON s.cigar_id = c.id AND s.user_id = ${principal.userId}
    LEFT JOIN product_photos pp ON pp.cigar_id = c.id
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

// The All-cigars browse: q/type filtered, name-sorted, keyset-paginated over
// (canonical_name, id) so pages never dup or gap even with repeated names.
// Fetches one extra row to decide whether a next cursor exists.
export async function browseCatalog(
  deps: Deps,
  principal: Principal,
  args: BrowseCatalogArgs = {},
): Promise<BrowseCatalogResult> {
  const limit = clampLimit(args.limit);
  const q = args.q?.trim();
  const cursor = decodeCursor(args.cursor);

  // Filters shared by the page and the total-count query.
  const filters: SQL[] = [];
  if (q) {
    const pattern = likePattern(q);
    filters.push(
      sql`(c.canonical_name ILIKE ${pattern} OR c.brand ILIKE ${pattern} OR c.line ILIKE ${pattern})`,
    );
  }
  if (args.type) filters.push(sql`c.type = ${args.type}`);

  const pageConds = [...filters];
  if (cursor) {
    pageConds.push(sql`(c.canonical_name, c.id) > (${cursor.name}, ${cursor.id}::uuid)`);
  }
  const pageWhere =
    pageConds.length > 0 ? sql`WHERE ${sql.join(pageConds, sql` AND `)}` : sql``;

  const result = await deps.db.execute(sql`
    ${tileSelect(principal)}
    ${pageWhere}
    GROUP BY c.id
    ORDER BY c.canonical_name ASC, c.id ASC
    LIMIT ${limit + 1}
  `);
  const rows = (result.rows as unknown as CatalogTileRow[]).map(toCatalogTile);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ name: last.canonicalName, id: last.cigarId }) : null;

  const filterWhere =
    filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
  const totals = await deps.db.execute(sql`
    SELECT count(*)::int AS total FROM cigars c ${filterWhere}
  `);
  const totalCount = Number((totals.rows as unknown as { total: number }[])[0]?.total ?? 0);

  return { cigars: page, nextCursor, totalCount };
}
