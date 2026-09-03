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
// the next one makes a punctuation-only vitola (`"---"` → `''`) NULL as well,
// so it reads as ABSENT rather than as a real group keyed on the empty string.
// An empty-string key would be unaddressable by URL — the same reason 0026 skips
// punctuation-only brand names as unmintable.
//
// The OUTERMOST `nullif(…, 'unfiled')` reserves the D-05 slug at this level. A
// cigar whose vitola_name is literally "Unfiled" would otherwise key a group on
// `unfiled`, and `?vitola=unfiled` means IS NULL — so that group's card would
// link to a screen that excludes every one of its own members, and the card
// would be unreachable by any URL. Folding it into the null bucket is the
// resolution that keeps the card's count and its drill's row count equal, which
// is the invariant this whole module exists to hold. Vitola is the only level
// that needs this handled at read time: brand, line and blend key off registry
// rows, where the slug is minted once and can be reserved at the write path.
export const VITOLA_SLUG = sql`nullif(nullif(btrim(regexp_replace(lower(nullif(btrim(c.vitola_name), '')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-'), ''), 'unfiled')`;

// One incoming param value, run through the STORED slug rule in SQL (the
// `brandSlug()` transcription that migrations 0026/0027 mint slugs with). Bound
// as a parameter and folded by Postgres, so it cannot drift from what those
// migrations wrote — the reason it is not the TS `brandSlug()` here.
//
// It backs the pre-wave fallback below. Deliberately the STORED rule and not
// `fold()`: fold strips accents, and probing `aliases` with it would make
// `?brand=padron` match a `Padrón` stored as `padr-n` *in addition to* a real
// `Padron` brand that owns the slug outright — widening a correct link into two
// marcas, which is exactly the inversion 0027's collision pass exists to prevent.
const slugFold = (value: string): SQL =>
  sql`btrim(regexp_replace(lower(${value}), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')`;

// A level's predicate for a non-reserved value: the slug as given, OR the same
// value run through the slug rule.
//
// The second arm is the pre-wave fallback (issue #215 verify). DESIGN-003's
// Brand chip wrote the brand's NAME into `?brand=`, and D-01 changed the param
// to hold a slug — so every link shared before this wave (`?brand=Drew Estate`,
// `?brand=Padrón`) would land on an empty grid. Folding the value resolves them,
// including the accented case: the stored slug never folds accents either, so
// `Padrón` → `padr-n` is exactly the row that link meant.
//
// It cannot widen a correct link, because the slug rule is idempotent: for a
// value that already IS a slug the second arm is the first one restated. That is
// what lets this be an unconditional OR rather than a second round trip.
const slugMatch = (column: SQL, value: string): SQL =>
  sql`(${column} = ${value} OR ${column} = ${slugFold(value)})`;

