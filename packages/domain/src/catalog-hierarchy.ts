import { sql, type SQL } from "drizzle-orm";
import type { Deps } from "./deps.js";
import {
  HIERARCHY_UNFILED,
  type CatalogDimension,
  type CatalogHierarchyFilter,
} from "./types.js";

// The catalog hierarchy in SQL (ADR-012 registries, DESIGN-004 D-01/D-05/D-06).
//
// Everything the grouped, filtered and drilled catalog reads share lives here so
// the leaf grid, the group cards and the chip options can only ever agree on
// what a level MEANS. That agreement is the whole point of D-01: a drill and a
// chip write the same URL param, so they must resolve to the same predicate, or
// a card's count stops matching the grid it opens.
//
// Three shapes recur:
//   HIERARCHY_JOINS      — the registry rows a leaf hangs off (all 1:1).
//   VITOLA_SLUG          — the odd level out: no registry table, so a key.
//   hierarchyConditions  — one predicate per pinned level, ANDed with everything.

// The leaf's structural ancestry, joined by id. All three FKs are nullable and
// all three targets are keyed by their primary key, so each join is strictly 1:1
// — they can be added to a query that GROUP BYs `c.id` without fanning out a
// count, and to the count query without inflating a total. Aliases are short
// (br/ln/bl) because these joins appear inside every catalog read.
export const HIERARCHY_JOINS = sql`
  LEFT JOIN brands br ON br.id = c.brand_id
  LEFT JOIN lines ln ON ln.id = c.line_id
  LEFT JOIN blends bl ON bl.id = c.blend_id
`;

// The vitola key. ADR-012 deliberately mints no `vitolas` table — a vitola is a
// size label within a blend, not an entity — so the level's key is the slugged
// `cigars.vitola_name` rather than a stored column.
//
// The slug rule is transcribed from migration 0026 CHARACTER FOR CHARACTER,
// including the explicit `[^abcdefghijklmnopqrstuvwxyz0123456789]+` class rather
// than `a-z`: inside a bracket expression Postgres interprets ranges by
// collation, and under a non-C collation `a-z` can swallow accented letters,
// which would silently disagree with the JS `brandSlug()` the web links with.
// Agreement with brandSlug() is what lets a tile's `?vitola=` link resolve back
// to the rows that produced it.
//
// The inner `nullif(btrim(...), '')` makes a blank vitola NULL before slugging;
// the OUTER one makes a punctuation-only vitola (`"---"` → `''`) NULL as well,
// so it reads as ABSENT rather than as a real group keyed on the empty string.
// An empty-string key would be unaddressable by URL — the same reason 0026 skips
// punctuation-only brand names as unmintable.
export const VITOLA_SLUG = sql`nullif(btrim(regexp_replace(lower(nullif(btrim(c.vitola_name), '')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-'), '')`;

// One predicate per pinned level (DESIGN-004 D-01: "a drill is nothing but
// setting one of them"). They AND with q/type/own/overlay by construction, which
// is why filters compose with drills for free.
//
// Two forms per level:
//   `unfiled` (the reserved slug, D-05) → the IS NULL form. It selects that
//     level's null population BENEATH whatever ancestors are also pinned, which
//     is what makes the Unfiled card drillable.
//   any other value → slug equality against the registry row (or, for vitola,
//     against the derived key).
//
// A SLUG THAT MATCHES NOTHING YIELDS AN EMPTY RESULT, AND THAT IS CORRECT. A
// drill into a group that has since been renamed or merged away must show
// nothing; treating an unknown slug as "no filter" would silently show the whole
// catalog under a header naming an entity that is not there.
export function hierarchyConditions(filter: CatalogHierarchyFilter | undefined): SQL[] {
  const conds: SQL[] = [];
  if (!filter) return conds;

  const { brand, line, blend, vitola } = filter;
  if (brand) {
    conds.push(brand === HIERARCHY_UNFILED ? sql`c.brand_id IS NULL` : sql`br.slug = ${brand}`);
  }
  if (line) {
    conds.push(line === HIERARCHY_UNFILED ? sql`c.line_id IS NULL` : sql`ln.slug = ${line}`);
  }
  if (blend) {
    conds.push(blend === HIERARCHY_UNFILED ? sql`c.blend_id IS NULL` : sql`bl.slug = ${blend}`);
  }
  if (vitola) {
    // `VITOLA_SLUG IS NULL` rather than `nullif(btrim(c.vitola_name),'') IS NULL`:
    // the two differ only for a punctuation-only vitola name, and this form is
    // exactly "the group key is null" — so the Unfiled card's count always equals
    // the row count of the drill that card links to. The narrower form would let
    // a `"---"` row count on the card and vanish from the drill.
    conds.push(vitola === HIERARCHY_UNFILED ? sql`${VITOLA_SLUG} IS NULL` : sql`${VITOLA_SLUG} = ${vitola}`);
  }
  return conds;
}

