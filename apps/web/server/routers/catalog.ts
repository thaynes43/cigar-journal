import { z } from "zod";
import {
  browseBrands,
  getBrand,
  browseCatalog,
  browseCatalogGroups,
  catalogFacetOptions,
  resolveCatalogHierarchy,
  getSurfaceScores,
  CATALOG_SORTS,
  CATALOG_DIMENSIONS,
} from "@cj/domain";
import { router, authedProcedure } from "../trpc";

// The exclusive ownership facet (PRD-003 R-UNI-2): the URL contract's `own`
// values map 1:1 to the domain OwnershipFacet. `all` is accepted and treated as
// no filter by the domain, so the toolbar can round-trip it.
const ownEnum = z.enum(["all", "have", "want", "dont"]);

// The four hierarchy levels (DESIGN-004 D-01/D-09), each holding ONE slug — the
// same param a drill writes and a chip writes, because they are one mechanism
// with two entrances. The reserved value `unfiled` means IS NULL at that level
// (D-05); the domain owns that meaning, so nothing here enumerates slugs. An
// unknown slug is a legitimately EMPTY scope, not a validation error: a drill
// into a group that was renamed away must show nothing rather than 400.
const hierarchyInput = z
  .object({
    brand: z.string().optional(),
    line: z.string().optional(),
    blend: z.string().optional(),
    vitola: z.string().optional(),
  })
  .optional();

const sortDirEnum = z.enum(["asc", "desc"]);

// Every leaf filter, shared by the grid, the grouped views and the chip options
// — D-06's counts are only honest if all three apply the same set.
const leafFilters = {
  q: z.string().optional(),
  // Exact brand match, case-insensitive (DESIGN-003 §IA `Brand` chip); the
  // domain lower/trim-compares it against the free-text `c.brand`. Distinct from
  // `hierarchy.brand`, which is the structural registry slug.
  brand: z.string().optional(),
  hierarchy: hierarchyInput,
  type: z.enum(["NC", "CC"]).optional(),
  own: ownEnum.optional(),
  // The independent, composable overlay booleans behind the grid's filter chips
  // (DESIGN-003 §IA): each ANDs with `own` and the others. The web chips only
  // ever assert the true side (present=on); the domain also honours false for
  // the MCP surface.
  inStock: z.boolean().optional(),
  smoked: z.boolean().optional(),
  favorited: z.boolean().optional(),
};

// The poster library reads (PRD-002 phase 2 / PRD-003 R-UNI, DESIGN-004). All of
// `brand`, `browse`, `groups` and `facetOptions` fold in the caller's personal
// overlay, so all are principal-scoped; `brands` is the catalog-wide shelf index,
// also principal-scoped when an ownership facet is active. All are auth-gated at
// the procedure.
export const catalogRouter = router({
  brands: authedProcedure
    .input(z.object({ own: ownEnum.optional(), type: z.enum(["NC", "CC"]).optional() }).optional())
    .query(({ ctx, input }) => browseBrands(ctx.deps, ctx.principal, input ?? {})),

  brand: authedProcedure
    .input(z.object({ slug: z.string() }))
    .query(({ ctx, input }) => getBrand(ctx.deps, ctx.principal, input)),

  browse: authedProcedure
    .input(
      z.object({
        ...leafFilters,
        sort: z.enum(CATALOG_SORTS).optional(),
        // DESIGN-004 D-04: the `field:dir` token's second half. Omitted, the
        // domain picks the key's default direction.
        sortDir: sortDirEnum.optional(),
        cursor: z.string().nullish(),
        limit: z.number().optional(),
      }),
    )
    .query(({ ctx, input }) => browseCatalog(ctx.deps, ctx.principal, input)),

  // A grouped view (D-03): the leaf grid is REPLACED by one grid of aggregate
  // group cards, under exactly the filters the grid would apply.
  groups: authedProcedure
    .input(
      z.object({
        ...leafFilters,
        by: z.enum(CATALOG_DIMENSIONS),
        // Group cards sort by their own two facts, not the leaf set (D-04).
        groupSort: z
          .object({ field: z.enum(["name", "count"]), dir: sortDirEnum })
          .optional(),
      }),
    )
    .query(({ ctx, input }) => browseCatalogGroups(ctx.deps, ctx.principal, input)),

  // One hierarchy chip's options with their counts (D-06). Counts are computed
  // against the OTHER active facets — the domain drops this dimension's own
  // value — so each number answers "what would I get if I picked this". An empty
  // `options` array is the signal the chip hides at this scope.
  facetOptions: authedProcedure
    .input(
      z.object({
        ...leafFilters,
        dimension: z.enum(CATALOG_DIMENSIONS),
        limit: z.number().optional(),
      }),
    )
    .query(({ ctx, input }) => catalogFacetOptions(ctx.deps, ctx.principal, input)),

  // The two labelled aggregates for the entities a surface is about to render
  // (ADR-013 §3, DESIGN-006) — today the drill header, which asks about the ONE
  // entity it names. Group cards get theirs inside `groups`, and the leaf page
  // gets its own (own-else-blend) inside `cigars.get`; this is the level-scoped
  // case neither of those covers.
  //
  // Principal-scoped: the journal aggregate's population is public journals plus
  // the caller's own (DESIGN-006 rule 1), so this is not a cacheable catalog read.
  scores: authedProcedure
    .input(
      z.object({
        level: z.enum(["cigar", "blend", "line", "brand"]),
        ids: z.array(z.string()).max(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const map = await getSurfaceScores(ctx.deps.db, input.level, input.ids, {
        userId: ctx.principal.userId,
      });
      // A Map does not survive the wire; the object keeps the caller's own ids.
      return Object.fromEntries(map);
    }),

  // The names behind the pinned slugs, for the drill header (D-04). Deliberately
  // unfaceted: it answers "what did I drill into", a fact about the URL, so
  // narrowing a filter until the group is empty never blanks the header.
  resolveHierarchy: authedProcedure
    .input(z.object({ hierarchy: hierarchyInput }))
    .query(({ ctx, input }) => resolveCatalogHierarchy(ctx.deps, input.hierarchy ?? {})),
});
