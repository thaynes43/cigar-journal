import { sql, type SQL } from "drizzle-orm";
import type { Deps, Principal } from "./deps.js";
import type {
  BrandShelf,
  BrowseBrandsArgs,
  BrowseBrandsResult,
  CatalogCigarTile,
  CatalogTilePrice,
  CigarType,
  CigarNameSource,
  GetBrandResult,
  LineGroup,
  BrowseCatalogArgs,
  BrowseCatalogResult,
  BrowseCatalogGroupsArgs,
  BrowseCatalogGroupsResult,
  CatalogGroupCard,
  CatalogUnfiledGroup,
  CatalogFacetOption,
  CatalogFacetOptionsArgs,
  CatalogFacetOptionsResult,
  CatalogHierarchyFilter,
  OwnershipFacet,
  Verification,
  CatalogSort,
  CatalogSortDir,
} from "./types.js";
import { HIERARCHY_UNFILED } from "./types.js";
import { CigarNotFoundError } from "./errors.js";
import { loadBrandCovers } from "./brand-images.js";
import {
  HIERARCHY_JOINS,
  dimensionSpec,
  hierarchyActive,
  hierarchyConditions,
  lookupHierarchyEntity,
} from "./catalog-hierarchy.js";
import { isUuid } from "./uuid.js";
import { vendorDisplaysPricesSql, offerIsDisplayableSql } from "./offer-display.js";
import { isDecimal, isPgTimestamp } from "./cursor-keys.js";

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

// The direction a sort runs in when the caller does not say (DESIGN-004 D-04
// gives every leaf sort a direction; the URL token is `field:dir`).
//
// These mirror the web registry's `firstDir` — the direction a pill enters at —
// with ONE deliberate exception. `price` defaults ASC here where the registry
// enters DESC, because the web ALWAYS resolves a direction client-side (a bare
// `?sort=price` parses to that key's firstDir before it ever reaches this
// function), so the only callers who omit `sortDir` are the MCP surface and
// stored links, and `browse_catalog`'s published contract says price means
// "cheapest current per-stick first". Defaulting to DESC would silently reverse
// a documented tool result. The web's desc-first pill is unaffected: it sends
// `sortDir` explicitly.
const DEFAULT_SORT_DIR: Record<CatalogSort, CatalogSortDir> = {
  name: "asc",
  "my-rating": "desc",
  "recently-added": "desc",
  price: "asc",
};

// The cursor's stored sort IDENTITY: the field AND its direction. A direction
// flip is as incompatible with an in-flight keyset as a field change is — the
// comparison operator inverts — so both must invalidate a cursor.
function sortIdentity(sort: CatalogSort, dir: CatalogSortDir): string {
  return `${sort}:${dir}`;
}

// A keyset cursor carries the active sort identity plus the last row's ordering
// key and id. Encoding the identity lets a cursor minted under one ordering be
// rejected when the sort or its direction changes (the page then restarts
// cleanly) rather than paging garbage.
interface Cursor {
  sort: string; // `${field}:${dir}`
  key: string; // the primary sort value of the last row, serialized to a string
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.sort, c.key, c.id]), "utf8").toString("base64url");
}

// Decode a keyset cursor for a given active sort identity; a malformed value, or
// one from a different field or direction, is treated as absent (start of the
// list) rather than an error — a stale share link, a sort switch or a direction
// flip degrades to the first page.
//
// BOTH halves are shape-checked, because both are spent unquoted. The id reaches
// `${cur.id}::uuid` at nine sites across the four sorts (22P02 on junk), and the
// ordering key is cast per sort — `::timestamptz` for recently-added (22007),
// `Number()` for my-rating and price (NaN). Either way a well-formed envelope
// carrying junk used to reach Postgres and 500 instead of degrading, on the
// widest surface in the app: browse_catalog and catalog.browse both take the
// cursor as a bare string (#206 for the id, #229 for the key; ./uuid.ts,
// ./cursor-keys.ts).
//
// The key's type comes from the LANE rather than from this function, because the
// identity is an opaque `field:dir` string here — mapping it back to a typing
// would duplicate, in the decoder, knowledge that already lives beside each
// lane's SQL, and the two would drift the first time a sort was added. The lane
// that writes the cast is the lane that declares what it casts.
function decodeCursor(raw: string | null | undefined, identity: string, keyType: CursorKeyType): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string" &&
      parsed[0] === identity &&
      keyMatchesType(parsed[1], keyType) &&
      isUuid(parsed[2])
    ) {
      return { sort: identity, key: parsed[1], id: parsed[2] };
    }
    return null;
  } catch {
    return null;
  }
}