// Does this filter set reference the HIERARCHY_JOINS columns? Only the slug
// forms at brand/line/blend do (`br.slug`/`ln.slug`/`bl.slug`). The IS NULL forms
// read `c.brand_id`/`c.line_id`/`c.blend_id` straight off the leaf, and BOTH
// vitola forms read `c.vitola_name` — so an `unfiled`-only or vitola-only filter
// needs no join at all. The count query uses this to keep paying nothing for
// joins it does not read.
export function hierarchyActive(filter: CatalogHierarchyFilter | undefined): boolean {
  if (!filter) return false;
  return (["brand", "line", "blend"] as const).some(
    (level) => filter[level] != null && filter[level] !== HIERARCHY_UNFILED,
  );
}

// How one dimension is grouped, labelled, and traced to its parent. The grouped
// views (D-03) and the chip options (D-06) run the SAME aggregation over these,
// so a chip's count and its group card's count cannot drift.
export interface DimensionSpec {
  // The GROUP BY key. NULL is a real bucket here: it is the Unfiled population.
  key: SQL;
  // The same key rendered as text, so the caller can tell the null bucket apart
  // without a second column.
  keyText: SQL;
  // The drill slug and the card label, both AGGREGATED: the query groups by the
  // key, and every other column is therefore either an aggregate or off-limits.
  // For brand/line/blend the key is the row's PK, so min() over a functionally
  // dependent column returns that row's value.
  slug: SQL;
  name: SQL;
  // The immediate parent's name (D-03 sub-label), or null for a dimension with
  // no parent to name.
  parent: SQL | null;
  // The level above this one, so a caller can drop `parent` when the drill
  // header already says it.
  parentDimension: CatalogDimension | null;
  // Joins this dimension needs BEYOND HIERARCHY_JOINS — the parent lookups.
  joins: SQL;
  // "This row has a group key" — excludes the Unfiled population. Chips take it
  // (Unfiled is a group-card affordance, never a chip option); group cards do not.
  keyed: SQL;
}

export function dimensionSpec(by: CatalogDimension): DimensionSpec {
  switch (by) {
    case "line":
      // Line names collide across brands (`Reserva`, `Serie`), so a root-level
      // line card carries its brand as a sub-label. The parent is read through
      // `ln.brand_id` rather than the leaf's own `c.brand_id`: the line's own
      // parent is the true one, and a leaf may carry a line with no brand link.
      return {
        key: sql`ln.id`,
        keyText: sql`ln.id::text`,
        slug: sql`min(ln.slug)`,
        name: sql`min(ln.name)`,
        parent: sql`min(lnbr.name)`,
        parentDimension: "brand",
        joins: sql`LEFT JOIN brands lnbr ON lnbr.id = ln.brand_id`,
        keyed: sql`ln.id IS NOT NULL`,
      };
    case "blend":
      return {
        key: sql`bl.id`,
        keyText: sql`bl.id::text`,
        slug: sql`min(bl.slug)`,
        name: sql`min(bl.name)`,
        parent: sql`min(blln.name)`,
        parentDimension: "line",
        joins: sql`LEFT JOIN lines blln ON blln.id = bl.line_id`,
        keyed: sql`bl.id IS NOT NULL`,
      };
    case "vitola":
      // No registry row to read a display name off, so the label is a
      // representative raw spelling from the members. Distinct spellings that
      // slug identically (`Robusto` / `robusto`) are ONE group — the slug is the
      // identity — and min() picks the representative deterministically.
      return {
        key: VITOLA_SLUG,
        keyText: VITOLA_SLUG,
        slug: sql`min(${VITOLA_SLUG})`,
        name: sql`min(btrim(c.vitola_name))`,
        parent: null,
        parentDimension: null,
        joins: sql``,
        keyed: sql`${VITOLA_SLUG} IS NOT NULL`,
      };
    case "brand":
    default:
      return {
        key: sql`br.id`,
        keyText: sql`br.id::text`,
        slug: sql`min(br.slug)`,
        name: sql`min(br.name)`,
        parent: null,
        parentDimension: null,
        joins: sql``,
        keyed: sql`br.id IS NOT NULL`,
      };
  }
}

// ---- Drill-header resolution (DESIGN-004 D-04) -----------------------------

export interface ResolvedHierarchyLevel {
  slug: string;
  name: string;
}