// The same match for a BRAND, plus the arm that keeps a RENAMED slug's old links
// alive. Migration 0029 renames `Padrón` from the transcription `padr-n` to the
// folded `padron`, and neither arm above can survive that: `padr-n` is lossy, so
// no normalization recovers `padron` from it. `/cigars/brands/padr-n` — a 307
// into `?brand=padr-n` — and every pre-wave `?brand=Padrón` link would land on an
// empty grid under a header naming nothing.
//
// What DOES survive the rename is the row's matching keys. `padr-n` stays in
// `brands.aliases` (0026 seeded it there, and after the rename it is no longer
// derived from the name, so it is an ordinary key the alias editor will keep).
// So the third arm probes `aliases` — with the STORED slug rule and never with
// `fold()`, exactly as above, which is what makes `?brand=Padrón` land too:
// slugFold("Padrón") is `padr-n`, the retained key.
//
// THE GUARD IS WHAT MAKES THIS SAFE, and it is why the first two arms could not
// simply be pointed at `aliases`. A row's aliases hold its FOLDED key as well as
// its transcription, so an unguarded alias probe for `padron-test` would match
// the accented `Padrón Test` in addition to the ASCII `Padron Test` that owns
// that slug outright — the widening this module has refused since #215, pinned
// by the negative test in catalog-hierarchy.test.ts. Firing the arm only when NO
// brand owns the value as a slug makes it a strict last resort: it can never add
// a marca to a result the slug arms already answered, so the only links it can
// change are the ones that currently resolve to nothing.
//
// Brand only, deliberately. Line and blend slugs are unique per PARENT, not
// globally, so a global alias arm there could pull two marcas' `reserva` into one
// drill. Nothing has renamed a line or blend slug; when something does, it will
// need the ancestor scope in the guard, and that is a change to make then.
const brandSlugMatch = (column: SQL, aliasColumn: SQL, value: string): SQL =>
  sql`(${slugMatch(column, value)} OR (
        (${value} = ANY(${aliasColumn}) OR ${slugFold(value)} = ANY(${aliasColumn}))
        AND NOT EXISTS (SELECT 1 FROM brands slug_owner WHERE ${slugMatch(sql`slug_owner.slug`, value)})
      ))`;

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
    conds.push(
      brand === HIERARCHY_UNFILED
        ? sql`c.brand_id IS NULL`
        : brandSlugMatch(sql`br.slug`, sql`br.aliases`, brand),
    );
  }
  if (line) {
    conds.push(line === HIERARCHY_UNFILED ? sql`c.line_id IS NULL` : slugMatch(sql`ln.slug`, line));
  }
  if (blend) {
    conds.push(
      blend === HIERARCHY_UNFILED ? sql`c.blend_id IS NULL` : slugMatch(sql`bl.slug`, blend),
    );
  }
  if (vitola) {
    // `VITOLA_SLUG IS NULL` rather than `nullif(btrim(c.vitola_name),'') IS NULL`:
    // the two differ only for a punctuation-only vitola name, and this form is
    // exactly "the group key is null" — so the Unfiled card's count always equals
    // the row count of the drill that card links to. The narrower form would let
    // a `"---"` row count on the card and vanish from the drill. Since the key
    // now also nulls a literal `unfiled`, that spelling lands in the same bucket
    // from both sides.
    conds.push(
      vitola === HIERARCHY_UNFILED ? sql`${VITOLA_SLUG} IS NULL` : slugMatch(VITOLA_SLUG, vitola),
    );
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
  // The immediate parent's SLUG. The card and the chip option both need it to
  // scope their own param — `lines.slug` is unique per brand, `blends.slug` per
  // line — so a root-level `Reserva` addresses one marca's line rather than
  // every marca's at once. Unlike `parent`, it is never suppressed for display
  // reasons: it is navigation.
  parentSlug: SQL | null;
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
        parentSlug: sql`min(lnbr.slug)`,
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
        parentSlug: sql`min(blln.slug)`,
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
        parentSlug: null,
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
        parentSlug: null,
        parentDimension: null,
        joins: sql``,
        keyed: sql`br.id IS NOT NULL`,
      };
  }
}

// ---- Entity resolution (DESIGN-004 D-04 / D-06) ---------------------------

export interface ResolvedHierarchyLevel {
  slug: string;
  name: string;
  // The registry row's id, for the callers that need to ask something ELSE about
  // the entity a slug named — today the drill header's DESIGN-006 score read.
  // Null for `unfiled`, which is the absence of a row rather than a row.
  id: string | null;
}

// One registry row behind a pinned slug, with everything two callers need: the
// drill header wants the name, the facet chip's union (D-06) wants the id and
// the parent so the option it inserts is indistinguishable from a counted one.
export interface HierarchyEntity extends ResolvedHierarchyLevel {
  id: string;
  parentSlug: string | null;
  parentName: string | null;
}

// The display names behind the pinned slugs, one entry per level that RESOLVED.
// A level absent here is a slug that matched no row — the caller falls back to
// rendering the raw slug rather than inventing a name.
export type ResolvedCatalogHierarchy = Partial<Record<CatalogDimension, ResolvedHierarchyLevel>>;

// The Unfiled pseudo-entity (D-05 / §Strings). It is a real drill target with no
// registry row behind it, so it resolves by construction rather than by lookup.
const UNFILED_LEVEL: ResolvedHierarchyLevel = { slug: HIERARCHY_UNFILED, name: "Unfiled", id: null };

// An ancestor pinned to `unfiled` scopes nothing — there is no registry row to
// scope by — so it is treated as absent for lookup purposes.
const scopeSlug = (slug: string | undefined): string | null =>
  slug != null && slug !== HIERARCHY_UNFILED ? slug : null;

interface EntityRow {
  id: string | null;
  slug: string | null;
  name: string | null;
  parent_slug: string | null;
  parent_name: string | null;
}

