import { z } from "zod";
import {
  curationQueue,
  cigarsMissingPhotos,
  dismissDuplicate,
  mergeCigars,
  verifyCigar,
  setListingMatchStatus,
  excludeCigar,
  restoreCigar,
  setProductPhotoRights,
  getProductPhotoState,
  mintProductPhotoUploadToken,
} from "@cj/domain";
import { router, adminProcedure } from "../trpc";

// Catalog curation (ADR-006, DESIGN-003 §Curation), curator-only. `adminProcedure`
// gates the surface; the domain services re-check the role. The mutations carry
// the ADR-003 mutation envelope (clientRequestId) so a double-submit is idempotent.
export const curationRouter = router({
  queue: adminProcedure.query(({ ctx }) => curationQueue(ctx.deps, ctx.principal)),

  // The "Missing photos" worklist (DESIGN-003 §Images): the curator's held cigars
  // with no servable product photo — each links its detail page to upload one.
  missingPhotos: adminProcedure.query(({ ctx }) => cigarsMissingPhotos(ctx.deps, ctx.principal)),

  // The current product-photo rights for one cigar (or null), driving the detail-
  // page admin control's initial state. Admin-only.
  photoState: adminProcedure
    .input(z.object({ cigarId: z.string().uuid() }))
    .query(({ ctx, input }) => getProductPhotoState(ctx.deps, ctx.principal, input)),

  // Mint a single-use product-photo upload link for a cigar (DESIGN-003 §Images).
  // The curator opens it on a phone to attach the photo; the raw token is returned
  // once (never re-derivable) and the client builds the absolute /u/<token> URL.
  mintPhotoUploadLink: adminProcedure
    .input(z.object({ cigarId: z.string().uuid() }))
    .mutation(({ ctx, input }) => mintProductPhotoUploadToken(ctx.deps, ctx.principal, input)),

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
