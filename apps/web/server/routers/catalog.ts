import { z } from "zod";
import { browseBrands, getBrand, browseCatalog, CATALOG_SORTS } from "@cj/domain";
import { router, authedProcedure } from "../trpc";

// The poster library reads (PRD-002 phase 2). `brand` and `browse` fold in the
// caller's personal overlay, so both are principal-scoped; `brands` is the
// catalog-wide shelf index. All are auth-gated at the procedure.
export const catalogRouter = router({
  brands: authedProcedure.query(({ ctx }) => browseBrands(ctx.deps)),

  brand: authedProcedure
    .input(z.object({ slug: z.string() }))
    .query(({ ctx, input }) => getBrand(ctx.deps, ctx.principal, input)),

  browse: authedProcedure
    .input(
      z.object({
        q: z.string().optional(),
        type: z.enum(["NC", "CC"]).optional(),
        sort: z.enum(CATALOG_SORTS).optional(),
        cursor: z.string().nullish(),
        limit: z.number().optional(),
      }),
    )
    .query(({ ctx, input }) => browseCatalog(ctx.deps, ctx.principal, input)),
});
