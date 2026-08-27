import { z } from "zod";
import { searchCigars, getCigar, browseCigars } from "@cj/domain";
import { router, authedProcedure } from "../trpc";

// Catalog reads. `search` and `get` are scoped to the caller because their
// results fold in the caller's own history (per-match smoke count; the Personal
// Profile on detail). `browse` is catalog-only — auth-gated but principal-free.
export const cigarsRouter = router({
  browse: authedProcedure.query(({ ctx }) => browseCigars(ctx.deps)),

  search: authedProcedure
    .input(z.object({ query: z.string(), limit: z.number().optional() }))
    .query(({ ctx, input }) => searchCigars(ctx.deps, ctx.principal, input)),

  get: authedProcedure
    .input(z.object({ cigarId: z.string() }))
    .query(({ ctx, input }) => getCigar(ctx.deps, ctx.principal, input)),
});
