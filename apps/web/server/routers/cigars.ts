import { z } from "zod";
import { searchCigars, getCigar } from "@cj/domain";
import { router, authedProcedure } from "../trpc";

// Catalog reads. Both are scoped to the caller because their results fold in the
// caller's own history (per-match smoke count; the Personal Profile on detail).
export const cigarsRouter = router({
  search: authedProcedure
    .input(z.object({ query: z.string(), limit: z.number().optional() }))
    .query(({ ctx, input }) => searchCigars(ctx.deps, ctx.principal, input)),

  get: authedProcedure
    .input(z.object({ cigarId: z.string() }))
    .query(({ ctx, input }) => getCigar(ctx.deps, ctx.principal, input)),
});
