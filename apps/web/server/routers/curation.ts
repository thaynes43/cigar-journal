import { z } from "zod";
import {
  curationQueue,
  cigarsMissingPhotos,
  dismissDuplicate,
  mergeCigars,
  unmergeCigars,
  recentMerges,
  verifyCigar,
  setListingMatchStatus,
  excludeCigar,
  restoreCigar,
  setProductPhotoRights,
  renameCigar,
  queueEnrichmentBacklog,
  ENRICHMENT_BACKLOG_MAX,
  agentRuns,
  agentRunRows,
  undoCurationAction,
  getProductPhotoState,
  mintProductPhotoUploadToken,
  brandImageQueue,
  setBrandImageRights,
  chooseBrandImageCandidate,
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

  // Reverse a merge from its `cigar_merges` ledger (#45), and the console's
  // history of merges to reverse. A merge audit is actor 'web', so the pair can
  // never appear under "Recent agent runs" — this section is where it lives.
  recentMerges: adminProcedure.query(({ ctx }) => recentMerges(ctx.deps, ctx.principal)),

  unmerge: adminProcedure
    .input(z.object({ clientRequestId: z.string(), mergeId: z.string().uuid() }))
    .mutation(({ ctx, input }) => unmergeCigars(ctx.deps, ctx.principal, input)),

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

  // Brand imagery (issue 127): the Wikidata/Commons wall covers awaiting a pick
  // or a rights decision. `chooseBrandImage` RECORDS a curator's pick only — the
  // bytes arrive on the next crawl-pod run, the web never fetches Wikimedia.
  brandImages: adminProcedure.query(({ ctx }) => brandImageQueue(ctx.deps, ctx.principal)),

  setBrandImageRights: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        brandSlug: z.string(),
        rights: z.enum(["pending", "approved", "suppressed"]),
      }),
    )
    .mutation(({ ctx, input }) => setBrandImageRights(ctx.deps, ctx.principal, input)),

  chooseBrandImage: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        brandSlug: z.string(),
        qid: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => chooseBrandImageCandidate(ctx.deps, ctx.principal, input)),

  // Set a cigar's canonical name (#45) — the one authorized identity edit.
  rename: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        cigarId: z.string().uuid(),
        canonicalName: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => renameCigar(ctx.deps, ctx.principal, input)),

  // Bulk-enqueue the "Missing photos" worklist for the crawler's enrich runs
  // (#154) — the operator kickstart for the same list the section renders. The
  // curate agent presses the identical service through its MCP tool.
  queueEnrichmentBacklog: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        limit: z.number().int().min(1).max(ENRICHMENT_BACKLOG_MAX).optional(),
        retryExhausted: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => queueEnrichmentBacklog(ctx.deps, ctx.principal, input)),

  // Recent agent runs (DESIGN-003 §Curation review console, #126): the runs list
  // grouped from the audit log by run_id, and a run's expandable rows.
  agentRuns: adminProcedure.query(({ ctx }) => agentRuns(ctx.deps, ctx.principal)),

  agentRunRows: adminProcedure
    .input(
      z.object({
        runId: z.string(),
        cursor: z.string().nullish(),
        limit: z.number().int().optional(),
      }),
    )
    .query(({ ctx, input }) => agentRunRows(ctx.deps, ctx.principal, input)),

  // Undo one agent action by its inverse (exclude→restore, listing/photo/facts→prior
  // value, verify→unverify, rename→prior name, merge→the full unmerge), linked
  // through the audit `reverts` self-link.
  undo: adminProcedure
    .input(z.object({ clientRequestId: z.string(), auditId: z.string().uuid() }))
    .mutation(({ ctx, input }) => undoCurationAction(ctx.deps, ctx.principal, input)),
});
