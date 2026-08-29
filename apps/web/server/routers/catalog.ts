import { z } from "zod";
import { browseBrands, getBrand, browseCatalog, CATALOG_SORTS } from "@cj/domain";
import { router, authedProcedure } from "../trpc";

// The exclusive ownership facet (PRD-003 R-UNI-2): the URL contract's `own`
// values map 1:1 to the domain OwnershipFacet. `all` is accepted and treated as
// no filter by the domain, so the toolbar can round-trip it.
const ownEnum = z.enum(["all", "have", "want", "dont"]);

// The poster library reads (PRD-002 phase 2 / PRD-003 R-UNI). `brand` and
// `browse` fold in the caller's personal overlay, so both are principal-scoped;
// `brands` is the catalog-wide shelf index, now also principal-scoped when an
// ownership facet is active. All are auth-gated at the procedure.
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
        q: z.string().optional(),
        // Exact brand match, case-insensitive (DESIGN-003 §IA `Brand` chip);
        // the domain lower/trim-compares it against `c.brand`.
        brand: z.string().optional(),
        type: z.enum(["NC", "CC"]).optional(),
        sort: z.enum(CATALOG_SORTS).optional(),
        own: ownEnum.optional(),
        // The independent, composable overlay booleans behind the grid's filter
        // chips (DESIGN-003 §IA): each ANDs with `own` and the others. The web
        // chips only ever assert the true side (present=on); the domain also
        // honours false for the MCP surface.
        inStock: z.boolean().optional(),
        smoked: z.boolean().optional(),
        favorited: z.boolean().optional(),
        cursor: z.string().nullish(),
        limit: z.number().optional(),
      }),
    )
    .query(({ ctx, input }) => browseCatalog(ctx.deps, ctx.principal, input)),
});
