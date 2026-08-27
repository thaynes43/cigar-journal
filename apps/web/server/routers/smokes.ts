import { z } from "zod";
import { saveSmoke, updateSmoke, deleteSmoke, getSmoke, queryMySmokes } from "@cj/domain";
import { router, authedProcedure } from "../trpc";
import { saveSmokeSchema, updateSmokeSchema, queryMySmokesSchema } from "../schemas";

// The journal aggregate's CRUD surface. Provenance is stamped server-side as
// `manual` — the web is the manual writer (ADR-002); a client can't spoof it.
export const smokesRouter = router({
  list: authedProcedure
    .input(queryMySmokesSchema.optional())
    .query(({ ctx, input }) => queryMySmokes(ctx.deps, ctx.principal, input ?? {})),

  get: authedProcedure
    .input(z.object({ smokeId: z.string() }))
    .query(({ ctx, input }) => getSmoke(ctx.deps, ctx.principal, input)),

  save: authedProcedure
    .input(saveSmokeSchema)
    .mutation(({ ctx, input }) => saveSmoke(ctx.deps, ctx.principal, { ...input, provenance: { source: "manual" } })),

  update: authedProcedure
    .input(updateSmokeSchema)
    .mutation(({ ctx, input }) => updateSmoke(ctx.deps, ctx.principal, { ...input, provenance: { source: "manual" } })),

  delete: authedProcedure
    .input(z.object({ smokeId: z.string() }))
    .mutation(({ ctx, input }) => deleteSmoke(ctx.deps, ctx.principal, { smokeId: input.smokeId })),
});