// The display names behind the pinned slugs, one entry per level that RESOLVED.
// A level absent here is a slug that matched no row — the caller falls back to
// rendering the raw slug rather than inventing a name.
export type ResolvedCatalogHierarchy = Partial<Record<CatalogDimension, ResolvedHierarchyLevel>>;

// The Unfiled pseudo-entity (D-05 / §Strings). It is a real drill target with no
// registry row behind it, so it resolves by construction rather than by lookup.
const UNFILED_LEVEL: ResolvedHierarchyLevel = { slug: HIERARCHY_UNFILED, name: "Unfiled" };

// Name the entities a drill header is about (D-04: "back label, the entity name,
// and its cigar count").
//
// DELIBERATELY NOT FACETED. This applies no q/type/own/overlay filter and no
// `catalog_status` gate at the registry levels: it answers "what did I drill
// into", which is a fact about the URL, not about the current result set. A
// facet that empties the group must still leave the header naming the entity —
// otherwise narrowing a filter blanks the header and the user loses their place.
//
// Ancestors DO scope the lookup, because line and blend slugs are unique only
// within their parent (`lines_brand_id_slug_key`, `blends_line_id_slug_key`):
// `?brand=drew-estate&line=reserva` must resolve Drew Estate's Reserva, not some
// other brand's. With no ancestor pinned the slug can legitimately match several
// rows; the first by name wins, so the header is at least deterministic.
export async function resolveCatalogHierarchy(
  deps: Deps,
  filter: CatalogHierarchyFilter,
): Promise<ResolvedCatalogHierarchy> {
  const resolved: ResolvedCatalogHierarchy = {};
  // An ancestor pinned to `unfiled` scopes nothing — there is no registry row to
  // scope by — so it is treated as absent for lookup purposes.
  const scope = (slug: string | undefined): string | null =>
    slug != null && slug !== HIERARCHY_UNFILED ? slug : null;
  const first = (rows: unknown[]): string | null =>
    (rows as { name: string | null }[])[0]?.name ?? null;

  if (filter.brand) {
    if (filter.brand === HIERARCHY_UNFILED) {
      resolved.brand = UNFILED_LEVEL;
    } else {
      const rows = await deps.db.execute(
        sql`SELECT name FROM brands WHERE slug = ${filter.brand} ORDER BY name ASC LIMIT 1`,
      );
      const name = first(rows.rows);
      if (name != null) resolved.brand = { slug: filter.brand, name };
    }
  }

  if (filter.line) {
    if (filter.line === HIERARCHY_UNFILED) {
      resolved.line = UNFILED_LEVEL;
    } else {
      const brandScope = scope(filter.brand);
      const rows = await deps.db.execute(sql`
        SELECT ln.name AS name
        FROM lines ln
        JOIN brands b ON b.id = ln.brand_id
        WHERE ln.slug = ${filter.line}
          ${brandScope != null ? sql`AND b.slug = ${brandScope}` : sql``}
        ORDER BY ln.name ASC
        LIMIT 1
      `);
      const name = first(rows.rows);
      if (name != null) resolved.line = { slug: filter.line, name };
    }
  }

  if (filter.blend) {
    if (filter.blend === HIERARCHY_UNFILED) {
      resolved.blend = UNFILED_LEVEL;
    } else {
      const lineScope = scope(filter.line);
      const brandScope = scope(filter.brand);
      const rows = await deps.db.execute(sql`
        SELECT bl.name AS name
        FROM blends bl
        JOIN lines ln ON ln.id = bl.line_id
        JOIN brands b ON b.id = ln.brand_id
        WHERE bl.slug = ${filter.blend}
          ${lineScope != null ? sql`AND ln.slug = ${lineScope}` : sql``}
          ${brandScope != null ? sql`AND b.slug = ${brandScope}` : sql``}
        ORDER BY bl.name ASC
        LIMIT 1
      `);
      const name = first(rows.rows);
      if (name != null) resolved.blend = { slug: filter.blend, name };
    }
  }

  if (filter.vitola) {
    if (filter.vitola === HIERARCHY_UNFILED) {
      resolved.vitola = UNFILED_LEVEL;
    } else {
      // No registry row exists, so the display name is a representative spelling
      // off the leaves themselves — active ones only, since an excluded row's
      // spelling should not name a header. First by name, for determinism.
      const rows = await deps.db.execute(sql`
        SELECT btrim(c.vitola_name) AS name
        FROM cigars c
        WHERE c.catalog_status = 'active' AND ${VITOLA_SLUG} = ${filter.vitola}
        ORDER BY btrim(c.vitola_name) ASC
        LIMIT 1
      `);
      const name = first(rows.rows);
      if (name != null) resolved.vitola = { slug: filter.vitola, name };
    }
  }

  return resolved;
}
