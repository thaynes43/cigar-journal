import { z } from "zod";
import {
  saveSmoke,
  updateSmoke,
  deleteSmoke,
  getSmoke,
  queryMySmokes,
  getPublicSmoke,
  queryPublicSmokes,
  publicJournalExists,
} from "@cj/domain";
import { router, authedProcedure, publicProcedure } from "../trpc";
import {
  saveSmokeSchema,
  updateSmokeSchema,
  queryMySmokesSchema,
  queryPublicSmokesSchema,
} from "../schemas";

// The journal aggregate's CRUD surface. Provenance is stamped server-side as
// `manual` — the web is the manual writer (ADR-002); a client can't spoof it.
export const smokesRouter = router({
  // Non-optional input (every field within is optional) so the journal's
  // useInfiniteQuery can thread its keyset `cursor` through this procedure.
  list: authedProcedure
    .input(queryMySmokesSchema)
    .query(({ ctx, input }) => queryMySmokes(ctx.deps, ctx.principal, input)),

  // `.uuid()` matters beyond hygiene: the id reaches a uuid column, so a
  // non-UUID string would raise Postgres 22P02 — an untyped error that escapes
  // the NOT_FOUND path and surfaces as a 500 on a public URL. Rejecting it here
  // keeps a malformed id a 404 (see the detail page's catch).
  get: authedProcedure
    .input(z.object({ smokeId: z.string().uuid() }))
    .query(({ ctx, input }) => getSmoke(ctx.deps, ctx.principal, input)),

  // Anonymous public-journal reads (PRD-001 R7, ADR-004; issue #96). Public
  // procedures — the visibility filter in the domain read is the authorization,
  // so a private or nonexistent smoke both surface as NOT_FOUND (no leak).
  getPublic: publicProcedure
    .input(z.object({ smokeId: z.string().uuid() }))
    .query(({ ctx, input }) => getPublicSmoke(ctx.deps, input)),

  listPublic: publicProcedure
    .input(queryPublicSmokesSchema)
    .query(({ ctx, input }) => queryPublicSmokes(ctx.deps, input)),

  publicJournalExists: publicProcedure.query(({ ctx }) => publicJournalExists(ctx.deps)),

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
