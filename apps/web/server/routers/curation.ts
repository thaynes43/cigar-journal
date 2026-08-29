import { z } from "zod";
import {
  curationQueue,
  dismissDuplicate,
  mergeCigars,
  verifyCigar,
  setListingMatchStatus,
  excludeCigar,
  restoreCigar,
  setProductPhotoRights,
} from "@cj/domain";
import { router, adminProcedure } from "../trpc";

// Catalog curation (ADR-006, DESIGN-003 §Curation), curator-only. `adminProcedure`
// gates the surface; the domain services re-check the role. The mutations carry
// the ADR-003 mutation envelope (clientRequestId) so a double-submit is idempotent.
export const curationRouter = router({
  queue: adminProcedure.query(({ ctx }) => curationQueue(ctx.deps, ctx.principal)),

  merge: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        sourceCigarId: z.string().uuid(),
        targetCigarId: z.string().uuid(),
      }),
    )
    .mutation(({ ctx, input }) => mergeCigars(ctx.deps, ctx.principal, input)),

  verify: adminProcedure
    .input(z.object({ clientRequestId: z.string(), cigarId: z.string().uuid() }))
    .mutation(({ ctx, input }) => verifyCigar(ctx.deps, ctx.principal, input)),

  dismiss: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        cigarAId: z.string().uuid(),
        cigarBId: z.string().uuid(),
      }),
    )
    .mutation(({ ctx, input }) => dismissDuplicate(ctx.deps, ctx.principal, input)),

  // Confirm or unmatch a vendor listing→cigar link (DESIGN-003 §Curation). The
  // API both a curator and the curate agent call.
  setListingMatchStatus: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        matchId: z.string().uuid(),
        status: z.enum(["confirmed", "unmatched"]),
      }),
    )
    .mutation(({ ctx, input }) => setListingMatchStatus(ctx.deps, ctx.principal, input)),

  // Hide a catalog Cigar from browse/search/queue without deleting it (non-cigar
  // pollution, or an entry to hide) and undo that (DESIGN-003 §Curation).
  excludeCigar: adminProcedure
    .input(z.object({ clientRequestId: z.string(), cigarId: z.string().uuid() }))
    .mutation(({ ctx, input }) => excludeCigar(ctx.deps, ctx.principal, input)),

  restoreCigar: adminProcedure
    .input(z.object({ clientRequestId: z.string(), cigarId: z.string().uuid() }))
    .mutation(({ ctx, input }) => restoreCigar(ctx.deps, ctx.principal, input)),

  // Approve or suppress (take down) a cigar's product photo (DESIGN-003 §Curation
  // "Fix the rights bug first").
  setPhotoRights: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        cigarId: z.string().uuid(),
        rights: z.enum(["pending", "approved", "suppressed"]),
      }),
    )
    .mutation(({ ctx, input }) => setProductPhotoRights(ctx.deps, ctx.principal, input)),
});