// Resolve ONE level's pinned slug to its row.
//
// DELIBERATELY NOT FACETED. No q/type/own/overlay filter and no `catalog_status`
// gate at the registry levels: it answers "what is this slug", a fact about the
// URL rather than about the current result set. A facet that empties the group
// must still leave the header naming the entity, and the chip's pill must still
// read `Vitola · Petit Corona` at a scope where the count is zero — otherwise
// narrowing a filter blanks the label and the user loses their place.
//
// Ancestors DO scope the lookup, because line and blend slugs are unique only
// within their parent (`lines_brand_id_slug_key`, `blends_line_id_slug_key`):
// `?brand=drew-estate&line=reserva` must resolve Drew Estate's Reserva, not some
// other brand's. With no ancestor pinned the slug can legitimately match several
// rows; the first by name wins, so the answer is at least deterministic.
export async function lookupHierarchyEntity(
  deps: Deps,
  dimension: CatalogDimension,
  slug: string,
  ancestors: CatalogHierarchyFilter = {},
): Promise<HierarchyEntity | null> {
  if (slug === HIERARCHY_UNFILED) return null;
  const brandScope = scopeSlug(ancestors.brand);
  const lineScope = scopeSlug(ancestors.line);

  let query: SQL;
  switch (dimension) {
    case "brand":
      query = sql`
        SELECT b.id::text AS id, b.slug AS slug, b.name AS name,
               NULL::text AS parent_slug, NULL::text AS parent_name
        FROM brands b
        WHERE ${brandSlugMatch(sql`b.slug`, sql`b.aliases`, slug)}
        ORDER BY b.name ASC
        LIMIT 1
      `;
      break;
    case "line":
      query = sql`
        SELECT ln.id::text AS id, ln.slug AS slug, ln.name AS name,
               b.slug AS parent_slug, b.name AS parent_name
        FROM lines ln
        LEFT JOIN brands b ON b.id = ln.brand_id
        WHERE ${slugMatch(sql`ln.slug`, slug)}
          ${brandScope != null ? sql`AND ${brandSlugMatch(sql`b.slug`, sql`b.aliases`, brandScope)}` : sql``}
        ORDER BY ln.name ASC
        LIMIT 1
      `;
      break;
    case "blend":
      query = sql`
        SELECT bl.id::text AS id, bl.slug AS slug, bl.name AS name,
               ln.slug AS parent_slug, ln.name AS parent_name
        FROM blends bl
        LEFT JOIN lines ln ON ln.id = bl.line_id
        LEFT JOIN brands b ON b.id = ln.brand_id
        WHERE ${slugMatch(sql`bl.slug`, slug)}
          ${lineScope != null ? sql`AND ${slugMatch(sql`ln.slug`, lineScope)}` : sql``}
          ${brandScope != null ? sql`AND ${brandSlugMatch(sql`b.slug`, sql`b.aliases`, brandScope)}` : sql``}
        ORDER BY bl.name ASC
        LIMIT 1
      `;
      break;
    default:
      // No registry row exists, so the identity IS the key and the display name
      // is a representative spelling off the leaves themselves — active ones
      // only, since an excluded row's spelling should not name a header. First by
      // name, for determinism.
      query = sql`
        SELECT ${VITOLA_SLUG} AS id, ${VITOLA_SLUG} AS slug,
               btrim(c.vitola_name) AS name,
               NULL::text AS parent_slug, NULL::text AS parent_name
        FROM cigars c
        WHERE c.catalog_status = 'active' AND ${slugMatch(VITOLA_SLUG, slug)}
        ORDER BY btrim(c.vitola_name) ASC
        LIMIT 1
      `;
      break;
  }

  const row = (await deps.db.execute(query)).rows[0] as EntityRow | undefined;
  if (row?.id == null || row.slug == null || row.name == null) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    parentSlug: row.parent_slug,
    parentName: row.parent_name,
  };
}

// Name the entities a drill header is about (D-04: "back label, the entity name,
// and its cigar count"), one lookup per pinned level.
export async function resolveCatalogHierarchy(
  deps: Deps,
  filter: CatalogHierarchyFilter,
): Promise<ResolvedCatalogHierarchy> {
  const resolved: ResolvedCatalogHierarchy = {};
  for (const dimension of ["brand", "line", "blend", "vitola"] as const) {
    const slug = filter[dimension];
    if (!slug) continue;
    if (slug === HIERARCHY_UNFILED) {
      resolved[dimension] = UNFILED_LEVEL;
      continue;
    }
    const entity = await lookupHierarchyEntity(deps, dimension, slug, filter);
    // The row's OWN slug, not the param: a pre-wave link carrying a brand name
    // resolves through the fold, and the canonical slug is the honest answer to
    // "what did I drill into".
    if (entity) resolved[dimension] = { slug: entity.slug, name: entity.name, id: entity.id };
  }
  return resolved;
}