// What a sort casts its cursor key to (declared per lane in sortSpec):
//   text    — `name`, compared as text, so any string a name can hold is valid.
//   number  — `my-rating`, spent as `Number(cur.key)`.
//   price   — `price`, a number OR the NULL_PRICE_KEY sentinel that walks the
//             unpriced tail; the sentinel is compared before the cast, so it is
//             the one non-numeric key this lane can legitimately hold.
//   instant — `recently-added`, spent as `${cur.key}::timestamptz`.
type CursorKeyType = "text" | "number" | "price" | "instant";

function keyMatchesType(key: string, keyType: CursorKeyType): boolean {
  switch (keyType) {
    case "text":
      return true;
    case "number":
      return isDecimal(key);
    case "price":
      return key === NULL_PRICE_KEY || isDecimal(key);
    case "instant":
      return isPgTimestamp(key);
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
//
// Both arms carry the ADR-015 display gate (./offer-display.ts), so a tile's
// price, the price sort and the inStock filter all speak for tier 1 alone — the
// same set `latestSeries` shows on the detail page. A vendor whose offers are
// recorded but not displayed leaves its cigars looking unpriced here, which is
// what "displayed only from tier 1" means for a tile.
const OFFER_JOIN = sql`
  LEFT JOIN (
    WITH obs AS (
      SELECT lm.cigar_id AS cigar_id, v.name AS source,
             o.in_stock, o.price, o.currency, o.seen_at, o.created_at, o.id,
             o.packaging, o.sticks_per_package, o.price_per_stick_cents
      FROM offers o
      JOIN listing_matches lm ON lm.id = o.listing_match_id
      JOIN vendors v ON v.id = o.vendor_id
      WHERE lm.status IN ('auto', 'confirmed') AND ${vendorDisplaysPricesSql(sql`v`)}
      UNION ALL
      SELECT o.cigar_id AS cigar_id, COALESCE(v.name, o.source_name) AS source,
             o.in_stock, o.price, o.currency, o.seen_at, o.created_at, o.id,
             o.packaging, o.sticks_per_package, o.price_per_stick_cents
      FROM offers o
      LEFT JOIN vendors v ON v.id = o.vendor_id
      WHERE o.listing_match_id IS NULL AND o.cigar_id IS NOT NULL
        AND ${offerIsDisplayableSql(sql`o.vendor_id`, sql`v`)}
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
// The filter-bearing subset of BrowseCatalogArgs — everything the leaf grid, the
// grouped views and the chip options apply IDENTICALLY, minus the paging and
// ordering that only the leaf grid has. Typing the shared helpers against this
// is what lets browseCatalogGroups / catalogFacetOptions reuse them verbatim
// instead of re-deriving membership and drifting from the grid they describe.
type CatalogFilterArgs = Omit<BrowseCatalogArgs, "sort" | "sortDir" | "cursor" | "limit">;

function overlayFilters(principal: Principal, args: CatalogFilterArgs): SQL[] {
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
// ownershipJoins; inStock needs the OFFER_JOIN; a hierarchy filter needs
// HIERARCHY_JOINS only where it pins a real slug at brand/line/blend — the
// `unfiled` forms and both vitola forms read straight off `cigars`
// (hierarchyActive). brand/type/q/smoked/favorited need nothing (plain columns
// or a self-contained EXISTS).
function countJoinsFor(principal: Principal, args: CatalogFilterArgs, facet: SQL | null): SQL {
  const needsOwnership =
    facet != null || args.inHumidor !== undefined || args.wanted !== undefined;
  const needsOffers = args.inStock !== undefined;
  const needsHierarchy = hierarchyActive(args.hierarchy);
  return sql`${needsHierarchy ? HIERARCHY_JOINS : sql``}${needsOwnership ? ownershipJoins(principal) : sql``}${needsOffers ? OFFER_JOIN : sql``}`;
}

// The one membership definition every catalog read shares (DESIGN-004 D-01: a
// drill is just another filter, so the grid, the group cards and the chip counts
// must all AND the same set). `hierarchy` is passed separately rather than read
// off `args` because catalogFacetOptions deliberately drops ONE level from it
// (D-06) — everything else about the filter set is identical.
function catalogFilters(
  principal: Principal,
  args: CatalogFilterArgs,
  hierarchy: CatalogHierarchyFilter | undefined,
): SQL[] {
  const filters: SQL[] = [];
  // Only active rows are ever visible (DESIGN-003 §Curation): excluded pollution
  // and merged tombstones never appear in a grid, a count, a card or a chip.
  filters.push(sql`c.catalog_status = 'active'`);
  const q = args.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    filters.push(
      sql`(c.canonical_name ILIKE ${pattern} OR c.brand ILIKE ${pattern} OR c.line ILIKE ${pattern})`,
    );
  }
  if (args.brand) filters.push(sql`lower(btrim(c.brand)) = lower(btrim(${args.brand}))`);
  if (args.type) filters.push(sql`c.type = ${args.type}`);
  const facet = ownershipCondition(args.own);
  if (facet) filters.push(facet);
  filters.push(...overlayFilters(principal, args));
  filters.push(...hierarchyConditions(hierarchy));
  return filters;
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
  // What this lane casts an incoming cursor key to, so decodeCursor can refuse a
  // key it could not have issued rather than handing it to the cast (#229).
  keyType: CursorKeyType;
  // WHERE-form cursor condition (plain columns), or null when the sort keys off
  // an aggregate and uses `having` instead.
  where: ((c: Cursor) => SQL) | null;
  having: ((c: Cursor) => SQL) | null;
}

// Every sort runs in BOTH directions (DESIGN-004 D-04), and each direction needs
// its own keyset: reversing the ORDER BY reverses the comparison operator, so a
// cursor is only ever valid for the exact `field:dir` it was minted under
// (sortIdentity, above).
function sortSpec(sort: CatalogSort, dir: CatalogSortDir): SortSpec {
  const asc = dir === "asc";
  switch (sort) {
    case "my-rating":
      // The caller's rounded average. DESC is best-first with unrated (-1) last;
      // ASC is worst-first with unrated FIRST, because the key is a non-null
      // sentinel rather than a NULL — unrated genuinely is the bottom of this
      // scale, so it belongs at whichever end the direction puts it. id ASC breaks
      // ties either way. The cursor compares the aggregate, so it must be HAVING.
      return {
        orderBy: asc ? sql`${RATING_KEY} ASC, c.id ASC` : sql`${RATING_KEY} DESC, c.id ASC`,
        cursorKey: (row) => String(row.user_rating != null ? Number(row.user_rating) : -1),
        keyType: "number",
        where: null,
        having: (cur) =>
          asc
            ? sql`(${RATING_KEY} > ${Number(cur.key)} OR (${RATING_KEY} = ${Number(cur.key)} AND c.id > ${cur.id}::uuid))`
            : sql`(${RATING_KEY} < ${Number(cur.key)} OR (${RATING_KEY} = ${Number(cur.key)} AND c.id > ${cur.id}::uuid))`,
      };
    case "price":
      // Best current per-stick offer. NULLS LAST in BOTH directions — unpriced
      // cigars always group at the END (R-UNI-3): the unpriced break is a
      // rendering boundary, not a value, so flipping the direction must not
      // teleport it to the top and make the first screen empty of prices. id ASC
      // breaks ties. The key is a per-cigar column of the OFFER_JOIN, available
      // pre-group, so the cursor continues the page in WHERE (not HAVING); the
      // null tail is walked via the NULL_PRICE_KEY sentinel, unchanged in both
      // directions since the tail is in the same place. ORDER BY reads the
      // aggregated max() form (the page groups by c.id), which equals the 1:1
      // join's value.
      return {
        orderBy: asc
          ? sql`max(co.best_pps_cents) ASC NULLS LAST, c.id ASC`
          : sql`max(co.best_pps_cents) DESC NULLS LAST, c.id ASC`,
        cursorKey: (row) =>
          row.best_pps_cents != null ? String(Number(row.best_pps_cents)) : NULL_PRICE_KEY,
        keyType: "price",
        where: (cur) =>
          cur.key === NULL_PRICE_KEY
            ? sql`(co.best_pps_cents IS NULL AND c.id > ${cur.id}::uuid)`
            : asc
              ? sql`(co.best_pps_cents > ${Number(cur.key)} OR (co.best_pps_cents = ${Number(cur.key)} AND c.id > ${cur.id}::uuid) OR co.best_pps_cents IS NULL)`
              : sql`(co.best_pps_cents < ${Number(cur.key)} OR (co.best_pps_cents = ${Number(cur.key)} AND c.id > ${cur.id}::uuid) OR co.best_pps_cents IS NULL)`,
        having: null,
      };
    case "recently-added":
      // created_at, newest first under DESC and oldest first under ASC — a
      // plain-column keyset, so a single row-value comparison in WHERE continues
      // the page. Both members of the row value must run the same way for the
      // comparison to be a valid continuation, hence id DESC under DESC. The key
      // is the DB's own full-precision ::text rendering (tileSelect emits
      // created_at cast to text) so the cursor round-trips losslessly — a JS Date
      // would truncate to milliseconds and could skip rows sharing a millisecond.
      return {
        orderBy: asc ? sql`c.created_at ASC, c.id ASC` : sql`c.created_at DESC, c.id DESC`,
        cursorKey: (row) => String(row.created_at),
        keyType: "instant",
        where: (cur) =>
          asc
            ? sql`(c.created_at, c.id) > (${cur.key}::timestamptz, ${cur.id}::uuid)`
            : sql`(c.created_at, c.id) < (${cur.key}::timestamptz, ${cur.id}::uuid)`,
        having: null,
      };
    case "name":
    default:
      return {
        orderBy: asc ? sql`c.canonical_name ASC, c.id ASC` : sql`c.canonical_name DESC, c.id DESC`,
        cursorKey: (row) => row.canonical_name,
        keyType: "text",
        where: (cur) =>
          asc
            ? sql`(c.canonical_name, c.id) > (${cur.key}, ${cur.id}::uuid)`
            : sql`(c.canonical_name, c.id) < (${cur.key}, ${cur.id}::uuid)`,
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
    brandImage: null,
  }));

  // The Wikidata fallback (issue #127), asked for ONLY where the grouped query
  // found no member product photo — a member photo always outranks a brand logo,
  // and when one later arrives the wall reverts to it silently. One batched query
  // for the whole wall, merged in TS (see loadBrandCovers).
  const uncovered = brands.filter((b) => b.coverCigarId == null && b.slug != null).map((b) => b.slug!);
  if (uncovered.length > 0) {
    const covers = await loadBrandCovers(deps, uncovered);
    for (const shelf of brands) {
      if (shelf.coverCigarId == null && shelf.slug != null) {
        shelf.brandImage = covers.get(shelf.slug) ?? null;
      }
    }
  }

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
  // The structural ancestry behind the name (ADR-012, DESIGN-004 D-07). The three
  // names come off the joined registry rows, so they are aggregated (the page
  // groups by c.id); `name_source` is a `cigars` column and rides the GROUP BY on
  // the primary key like the rest.
  name_source: CigarNameSource;
  structural_brand: string | null;
  structural_line: string | null;
  structural_blend: string | null;
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
    nameSource: row.name_source,
    structuralBrand: row.structural_brand ?? null,
    structuralLine: row.structural_line ?? null,
    structuralBlend: row.structural_blend ?? null,
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
// Finally HIERARCHY_JOINS folds in the leaf's structural ancestry (ADR-012):
// three more 1:1 joins that neither fan out the GROUP BY nor cost anything when
// the FKs are null, feeding both the D-07 caption elision and hierarchy filters.
function tileSelect(principal: Principal): SQL {
  return sql`
    SELECT c.id, c.canonical_name, c.brand, c.line, c.vitola_name, c.length_inches,
      c.ring_gauge, c.type, c.verification, c.created_at::text AS created_at,
      c.name_source,
      max(br.name) AS structural_brand,
      max(ln.name) AS structural_line,
      max(bl.name) AS structural_blend,
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
    ${HIERARCHY_JOINS}
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
  // Same fallback rule as the wall: only when no member photo exists. Line
  // sections deliberately keep BandTile — a brand logo standing in for a line
  // section would misrepresent the product.
  const brandImage =
    brandCover == null ? ((await loadBrandCovers(deps, [args.slug])).get(args.slug) ?? null) : null;

  return {
    brand,
    coverCigarId: brandCover?.cigarId ?? null,
    coverProductPhotoId: brandCover?.productPhotoId ?? null,
    brandImage,
    lines,
    loose,
  };
}

// The All-cigars browse: q/brand/type/ownership filtered (the web's exclusive
// `own` facet or the independent inHumidor/wanted/smoked/favorited/inStock
// booleans), scoped by the structural hierarchy (DESIGN-004 D-01 — a drill is
// just another filter), sorted (name | my-rating | recently-added | price) in
// either direction, keyset-paginated per `field:dir` so pages never dup or gap.
// Fetches one extra row to decide whether a next cursor exists. The filters and
// cursor thread through WHERE for plain-column / per-cigar-join sorts and HAVING
// for the aggregate `my-rating` sort (sortSpec).
export async function browseCatalog(
  deps: Deps,
  principal: Principal,
  args: BrowseCatalogArgs = {},
): Promise<BrowseCatalogResult> {
  const limit = clampLimit(args.limit);
  const sort: CatalogSort = args.sort ?? "name";
  const dir: CatalogSortDir = args.sortDir ?? DEFAULT_SORT_DIR[sort];
  const spec = sortSpec(sort, dir);
  const cursor = decodeCursor(args.cursor, sortIdentity(sort, dir), spec.keyType);

  // q/brand/type filters, the exclusive ownership facet, the independent overlay
  // booleans and the hierarchy scope — shared by the page and the count query
  // (both must apply the same membership). The overlay conditions reference the
  // ownershipJoins / OFFER_JOIN columns and the hierarchy slugs the registry
  // joins, all of which tileSelect always carries; the count query adds only the
  // joins its active filters need (countJoinsFor).
  const facet = ownershipCondition(args.own);
  const filters = catalogFilters(principal, args, args.hierarchy);

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
      ? encodeCursor({ sort: sortIdentity(sort, dir), key: spec.cursorKey(lastRow), id: lastRow.id })
      : null;

  // Total matching the filters (q/brand/type/facet/overlay/hierarchy), ignoring
  // the cursor.
  // The count query carries only the joins its active filters reference.
  const filterWhere = filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
  const countJoins = countJoinsFor(principal, args, facet);
  const totals = await deps.db.execute(sql`
    SELECT count(*)::int AS total FROM cigars c ${countJoins} ${filterWhere}
  `);
  const totalCount = Number((totals.rows as unknown as { total: number }[])[0]?.total ?? 0);

  return { cigars: page, nextCursor, totalCount };
}

// ---- Grouped views (DESIGN-004 D-03/D-05) ---------------------------------

const DEFAULT_FACET_LIMIT = 200;
const MAX_FACET_LIMIT = 500;

function clampFacetLimit(value: number | undefined): number {
  const n = value ?? DEFAULT_FACET_LIMIT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_FACET_LIMIT;
  return Math.min(Math.floor(n), MAX_FACET_LIMIT);
}

// One aggregated row per group key. `group_key` is null exactly for the Unfiled
// population (D-05); the cover arrays are null when no member had a servable
// photo, since `array_agg(...) FILTER (...)` over an empty filter yields NULL.
interface CatalogGroupRow {
  group_key: string | null;
  slug: string | null;
  name: string | null;
  parent_name: string | null;
  parent_slug: string | null;
  cigar_count: number | string;
  in_humidor_count: number | string;
  wanted_count: number | string;
  cover_cigar_ids: string[] | null;
  cover_photo_ids: string[] | null;
}

// Group cards sort by the two facts they carry, not by the leaf set (D-04). The
// key expression closes the order deterministically: line and blend names
// legitimately repeat across parents, so name alone is not a total order and the
// grid would shuffle between identical requests.
function groupOrderBy(
  spec: ReturnType<typeof dimensionSpec>,
  sort: BrowseCatalogGroupsArgs["groupSort"],
): SQL {
  const field = sort?.field ?? "name";
  const dir = sort?.dir ?? "asc";
  if (field === "count") {
    // Count with a stable name tiebreak, so equal-sized groups stay alphabetical
    // rather than falling out in scan order.
    return dir === "asc"
      ? sql`count(*) ASC, ${spec.name} ASC, ${spec.keyText} ASC`
      : sql`count(*) DESC, ${spec.name} ASC, ${spec.keyText} ASC`;
  }
  return dir === "asc"
    ? sql`${spec.name} ASC, ${spec.keyText} ASC`
    : sql`${spec.name} DESC, ${spec.keyText} ASC`;
}

// The grouped catalog view (DESIGN-004 D-03): one aggregate card per member of
// `args.by`, under EXACTLY the filter set browseCatalog would apply — q, brand,
// type, the ownership facet, the overlay booleans and the hierarchy ancestors.
// That identity is the contract: a card's count is the number of tiles the drill
// it opens will show, so the two reads share `catalogFilters` rather than each
// spelling out membership.
//
// The null-key rows are NOT dropped the way haynesnetwork drops them
// (books-query.ts) — they become the trailing `unfiled` bucket (D-05), which is
// the honest divergence: ported as-is that rule would hide most of this catalog
// while the Wave 3 backfill runs. It is returned as null (not a zero row) when
// empty, because the card must not render at zero.
//
// `args.by` naming a level the hierarchy already pins is not an error: the
// filters simply collapse the view to the single card that level selected. The
// web registry never offers that combination, but a hand-written URL can, and a
// throw there would be a 500 where a degenerate-but-correct page will do.
export async function browseCatalogGroups(
  deps: Deps,
  principal: Principal,
  args: BrowseCatalogGroupsArgs,
): Promise<BrowseCatalogGroupsResult> {
  const spec = dimensionSpec(args.by);
  const filters = catalogFilters(principal, args, args.hierarchy);
  const where = sql`WHERE ${sql.join(filters, sql` AND `)}`;
  // ownershipJoins are UNCONDITIONAL here, unlike in the count query: the badge
  // counts read them even when no ownership filter is active. The offer join is
  // still conditional — only the inStock filter touches it.
  const offerJoin = args.inStock !== undefined ? OFFER_JOIN : sql``;

  const result = await deps.db.execute(sql`
    SELECT
      ${spec.keyText} AS group_key,
      ${spec.slug} AS slug,
      ${spec.name} AS name,
      ${spec.parent ?? sql`NULL::text`} AS parent_name,
      ${spec.parentSlug ?? sql`NULL::text`} AS parent_slug,
      count(*)::int AS cigar_count,
      count(*) FILTER (WHERE ${REMAINING} > 0)::int AS in_humidor_count,
      count(*) FILTER (WHERE w.id IS NOT NULL)::int AS wanted_count,
      (array_agg(c.id ORDER BY c.canonical_name ASC, c.id ASC)
        FILTER (WHERE pp.id IS NOT NULL))[1:3] AS cover_cigar_ids,
      (array_agg(pp.id::text ORDER BY c.canonical_name ASC, c.id ASC)
        FILTER (WHERE pp.id IS NOT NULL))[1:3] AS cover_photo_ids
    FROM cigars c
    ${HIERARCHY_JOINS}
    ${spec.joins}
    LEFT JOIN product_photos pp ON pp.cigar_id = c.id AND pp.rights <> 'suppressed'
    ${ownershipJoins(principal)}
    ${offerJoin}
    ${where}
    GROUP BY ${spec.key}
    ORDER BY ${groupOrderBy(spec, args.groupSort)}
  `);

  // The sub-label exists because line and blend names collide across parents
  // (D-03). Inside a drill the parent is already in the header, so repeating it
  // on every card is noise — hence null when the parent level is pinned.
  const parentPinned =
    spec.parentDimension != null && args.hierarchy?.[spec.parentDimension] != null;

  const groups: CatalogGroupCard[] = [];
  let unfiled: CatalogUnfiledGroup | null = null;

  for (const row of result.rows as unknown as CatalogGroupRow[]) {
    const cigarCount = Number(row.cigar_count);
    const inHumidorCount = Number(row.in_humidor_count);
    const wantedCount = Number(row.wanted_count);
    if (row.group_key == null || row.slug == null) {
      // The null-key population. Rendered last regardless of sort and never at
      // zero, so it leaves `groups` entirely rather than sorting among them.
      unfiled = { cigarCount, inHumidorCount, wantedCount };
      continue;
    }
    const coverIds = row.cover_cigar_ids ?? [];
    const coverPhotoIds = row.cover_photo_ids ?? [];
    const covers: CatalogGroupCard["covers"] = [];
    // Vitolas get NO art, ever (D-03, the hnet WallGroupingArt rule): the
    // dimension is an abstract size label, so a member's photo would stand in for
    // something it is not. The card renders its themed glyph instead.
    if (args.by !== "vitola") {
      for (const [i, cigarId] of coverIds.entries()) {
        const productPhotoId = coverPhotoIds[i];
        if (productPhotoId != null) covers.push({ cigarId, productPhotoId });
      }
    }
    groups.push({
      dimension: args.by,
      // The registry row's id (the derived key, for vitola). The UI keys cards by
      // it: `Reserva` is a slug two brands can both own, so a slug-keyed list
      // collapses them onto one card.
      id: row.group_key,
      slug: row.slug,
      name: row.name ?? row.slug,
      parentName: parentPinned ? null : (row.parent_name ?? null),
      // Never suppressed the way `parentName` is: the sub-label is display and
      // hides once the header says it, but the drill still has to SCOPE itself.
      parentSlug: row.parent_slug ?? null,
      cigarCount,
      inHumidorCount,
      wantedCount,
      covers,
    });
  }

  return { groups, unfiled };
}

// ---- Facet options (DESIGN-004 D-06) --------------------------------------

interface CatalogFacetRow {
  id: string | null;
  slug: string | null;
  name: string | null;
  parent_name: string | null;
  parent_slug: string | null;
  option_count: number | string;
}

// The options behind one hierarchy chip, with the counts a picker is actually
// asked for.
//
// THE ONE DIVERGENCE FROM browseCatalogGroups: the dimension's OWN current value
// is dropped from the filter set before the query is built (D-06). A chip whose
// options were counted under its own selection would report `1` next to every
// unselected value and its own full count next to the selected one — it would
// answer "what did I already pick", not "what would I get if I picked this".
// Ancestors and every other facet stay applied, so the options remain scoped
// (the Line chip under `brand=drew-estate` offers only Drew Estate lines).
//
// No covers (a chip row has no art) and no Unfiled option: Unfiled is a
// group-card affordance, and a chip offering it would put a filter and a
// navigation target in the same control. An EMPTY `options` array is the signal
// the chip HIDES at this scope, which is why nothing is fabricated to fill it.
export async function catalogFacetOptions(
  deps: Deps,
  principal: Principal,
  args: CatalogFacetOptionsArgs,
): Promise<CatalogFacetOptionsResult> {
  const spec = dimensionSpec(args.dimension);
  const scoped: CatalogHierarchyFilter = { ...(args.hierarchy ?? {}) };
  delete scoped[args.dimension];

  const filters = catalogFilters(principal, args, scoped);
  // Keyed rows only — the null-key population is the group view's Unfiled card,
  // never a chip option.
  filters.push(spec.keyed);
  const where = sql`WHERE ${sql.join(filters, sql` AND `)}`;

  const facet = ownershipCondition(args.own);
  const needsOwnership =
    facet != null || args.inHumidor !== undefined || args.wanted !== undefined;
  const limit = clampFacetLimit(args.limit);

  const result = await deps.db.execute(sql`
    SELECT
      ${spec.keyText} AS id,
      ${spec.slug} AS slug,
      ${spec.name} AS name,
      ${spec.parent ?? sql`NULL::text`} AS parent_name,
      ${spec.parentSlug ?? sql`NULL::text`} AS parent_slug,
      count(*)::int AS option_count
    FROM cigars c
    ${HIERARCHY_JOINS}
    ${spec.joins}
    ${needsOwnership ? ownershipJoins(principal) : sql``}
    ${args.inStock !== undefined ? OFFER_JOIN : sql``}
    ${where}
    GROUP BY ${spec.key}
    ORDER BY ${spec.name} ASC, ${spec.keyText} ASC
    LIMIT ${limit}
  `);

  const parentPinned =
    spec.parentDimension != null && scoped[spec.parentDimension] != null;

  const options: CatalogFacetOption[] = [];
  for (const row of result.rows as unknown as CatalogFacetRow[]) {
    if (row.slug == null || row.id == null) continue; // defensive: `keyed` already excluded these
    options.push({
      id: row.id,
      slug: row.slug,
      name: row.name ?? row.slug,
      parentName: parentPinned ? null : (row.parent_name ?? null),
      parentSlug: row.parent_slug ?? null,
      count: Number(row.option_count),
    });
  }

  // Union the ACTIVE value's own row in, whatever its count.
  //
  // The aggregation above can legitimately omit it in two ways: its count under
  // the OTHER active facets is zero (nothing is grouped, so no row is produced),
  // or the option list was truncated by `limit`. Either way the chip is then
  // holding a value it has no row for, and the pill falls back to rendering the
  // raw slug — `Vitola · petit-corona` — which is the URL's vocabulary leaking
  // onto a display surface. Worse, it happens exactly when a filter has narrowed
  // things far enough to be worth reading.
  //
  // So the row is looked up directly (unfaceted, like the drill header's) and
  // counted for real under the full filter set. A count of 0 is the honest
  // answer and is shown as such: it says this value is why the grid is empty.
  //
  // Two guards, and both are load-bearing. The slug pre-check is the fast path:
  // when the aggregation already returned the value there is nothing to look up.
  // The identity re-check is what makes the union safe for a param that is NOT a
  // canonical slug — a pre-wave `?brand=Padrón` link resolves through the fold,
  // so the aggregation's row and the looked-up row wear different `slug` strings
  // while being the same brand. Deduping on the registry id is the only test that
  // sees that, and without it the chip would list the brand twice.
  const active = args.hierarchy?.[args.dimension];
  if (active != null && active !== HIERARCHY_UNFILED && !options.some((o) => o.slug === active)) {
    const entity = await lookupHierarchyEntity(deps, args.dimension, active, scoped);
    if (entity && !options.some((o) => o.id === entity.id)) {
      const activeFilters = catalogFilters(principal, args, {
        ...scoped,
        [args.dimension]: active,
      });
      const counted = await deps.db.execute(sql`
        SELECT count(*)::int AS n
        FROM cigars c
        ${HIERARCHY_JOINS}
        ${spec.joins}
        ${needsOwnership ? ownershipJoins(principal) : sql``}
        ${args.inStock !== undefined ? OFFER_JOIN : sql``}
        WHERE ${sql.join(activeFilters, sql` AND `)}
      `);
      const option: CatalogFacetOption = {
        id: entity.id,
        slug: entity.slug,
        name: entity.name,
        parentName: parentPinned ? null : entity.parentName,
        parentSlug: entity.parentSlug,
        count: Number((counted.rows[0] as { n: number | string } | undefined)?.n ?? 0),
      };
      // Placed by the same key the query ordered on (name, then identity) so the
      // unioned row sits where a counted one would have, not at the end.
      const at = options.findIndex(
        (o) => o.name > option.name || (o.name === option.name && o.id > option.id),
      );
      options.splice(at === -1 ? options.length : at, 0, option);
    }
  }

  return { options };
}
