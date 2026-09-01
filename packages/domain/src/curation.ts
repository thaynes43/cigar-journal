import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import {
  auditLog,
  cigars,
  cigarMerges,
  duplicateDismissals,
  smokes,
  purchases,
  listingMatches,
  offers,
  reviewObservations,
  productPhotos,
  enrichmentRequests,
  wants,
  favorites,
  type CigarRow,
  type CigarMergeRow,
  type CigarMergeLedgerV1,
  type CigarMergeDroppedMark,
  type ListingMatchRow,
  type ProductPhotoRow,
  type NewCigarRow,
  type Database,
} from "@cj/db";
import type { CigarNameSource, SuggestedParse } from "@cj/db";
import type { Deps, Principal, Queryer, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import { assertCigarAncestry } from "./cigar-ancestry.js";
import { deriveBrandId, loadAncestryContext } from "./taxonomy-resolve.js";
import { recomposeCigarName } from "./taxonomy-writes.js";
import type {
  MergeCigarsInput,
  MergeCigarsResult,
  UnmergeCigarsInput,
  UnmergeCigarsResult,
  UnmergeSkip,
  RecentMerge,
  RecentMergesResult,
  VerifyCigarInput,
  VerifyCigarResult,
  DismissDuplicateInput,
  DismissDuplicateResult,
  CurationQueueResult,
  CurationQueueCigar,
  SetListingMatchStatusInput,
  SetListingMatchStatusResult,
  SetCatalogStatusInput,
  SetCatalogStatusResult,
  SetProductPhotoRightsInput,
  SetProductPhotoRightsResult,
  SetCigarFactsInput,
  SetCigarFactsResult,
  RenameCigarInput,
  RenameCigarResult,
  UndoCurationActionInput,
  UndoCurationActionResult,
  AgentRunsResult,
  AgentRunSummary,
  AgentRunActionCount,
  AgentRunRowsInput,
  AgentRunRowsResult,
  AgentRunRow,
  CatalogStatus,
  ProductPhotoRights,
  ListingMatchStatus,
  Verification,
  CurationAttribution,
  CurationWorklistInput,
  CurationWorklistResult,
  WorklistCigar,
  WorklistMatch,
  DuplicateCandidatePair,
  MissingPhotoCigar,
  QueueEnrichmentBacklogInput,
  QueueEnrichmentBacklogResult,
  EnrichmentBacklogEntry,
  EnrichmentBacklogStatus,
  CigarType,
} from "./types.js";
import { fingerprint } from "./fingerprint.js";
import { strongLinkCompatible } from "./cigar-resolution.js";
import { classifyEnrichmentRequest, type EnrichmentClassification } from "./enrichment.js";
import { liveEnrichMarkets } from "./enrichment-coverage.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { CigarNotFoundError, PhotoNotFoundError, UnauthorizedError, ValidationError } from "./errors.js";
import { isUuid } from "./uuid.js";

// Catalog hygiene — the curator's toolkit (ADR-006). Merge re-points every
// reference off a duplicate and tombstones it (recording what moved, so unmerge
// can put it back); verify flips the lifecycle flag; the queue surfaces the
// unverified backlog and near-duplicate candidates. All three
// are curator-only: verification and duplicate-merge are curator-only per ADR-006
// and the DDD contexts doc, and the queue reveals the whole catalog's hygiene
// state, so it is gated too. Mutations audit in-transaction and are idempotent
// through the ADR-003 envelope (house pattern, mirrors save/update).

// Trigram similarity at or above this counts two canonical names as a
// near-duplicate candidate — the same STRONG_MATCH bar cigar-resolution links
// at, so the queue surfaces exactly the pairs the resolver would have hesitated
// over. The `%` operator prefilters against the GIN index; this threshold decides.
const DUPLICATE_THRESHOLD = 0.6;

// Caps so an admin page over a large seeded catalog (a vendor crawl can land
// ~1,900 rows) stays a bounded read. Oldest/most-similar first, so the highest-
// priority hygiene work is always in view.
const DUPLICATE_PAIR_CAP = 50;
const UNVERIFIED_CAP = 200;
// The photoless-holdings worklist is bounded like the other admin reads; the
// owner's real gap (the 46 CC humidor + a handful of NC) sits well under this.
const MISSING_PHOTOS_CAP = 500;

// "1 purchase lot" / "3 purchase lots". A refusal that names what it counted lets a
// curator act on it; one that only says "held" sends them to psql.
function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function assertCurator(principal: Principal): void {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Curation is restricted to catalog curators.");
  }
}

// Resolve the audit attribution for a curation write. Absent (the web console) →
// actor `web`, runId/confidence null: the historical behaviour, unchanged. The
// admin MCP curation surface (the ops agent) passes actor `agent` + the batch
// runId + confidence, so "Recent agent runs" can group and score the write. Actor
// is always server-derived from the calling surface — never a tool argument.
//
// `clientId` comes off the PRINCIPAL (migration 0024, ADR-011), so it is
// server-derived twice over: `validateAccessToken` reads it from the token row,
// and no tool argument can reach it. It is what makes an operator-minted
// curation token attributable: without it every credential a subject holds
// writes identical history, and a leaked curation token walking
// `set_listing_match_status` across the triage queue would be indistinguishable
// afterwards from the daily lane doing its job. A session-driven web call has no
// client and stays null.
//
// Curation keeps its own wrapper because it carries two columns nothing else
// does (runId/confidence, the "Recent agent runs" grouping). The actor+client
// half delegates to the shared `auditActor` every other audit insert now spreads
// (#183), so there is one rule and not two that can drift.
function auditAttribution(
  principal: Principal,
  attribution: CurationAttribution | undefined,
): {
  actor: "web" | "agent";
  runId: string | null;
  confidence: number | null;
  clientId: string | null;
} {
  const actor = attribution?.actor ?? "web";
  return {
    ...auditActor(principal, actor),
    actor, // re-stated only to narrow "web" | "agent" out of the helper's wider actor union
    runId: attribution?.runId ?? null,
    confidence: attribution?.confidence ?? null,
  };
}

// JSON-safe audit snapshot of a catalog row — dates as ISO strings. Carries the
// lifecycle columns (catalogStatus/mergedInto) so exclude/restore/merge audits
// record the before/after state a future Undo reads.
function cigarSnapshot(row: CigarRow): Record<string, unknown> {
  return {
    id: row.id,
    canonicalName: row.canonicalName,
    brand: row.brand,
    line: row.line,
    edition: row.edition,
    vitolaName: row.vitolaName,
    type: row.type,
    manufacturer: row.manufacturer,
    verification: row.verification,
    catalogStatus: row.catalogStatus,
    mergedInto: row.mergedInto,
    createdAt: row.createdAt.toISOString(),
  };
}

// JSON-safe audit snapshot of a listing match — the mutable link a curator/agent
// confirms or unmatches.
//
// EVERY MUTABLE FIELD ANY WRITER TOUCHES, not just the ones one writer touches.
// `setListingMatchStatus` only moves `status`/`cigarId`/`decidedBy`, so the
// narrower snapshot was enough for it — but `splitCigar` also clears
// `unmatched_reason` and `suggested_parse` on the rows it re-points, and a
// snapshot that omits them makes the undo a partial inverse: the listing goes
// home to the bucket with the resolver's account of why it was unresolved
// destroyed, and the next split of that same bucket runs against evidence that
// no longer exists. The rule is that this shape is the row's restorable state,
// which keeps a future writer of a new field honest by construction.
//
// Exported for `splitCigar`, which audits its re-points under this same action so
// the console's existing Undo inverts them. Shared rather than copied: a second
// copy is a second answer to "what does undo restore?", and the two would agree
// only until one of them was extended.
export function listingMatchSnapshot(row: ListingMatchRow): Record<string, unknown> {
  return {
    id: row.id,
    vendorId: row.vendorId,
    listingKey: row.listingKey,
    cigarId: row.cigarId,
    status: row.status,
    decidedBy: row.decidedBy,
    unmatchedReason: row.unmatchedReason,
    suggestedParse: row.suggestedParse,
  };
}

// JSON-safe audit snapshot of a product photo — enough to identify the row and
// record the rights transition, without the storage keys.
function productPhotoSnapshot(row: ProductPhotoRow): Record<string, unknown> {
  return {
    id: row.id,
    cigarId: row.cigarId,
    vendorId: row.vendorId,
    sourceUrl: row.sourceUrl,
    rights: row.rights,
  };
}

// The two loaders below are where every curation entry point meets its id, and
// both already express "no such row" as undefined — so a malformed id is answered
// by returning undefined, and each caller converts that into its own established
// refusal (CigarNotFoundError, or the field-pathed ValidationError for a match)
// without knowing the guard exists. That is why the check sits here rather than at
// the dozen entry points: one place to be right, and no entry point can be added
// later that forgets it. Every caller runs inside a transaction, so refusing
// before the query also keeps a 22P02 from aborting it (#206, ./uuid.ts).
async function loadCigar(tx: Queryer, cigarId: string): Promise<CigarRow | undefined> {
  if (!isUuid(cigarId)) return undefined;
  const rows = await tx.select().from(cigars).where(eq(cigars.id, cigarId)).limit(1);
  return rows[0];
}

async function loadListingMatch(tx: Queryer, matchId: string): Promise<ListingMatchRow | undefined> {
  if (!isUuid(matchId)) return undefined;
  const rows = await tx.select().from(listingMatches).where(eq(listingMatches.id, matchId)).limit(1);
  return rows[0];
}

// --------------------------------------------------------------------------
// mergeCigars — fold a duplicate into the surviving entry (curator-only).
// --------------------------------------------------------------------------

// Every table whose `cigar_id` a merge moves, one ledger slot each (migration
// 0020). The merge records the ids it re-points under these keys and the unmerge
// restores them table by table, so the two ends can never name different sets.
// A drift test pins this key set against every `cigar_id` column in the schema —
// a new referencing table fails the suite instead of silently escaping the ledger.
//
// Deliberately absent, and why:
//   smoke_consumptions  — no cigar_id at all; it links smoke→purchase and derives
//                         user and cigar through the smoke, so nothing to re-point.
//   duplicate_dismissals— cascade-only; the pair verdict survives on the tombstone.
//   photo_upload_tokens — short-lived and single-use; a merge outlives them.
export const MERGE_LEDGER_TABLES = [
  { key: "smokes", table: "smokes" },
  { key: "purchases", table: "purchases" },
  { key: "listingMatches", table: "listing_matches" },
  { key: "offers", table: "offers" },
  { key: "reviewObservations", table: "review_observations" },
  { key: "enrichmentRequests", table: "enrichment_requests" },
  { key: "productPhotos", table: "product_photos" },
  { key: "wants", table: "wants" },
  { key: "favorites", table: "favorites" },
] as const;

// A want/favorite row the merge's de-dupe DELETE removed, captured whole so the
// restore can re-create its identity (same id, note, created_at) rather than a
// look-alike.
function droppedMark(row: {
  id: string;
  userId: string;
  note: string | null;
  createdAt: Date;
}): CigarMergeDroppedMark {
  return { id: row.id, userId: row.userId, note: row.note, createdAt: row.createdAt.toISOString() };
}

export async function mergeCigars(
  deps: Deps,
  principal: Principal,
  input: MergeCigarsInput,
): Promise<MergeCigarsResult> {
  assertCurator(principal);
  if (input.sourceCigarId === input.targetCigarId) {
    throw new ValidationError([{ path: "targetCigarId", message: "Source and target must differ." }]);
  }
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => mergeWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    // Concurrent first-writer committed the key between our check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as MergeCigarsResult), replayed: true };
      }
    }
    throw error;
  }
}

async function mergeWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: MergeCigarsInput,
  requestFingerprint: string,
): Promise<MergeCigarsResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as MergeCigarsResult), replayed: true };
  }

  // Cigars carry no version column; existence + distinct-id are the safety net,
  // and the whole re-point + delete runs in one transaction so a concurrent
  // merge that removed either row loses the FK re-point atomically.
  const source = await loadCigar(tx, input.sourceCigarId);
  const target = await loadCigar(tx, input.targetCigarId);
  if (!source || !target) throw new CigarNotFoundError();
  // Neither side may already be a tombstone — both guards keep every ledger's
  // referent valid. Re-merging a tombstone elsewhere would strand the first
  // ledger (its rows would no longer be on the cigar it recorded), and merging
  // INTO a tombstone would pile references onto a hidden row. Chains still form
  // as survivors are merged later (A→B, then B→C, then C→D); unmerge handles
  // those LIFO, newest first.
  if (source.catalogStatus === "merged") {
    throw new ValidationError([
      { path: "sourceCigarId", message: "This cigar is already merged; unmerge it first." },
    ]);
  }
  if (target.catalogStatus === "merged") {
    throw new ValidationError([{ path: "targetCigarId", message: "Merge into the surviving cigar instead." }]);
  }
  // ...and the survivor must be VISIBLE, not merely un-tombstoned (#169). Merging a
  // held source into an EXCLUDED target re-points the source's purchase lots onto a
  // row that no catalog read returns — the same silent inventory loss the exclude
  // guard below refuses, reached through a different door. The console cannot pose
  // this call (its duplicate-pair query requires both sides active), but the tRPC
  // route takes arbitrary ids. Written as `!== "active"` rather than
  // `=== "excluded"` so a lifecycle value added later is refused by default instead
  // of silently admitted.
  if (target.catalogStatus !== "active") {
    throw new ValidationError([{ path: "targetCigarId", message: "Merge into an active cigar instead." }]);
  }

  const before = { source: cigarSnapshot(source), target: cigarSnapshot(target) };

  // Re-point the owned references (Smokes, Purchases, Listing Matches — ADR-006).
  const smokeRows = await tx
    .update(smokes)
    .set({ cigarId: target.id })
    .where(eq(smokes.cigarId, source.id))
    .returning({ id: smokes.id });
  const purchaseRows = await tx
    .update(purchases)
    .set({ cigarId: target.id })
    .where(eq(purchases.cigarId, source.id))
    .returning({ id: purchases.id });
  const listingRows = await tx
    .update(listingMatches)
    .set({ cigarId: target.id })
    .where(eq(listingMatches.cigarId, source.id))
    .returning({ id: listingMatches.id });

  // Product photo: at most one per cigar (unique constraint). The target keeps
  // its own when it has one; otherwise it adopts the source's. When the target
  // already has a photo the source keeps its own — the source is now a tombstone
  // (no longer deleted, see below), so its photo simply stays on the hidden row.
  const targetPhoto = await tx
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, target.id))
    .limit(1);
  const sourcePhoto = await tx
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, source.id))
    .limit(1);
  const movedPhotoIds: string[] = [];
  if (sourcePhoto[0] && !targetPhoto[0]) {
    await tx.update(productPhotos).set({ cigarId: target.id }).where(eq(productPhotos.cigarId, source.id));
    movedPhotoIds.push(sourcePhoto[0].id);
  }

  // Enrichment requests re-point too, so an open gap-fill for the duplicate keeps
  // working against the survivor (no unique constraint, so duplicates are benign).
  const enrichmentRows = await tx
    .update(enrichmentRequests)
    .set({ cigarId: target.id })
    .where(eq(enrichmentRequests.cigarId, source.id))
    .returning({ id: enrichmentRequests.id });

  // Ad-hoc price observations (record_price, ADR-009) link the cigar directly via
  // offers.cigar_id — re-point them so the merge keeps that price history instead
  // of letting the cigar-delete cascade (offers.cigar_id ON DELETE CASCADE) drop
  // it. Crawler offers carry a null cigar_id (they reach the cigar through the
  // already-re-pointed listing match), so this touches only the chat observations.
  const offerRows = await tx
    .update(offers)
    .set({ cigarId: target.id })
    .where(eq(offers.cigarId, source.id))
    .returning({ id: offers.id });

  // External review scores (ADR-013) re-point too. A review observation is
  // externally-sourced evidence ABOUT THE PRODUCT, and a merge asserts the two
  // rows are the same product — so the evidence belongs to the survivor. Leaving
  // it on the source would make it vanish from every aggregate: the source is now
  // a catalog_status='merged' tombstone, and the ADR-013 aggregate views resolve
  // ancestry only through active cigars (`cigar_ancestry`, migration 0028, filters
  // catalog_status = 'active'). That is silent loss of evidence a re-crawl would
  // have to buy back.
  //
  // Only cigar-linked observations carry a non-null cigar_id; a BLEND-linked one
  // (the reviewer scored the blend at large) is untouched by a cigar merge and
  // must stay exactly as it is — its target did not move.
  //
  // No de-dupe step and no restore guard, deliberately: unlike wants/favorites,
  // `review_observations` has no UNIQUE constraint involving cigar_id — its only
  // one is (source, url) — so a re-point can never collide and the unmerge needs
  // no case in `restoreGuard`.
  const reviewObservationRows = await tx
    .update(reviewObservations)
    .set({ cigarId: target.id })
    .where(eq(reviewObservations.cigarId, source.id))
    .returning({ id: reviewObservations.id });

  // Want marks re-point, closing the #45-noted gap where a merge orphaned the
  // source's wants. The UNIQUE(user_id, cigar_id) pair forbids a user holding two
  // marks, so a user who wanted BOTH sides is de-duped: drop the source's mark
  // (the target's survives) FIRST, then re-point the rest — the re-point can no
  // longer collide. The audit records the de-dupe count; the ledger records the
  // dropped rows WHOLE, since a delete is the one step a re-point cannot reverse.
  const dedupedWantRows = await tx
    .delete(wants)
    .where(
      sql`${wants.cigarId} = ${source.id} AND EXISTS (
        SELECT 1 FROM wants w2 WHERE w2.cigar_id = ${target.id} AND w2.user_id = ${wants.userId}
      )`,
    )
    .returning();
  const wantRows = await tx
    .update(wants)
    .set({ cigarId: target.id })
    .where(eq(wants.cigarId, source.id))
    .returning({ id: wants.id });

  // Favorite marks re-point the same way — the second cigar-level mark, mirroring
  // wants exactly: drop the source's mark for any user who favorited BOTH sides
  // FIRST (the target's survives), then re-point the rest. The audit records the
  // favorite de-dupe count alongside the want one.
  const dedupedFavoriteRows = await tx
    .delete(favorites)
    .where(
      sql`${favorites.cigarId} = ${source.id} AND EXISTS (
        SELECT 1 FROM favorites f2 WHERE f2.cigar_id = ${target.id} AND f2.user_id = ${favorites.userId}
      )`,
    )
    .returning();
  const favoriteRows = await tx
    .update(favorites)
    .set({ cigarId: target.id })
    .where(eq(favorites.cigarId, source.id))
    .returning({ id: favorites.id });

  // Everything is off the source now — TOMBSTONE it instead of deleting
  // (DESIGN-003 §Curation "Merge stops hard-deleting … so Undo is real"). The
  // source survives with catalog_status='merged' and merged_into pointing at the
  // survivor, keeping its data. Every catalog-facing read excludes non-active
  // rows (catalog-browse / reads / curationQueue), so the tombstone never appears
  // in browse, search, or the duplicate queue. A leftover source product photo
  // (when the target already had one) stays attached to the hidden row.
  //
  // Undo is real because of the `cigar_merges` ledger written below (migration
  // 0020): the tombstone preserves the DATA, the ledger preserves WHICH rows
  // moved — which after the merge is otherwise unrecoverable, since a re-pointed
  // smoke is indistinguishable from one the survivor always had and the
  // want/favorite de-dupe deleted rows outright.
  await tx
    .update(cigars)
    .set({ catalogStatus: "merged", mergedInto: target.id, updatedAt: deps.now() })
    .where(eq(cigars.id, source.id));

  const repointed = {
    smokes: smokeRows.length,
    purchases: purchaseRows.length,
    listingMatches: listingRows.length,
    offers: offerRows.length,
    reviewObservations: reviewObservationRows.length,
    productPhotos: movedPhotoIds.length,
    enrichmentRequests: enrichmentRows.length,
    wants: wantRows.length,
    favorites: favoriteRows.length,
  };

  const mergeAudit = await tx
    .insert(auditLog)
    .values({
      userId: principal.userId,
      // Through the same funnel as every other curation write, so "a curation
      // audit row names the credential behind it" is structural rather than
      // incidental. Resolves to actor "web" with a null clientId today — merge
      // and dismiss are console-only, with no MCP tool and so no OAuth client —
      // and stays correct the day one gains a tool.
      ...auditAttribution(principal, undefined),
      action: "cigar.merge",
      smokeId: null,
      before,
      after: {
        target: cigarSnapshot(target),
        tombstonedSourceId: source.id,
        mergedInto: target.id,
        repointed,
        wantsDeduped: dedupedWantRows.length,
        favoritesDeduped: dedupedFavoriteRows.length,
      },
      correlationId: input.correlationId ?? input.clientRequestId,
    })
    .returning({ id: auditLog.id });

  // The bookkeeping row — same transaction as the merge, so an effect without its
  // ledger cannot exist. `repointed` (counts, for the audit's existing readers)
  // and `moved` (ids, for the restore) are deliberate redundancy: the counts are
  // a human-readable summary, the ledger is the machine-readable inverse.
  const ledger: CigarMergeLedgerV1 = {
    version: 1,
    sourceBefore: { catalogStatus: source.catalogStatus, mergedInto: source.mergedInto },
    moved: {
      smokes: smokeRows.map((r) => r.id),
      purchases: purchaseRows.map((r) => r.id),
      listingMatches: listingRows.map((r) => r.id),
      offers: offerRows.map((r) => r.id),
      reviewObservations: reviewObservationRows.map((r) => r.id),
      enrichmentRequests: enrichmentRows.map((r) => r.id),
      productPhotos: movedPhotoIds,
      wants: wantRows.map((r) => r.id),
      favorites: favoriteRows.map((r) => r.id),
    },
    dropped: {
      wants: dedupedWantRows.map(droppedMark),
      favorites: dedupedFavoriteRows.map(droppedMark),
    },
  };
  const mergeRow = await tx
    .insert(cigarMerges)
    .values({
      sourceCigarId: source.id,
      targetCigarId: target.id,
      auditId: mergeAudit[0]!.id,
      moves: ledger,
    })
    .returning({ id: cigarMerges.id });

  const result: MergeCigarsResult = {
    sourceCigarId: source.id,
    targetCigarId: target.id,
    repointed,
    mergeId: mergeRow[0]!.id,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "merge_cigars",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// unmergeCigars — reverse one merge from its ledger (curator-only, #45).
// --------------------------------------------------------------------------

// A parameterised uuid list for an `IN (…)` clause. Explicit casts, because the
// ids ride as text parameters and Postgres will not infer uuid inside `IN`.
function uuidList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

// The constraint a restore has to respect, per ledger slot, plus the skip reason
// it produces when it bites. The plain slots have none: their rows carry no
// uniqueness against the source, so the only way one fails to come back is that
// it moved on. Both clauses mirror the merge's own SQL in reverse.
function restoreGuard(table: string, sourceId: string): { clause: SQL; reason: UnmergeSkip["reason"] } | null {
  switch (table) {
    // product_photos is UNIQUE(cigar_id): a photo attached to the tombstone after
    // the merge owns the slot now. Guarding here rather than catching 23505 keeps
    // the whole unmerge in one transaction.
    case "product_photos":
      return {
        clause: sql`AND NOT EXISTS (SELECT 1 FROM product_photos p2 WHERE p2.cigar_id = ${sourceId}::uuid)`,
        reason: "source_occupied",
      };
    // wants/favorites are UNIQUE(user_id, cigar_id): the user may have re-marked
    // the tombstone since the merge, and that newer mark wins.
    case "wants":
    case "favorites":
      return {
        clause: sql`AND NOT EXISTS (
          SELECT 1 FROM ${sql.identifier(table)} m2
          WHERE m2.cigar_id = ${sourceId}::uuid AND m2.user_id = ${sql.identifier(table)}.user_id
        )`,
        reason: "conflict",
      };
    default:
      return null;
  }
}

// Move one slot's ledger rows back to the source. `AND cigar_id = target` is the
// load-bearing clause: a row a curator moved on since the merge is left exactly
// where it is, and re-running the statement is a no-op. Rows the ledger names
// that did not come back are classified — still on the survivor means the guard
// blocked them, anything else moved on.
async function restoreLedgerRows(
  tx: Tx,
  table: string,
  ids: string[],
  sourceId: string,
  targetId: string,
  guard: SQL | null,
): Promise<{ restored: string[]; blocked: string[]; movedOn: string[] }> {
  const name = sql.identifier(table);
  const moved = await tx.execute(sql`
    UPDATE ${name} SET cigar_id = ${sourceId}::uuid
    WHERE id IN (${uuidList(ids)}) AND cigar_id = ${targetId}::uuid ${guard ?? sql``}
    RETURNING id
  `);
  const restored = (moved.rows as unknown as { id: string }[]).map((r) => r.id);
  const missing = ids.filter((id) => !restored.includes(id));
  if (missing.length === 0) return { restored, blocked: [], movedOn: [] };

  const still = await tx.execute(sql`
    SELECT id FROM ${name} WHERE id IN (${uuidList(missing)}) AND cigar_id = ${targetId}::uuid
  `);
  const blocked = (still.rows as unknown as { id: string }[]).map((r) => r.id);
  return { restored, blocked, movedOn: missing.filter((id) => !blocked.includes(id)) };
}

// Purchase lots among `ids` whose consumptions ALL belong to smokes that are not
// coming back — read after the smokes slot restores, so a returning smoke already
// reads `cigar_id = source`. Only those stay with the survivor: lot and
// consumption must live on the same cigar or the humidor arithmetic breaks
// (inventory.ts derives remaining = acquired − consumption links, keyed on
// purchases.cigar_id and smokes.cigar_id respectively).
//
// A lot BOTH sides drew from is deliberately NOT held back. Either placement
// strands one side's consumptions, and neither error is reliably the smaller: the
// held-back error is the returning smokes' consumptions, which is the larger count
// whenever the user had been logging the cigar for a while before the merge — the
// ordinary shape. The tie goes to the cigar the user actually bought, because only
// there does assertLotOwned (consumption.ts) let them attribute the next stick from
// that box. Splitting the purchase row would be the exact inverse; that is an owner
// decision, not the unmerge's to make.
async function lotsConsumedOnlyElsewhere(tx: Tx, ids: string[], sourceId: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    SELECT sc.purchase_id AS id
    FROM smoke_consumptions sc
    JOIN smokes s ON s.id = sc.smoke_id
    WHERE sc.purchase_id IN (${uuidList(ids)})
    GROUP BY sc.purchase_id
    HAVING count(*) FILTER (WHERE s.cigar_id = ${sourceId}::uuid) = 0
  `);
  return (rows.rows as unknown as { id: string }[]).map((r) => r.id);
}

// Re-create one want/favorite the merge's de-dupe DELETEd, with its original id,
// note and created_at — a restore, not a look-alike. onConflictDoNothing covers
// both the primary key and UNIQUE(user_id, cigar_id), so a mark the user
// re-created on the tombstone since the merge simply wins.
async function restoreDroppedMark(
  tx: Tx,
  kind: "wants" | "favorites",
  mark: CigarMergeDroppedMark,
  sourceId: string,
): Promise<boolean> {
  const values = {
    id: mark.id,
    userId: mark.userId,
    cigarId: sourceId,
    note: mark.note,
    createdAt: new Date(mark.createdAt),
  };
  const inserted =
    kind === "wants"
      ? await tx.insert(wants).values(values).onConflictDoNothing().returning({ id: wants.id })
      : await tx.insert(favorites).values(values).onConflictDoNothing().returning({ id: favorites.id });
  return inserted.length > 0;
}

// Claim a merge ledger for undo: a conditional UPDATE stamping `undone_at`, the
// same single-use pattern `photo_upload_tokens` uses. It serializes concurrent
// unmerges (the loser claims nothing) and backstops idempotency even when a
// second request carries a different clientRequestId. Zero rows claimed is
// either "no such merge" or "already undone" — distinguished by a plain select
// so the curator gets the honest message, never a silent no-op.
async function claimMerge(
  tx: Tx,
  deps: Deps,
  match: SQL,
  path: string,
  missingMessage: string,
): Promise<CigarMergeRow> {
  const claimed = await tx
    .update(cigarMerges)
    .set({ undoneAt: deps.now() })
    .where(and(match, isNull(cigarMerges.undoneAt)))
    .returning();
  if (claimed[0]) return claimed[0];
  const existing = await tx.select({ id: cigarMerges.id }).from(cigarMerges).where(match).limit(1);
  throw new ValidationError([
    { path, message: existing[0] ? "This merge was already unmerged." : missingMessage },
  ]);
}

export async function unmergeCigars(
  deps: Deps,
  principal: Principal,
  input: UnmergeCigarsInput,
): Promise<UnmergeCigarsResult> {
  assertCurator(principal);
  // The merge ledger is reached directly (claimMerge), not through a loader, so
  // the guard repeats claimMerge's own "no such merge" answer verbatim — same
  // path, same message — before the transaction opens (./uuid.ts).
  if (!isUuid(input.mergeId)) {
    throw new ValidationError([{ path: "mergeId", message: "No merge matches the given id." }]);
  }
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => unmergeEnvelope(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as UnmergeCigarsResult), replayed: true };
      }
    }
    throw error;
  }
}

async function unmergeEnvelope(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: UnmergeCigarsInput,
  requestFingerprint: string,
): Promise<UnmergeCigarsResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as UnmergeCigarsResult), replayed: true };
  }

  const merge = await claimMerge(
    tx,
    deps,
    eq(cigarMerges.id, input.mergeId),
    "mergeId",
    "No merge matches the given id.",
  );
  const result: UnmergeCigarsResult = {
    ...(await unmergeWithinTx(tx, deps, principal, merge, input.correlationId ?? input.clientRequestId)),
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "unmerge_cigars",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// The restore itself, shared by the standalone service and the Undo path so both
// run identical code. The ledger row arrives already claimed. Writes its own
// `cigar.unmerge` audit linked `reverts` = the merge's audit row, which is also
// what makes a later Undo of that same merge audit report "already undone".
async function unmergeWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  merge: CigarMergeRow,
  correlationId: string,
): Promise<Omit<UnmergeCigarsResult, "replayed">> {
  const ledger = merge.moves;
  const source = await loadCigar(tx, merge.sourceCigarId);
  const target = await loadCigar(tx, merge.targetCigarId);
  if (!source || !target) throw new CigarNotFoundError();
  // The ledger only describes a world where the source is still THIS merge's
  // tombstone. Anything else (re-merged elsewhere, restored by hand) means the
  // recorded inverse no longer applies.
  if (source.catalogStatus !== "merged" || source.mergedInto !== target.id) {
    throw new ValidationError([
      { path: "mergeId", message: "This merge is no longer the cigar's current state." },
    ]);
  }
  // LIFO. After A→B then B→C, this ledger's ids sit on C, not B: restoring them
  // "from B" would silently move nothing, and taking them from C would gut the
  // B→C ledger. Undo the later merge first and this one becomes valid again.
  if (target.catalogStatus === "merged") {
    throw new ValidationError([{ path: "mergeId", message: "Undo the later merge first." }]);
  }

  const restored = {
    smokes: 0,
    purchases: 0,
    listingMatches: 0,
    offers: 0,
    reviewObservations: 0,
    productPhotos: 0,
    enrichmentRequests: 0,
    wants: 0,
    favorites: 0,
  };
  const skipped: UnmergeSkip[] = [];
  let crossCigarLots = 0;

  // Rows created on the survivor AFTER the merge are handled structurally, not by
  // a query: the ledger is an explicit id list captured at merge time, so a
  // post-merge smoke, purchase, mark or crawler match is simply not in it. No
  // "move everything pointing at the target" statement exists anywhere here.
  for (const slot of MERGE_LEDGER_TABLES) {
    const ids = ledger.moved[slot.key] ?? [];
    if (ids.length === 0) continue;
    let movable = ids;
    if (slot.key === "purchases") {
      // A lot whose every consumption belongs to a smoke that is NOT coming back
      // stays with the survivor. getMyInventory builds a holding from `purchases`
      // and counts consumption by `smokes.cigar_id` (inventory.ts), so returning
      // such a lot would resurrect sticks the user has smoked AND drop the
      // survivor out of the humidor entirely — the one skip the user, not the
      // curator, would feel. Smokes restore first (slot order), so this reads the
      // post-restore attribution. Bound of the inverse: a lot BOTH sides smoked
      // from goes back with the source and the survivor's own consumptions no
      // longer meet a lot — see lotsConsumedOnlyElsewhere for why that direction.
      const crossCigar = await lotsConsumedOnlyElsewhere(tx, ids, source.id);
      crossCigarLots = crossCigar.length;
      movable = ids.filter((id) => !crossCigar.includes(id));
      for (const rowId of crossCigar) skipped.push({ entity: slot.key, rowId, reason: "consumed_elsewhere" });
      if (movable.length === 0) continue;
    }
    const guard = restoreGuard(slot.table, source.id);
    const outcome = await restoreLedgerRows(tx, slot.table, movable, source.id, target.id, guard?.clause ?? null);
    restored[slot.key] = outcome.restored.length;
    for (const rowId of outcome.blocked) skipped.push({ entity: slot.key, rowId, reason: guard!.reason });
    for (const rowId of outcome.movedOn) skipped.push({ entity: slot.key, rowId, reason: "moved_on" });
  }

  for (const mark of ledger.dropped.wants ?? []) {
    if (await restoreDroppedMark(tx, "wants", mark, source.id)) restored.wants += 1;
    else skipped.push({ entity: "wants", rowId: mark.id, reason: "conflict" });
  }
  for (const mark of ledger.dropped.favorites ?? []) {
    if (await restoreDroppedMark(tx, "favorites", mark, source.id)) restored.favorites += 1;
    else skipped.push({ entity: "favorites", rowId: mark.id, reason: "conflict" });
  }

  // Un-tombstone to the source's PRE-merge lifecycle, not a hardcoded 'active':
  // unmerging a cigar that was excluded before must not quietly publish it.
  const restoredSourceStatus: CatalogStatus = ledger.sourceBefore?.catalogStatus ?? "active";
  await tx
    .update(cigars)
    .set({
      catalogStatus: restoredSourceStatus,
      mergedInto: ledger.sourceBefore?.mergedInto ?? null,
      updatedAt: deps.now(),
    })
    .where(eq(cigars.id, source.id));

  const undoAudit = await tx
    .insert(auditLog)
    .values({
      userId: principal.userId,
      // A human curator drove this, whether from the merges list or the Undo
      // button: actor 'web', no runId — so it never enters "Recent agent runs".
      ...auditAttribution(principal, undefined),
      action: "cigar.unmerge",
      smokeId: null,
      before: { source: cigarSnapshot(source), target: cigarSnapshot(target) },
      after: { mergeId: merge.id, restored, skipped, restoredSourceStatus, crossCigarLots },
      reverts: merge.auditId,
      correlationId,
    })
    .returning({ id: auditLog.id });
  const undoAuditId = undoAudit[0]!.id;
  await tx.update(cigarMerges).set({ undoAuditId }).where(eq(cigarMerges.id, merge.id));

  return {
    mergeId: merge.id,
    sourceCigarId: source.id,
    targetCigarId: target.id,
    restored,
    skipped,
    restoredSourceStatus,
    crossCigarLots,
    undoAuditId,
  };
}

// --------------------------------------------------------------------------
// recentMerges — the console's merge history + unmerge affordance.
// --------------------------------------------------------------------------

// A merge audit is actor 'web' with no run_id, so it can never appear in "Recent
// agent runs" — the merge/unmerge pair needs its own section. Bounded like the
// other admin reads; newest first.
const RECENT_MERGES_CAP = 50;

export async function recentMerges(deps: Deps, principal: Principal): Promise<RecentMergesResult> {
  assertCurator(principal);

  const result = await deps.db.execute(sql`
    SELECT m.id, m.moves, m.merged_at::text AS merged_at, m.undone_at::text AS undone_at,
           s.id AS source_id, s.canonical_name AS source_name,
           s.catalog_status AS source_status, s.merged_into AS source_merged_into,
           t.id AS target_id, t.canonical_name AS target_name, t.catalog_status AS target_status,
           jsonb_array_length(ua.after -> 'skipped') AS skipped_count
    FROM cigar_merges m
    JOIN cigars s ON s.id = m.source_cigar_id
    JOIN cigars t ON t.id = m.target_cigar_id
    -- The unmerge's own audit, for the skip count the console shows: unmerge is
    -- not always a byte-exact inverse and the console must say so.
    LEFT JOIN audit_log ua ON ua.id = m.undo_audit_id
    ORDER BY m.merged_at DESC, m.id DESC
    LIMIT ${RECENT_MERGES_CAP}
  `);
  const rows = result.rows as unknown as {
    id: string;
    moves: CigarMergeLedgerV1;
    merged_at: string;
    undone_at: string | null;
    source_id: string;
    source_name: string;
    source_status: CatalogStatus;
    source_merged_into: string | null;
    target_id: string;
    target_name: string;
    target_status: CatalogStatus;
    skipped_count: number | null;
  }[];

  const merges: RecentMerge[] = rows.map((r) => {
    const undone = r.undone_at != null;
    const blockedByLaterMerge = !undone && r.target_status === "merged";
    // Same three preconditions unmergeWithinTx enforces, so the console never
    // renders a button that would error: still this merge's tombstone, survivor
    // not itself merged, ledger not yet claimed.
    const stillThisMerge = r.source_status === "merged" && r.source_merged_into === r.target_id;
    return {
      mergeId: r.id,
      mergedAt: new Date(r.merged_at).toISOString(),
      source: { cigarId: r.source_id, canonicalName: r.source_name },
      target: { cigarId: r.target_id, canonicalName: r.target_name },
      moved: movedCounts(r.moves),
      undone,
      undoneAt: r.undone_at != null ? new Date(r.undone_at).toISOString() : null,
      skippedCount: r.skipped_count != null ? Number(r.skipped_count) : null,
      blockedByLaterMerge,
      reversible: !undone && !blockedByLaterMerge && stillThisMerge,
    };
  });
  return { merges };
}

// Per-slot totals for the console chips: everything an unmerge would try to
// restore, so a de-duped mark counts alongside a re-pointed one (to a curator
// they are the same "this moved" set). Empty slots are dropped.
function movedCounts(ledger: CigarMergeLedgerV1): { entity: string; count: number }[] {
  const dropped: Record<string, number> = {
    wants: ledger.dropped?.wants?.length ?? 0,
    favorites: ledger.dropped?.favorites?.length ?? 0,
  };
  return MERGE_LEDGER_TABLES.map((slot) => ({
    entity: slot.key,
    count: (ledger.moved[slot.key]?.length ?? 0) + (dropped[slot.key] ?? 0),
  })).filter((c) => c.count > 0);
}

// --------------------------------------------------------------------------
// verifyCigar — flip the catalog lifecycle flag to verified (curator-only).
// --------------------------------------------------------------------------

export async function verifyCigar(
  deps: Deps,
  principal: Principal,
  input: VerifyCigarInput,
): Promise<VerifyCigarResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => verifyWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as VerifyCigarResult), replayed: true };
      }
    }
    throw error;
  }
}

async function verifyWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: VerifyCigarInput,
  requestFingerprint: string,
): Promise<VerifyCigarResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as VerifyCigarResult), replayed: true };
  }

  const current = await loadCigar(tx, input.cigarId);
  if (!current) throw new CigarNotFoundError();

  const before = cigarSnapshot(current);
  await tx
    .update(cigars)
    .set({ verification: "verified", updatedAt: deps.now() })
    .where(eq(cigars.id, current.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(principal, input.attribution),
    action: "cigar.verify",
    smokeId: null,
    before,
    after: { ...before, verification: "verified" },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: VerifyCigarResult = {
    cigarId: current.id,
    verification: "verified",
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "verify_cigar",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// dismissDuplicate — record that a candidate pair is not a duplicate
// (curator-only).
// --------------------------------------------------------------------------

export async function dismissDuplicate(
  deps: Deps,
  principal: Principal,
  rawInput: DismissDuplicateInput,
): Promise<DismissDuplicateResult> {
  assertCurator(principal);
  // Canonical lowercase form up front: the id-ordering below and the table's
  // CHECK compare as Postgres uuids, and JS string comparison only agrees with
  // that for lowercase hex. Also keeps the self-pair guard and the idempotency
  // fingerprint insensitive to input casing.
  const input: DismissDuplicateInput = {
    ...rawInput,
    cigarAId: rawInput.cigarAId.toLowerCase(),
    cigarBId: rawInput.cigarBId.toLowerCase(),
  };
  if (input.cigarAId === input.cigarBId) {
    throw new ValidationError([{ path: "cigarBId", message: "A pair needs two distinct cigars." }]);
  }
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => dismissWithinTx(tx, principal, input, requestFingerprint));
  } catch (error) {
    // Concurrent first-writer committed the key between our check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as DismissDuplicateResult), replayed: true };
      }
    }
    throw error;
  }
}

async function dismissWithinTx(
  tx: Tx,
  principal: Principal,
  input: DismissDuplicateInput,
  requestFingerprint: string,
): Promise<DismissDuplicateResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as DismissDuplicateResult), replayed: true };
  }

  // Normalize to the queue's id-ordering (c1.id < c2.id) so a dismissal filed
  // from either direction matches the surfaced pair. Lexicographic comparison
  // of canonical lowercase UUID strings agrees with Postgres uuid ordering, so
  // this also satisfies the table's CHECK (cigar_a_id < cigar_b_id).
  const [aId, bId] =
    input.cigarAId < input.cigarBId ? [input.cigarAId, input.cigarBId] : [input.cigarBId, input.cigarAId];

  const a = await loadCigar(tx, aId);
  const b = await loadCigar(tx, bId);
  if (!a || !b) throw new CigarNotFoundError();

  // Naturally idempotent: a pair dismissed by an earlier request (or another
  // curator) stays dismissed; the conflict is not an error.
  await tx
    .insert(duplicateDismissals)
    .values({ cigarAId: aId, cigarBId: bId, dismissedBy: principal.userId })
    .onConflictDoNothing();

  await tx.insert(auditLog).values({
    userId: principal.userId,
    // Through the same funnel as every other curation write, so "a curation
    // audit row names the credential behind it" is structural rather than
    // incidental. Resolves to actor "web" with a null clientId today — merge
    // and dismiss are console-only, with no MCP tool and so no OAuth client —
    // and stays correct the day one gains a tool.
    ...auditAttribution(principal, undefined),
    action: "cigar.dismiss_duplicate",
    smokeId: null,
    before: { a: cigarSnapshot(a), b: cigarSnapshot(b) },
    after: { dismissed: { cigarAId: aId, cigarBId: bId } },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: DismissDuplicateResult = { cigarAId: aId, cigarBId: bId, replayed: false };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "dismiss_duplicate",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// setListingMatchStatus — a curator/agent verdict on a vendor listing→cigar
// link (DESIGN-003 §Curation "Missing human primitive"). Confirm keeps the
// resolved cigar; unmatch clears it.
// --------------------------------------------------------------------------

// Confirming keeps the match's cigar; unmatching clears it to null — the schema's
// implied invariant, since a crawler-created unmatched row carries cigar_id null.
// Reads already gate offers on lm.status IN ('auto','confirmed') (catalog-browse
// OFFER_JOIN, reads latestSeries), so an unmatched link stops contributing offers
// regardless of the cleared column; product photos link by cigar_id (never through
// a match), so they are untouched. The prior cigar_id rides the audit `before` for
// reversibility. Idempotent via the ADR-003 envelope; audits in-transaction.
// (The crawler protects only a `confirmed` row from re-matching — match.ts — so an
// unmatched verdict may be re-proposed as `auto` on a later crawl, by design.)
export async function setListingMatchStatus(
  deps: Deps,
  principal: Principal,
  input: SetListingMatchStatusInput,
): Promise<SetListingMatchStatusResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) =>
      setListingMatchStatusWithinTx(tx, deps, principal, input, requestFingerprint),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SetListingMatchStatusResult), replayed: true };
      }
    }
    throw error;
  }
}

async function setListingMatchStatusWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: SetListingMatchStatusInput,
  requestFingerprint: string,
): Promise<SetListingMatchStatusResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as SetListingMatchStatusResult), replayed: true };
  }

  const match = await loadListingMatch(tx, input.matchId);
  // No dedicated not-found code for a listing match (curator-only admin surface);
  // a bad id is a fixable input, reported as validation_error.
  if (!match) {
    throw new ValidationError([{ path: "matchId", message: "No listing match matches the given id." }]);
  }
  // Confirming a match to no cigar is meaningless — the resolver must have linked
  // one first (or the caller passes 'unmatched').
  if (input.status === "confirmed" && match.cigarId == null) {
    throw new ValidationError([{ path: "matchId", message: "A match with no cigar cannot be confirmed." }]);
  }

  const before = listingMatchSnapshot(match);
  const nextCigarId = input.status === "unmatched" ? null : match.cigarId;
  // Stamp provenance so a later crawl preserves this verdict (ADR-006, migration
  // 0017). The agent curation surface passes attribution.actor='agent'; the web
  // console leaves it absent → 'curator'. Actor is server-derived (see
  // auditAttribution), never a tool argument.
  const decidedBy = input.attribution?.actor === "agent" ? "agent" : "curator";
  await tx
    .update(listingMatches)
    .set({ status: input.status, cigarId: nextCigarId, decidedBy, updatedAt: deps.now() })
    .where(eq(listingMatches.id, match.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(principal, input.attribution),
    action: "listing_match.set_status",
    smokeId: null,
    before,
    after: { ...before, status: input.status, cigarId: nextCigarId, decidedBy },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: SetListingMatchStatusResult = {
    matchId: match.id,
    status: input.status,
    cigarId: nextCigarId,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "set_listing_match_status",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// excludeCigar / restoreCigar — hide a catalog Cigar from browse/search/queue
// without deleting it, and undo that (DESIGN-003 §Curation).
// --------------------------------------------------------------------------

// EXCLUDED ≠ DELETED. An excluded cigar drops out of every catalog-facing read
// (browse/brands/shelves/brand pages/search/curation queue — all filter
// catalog_status='active'), but it is NOT removed: its detail page stays reachable
// by direct id and its owner's smokes/journal reads still resolve (getCigar and
// the smoke reads do not filter status). This is the rule for "non-cigar pollution"
// and for hiding an entry without destroying an owner's history — reversible via
// restoreCigar. Idempotent via the ADR-003 envelope; audits in-transaction.
export async function excludeCigar(
  deps: Deps,
  principal: Principal,
  input: SetCatalogStatusInput,
): Promise<SetCatalogStatusResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => excludeWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SetCatalogStatusResult), replayed: true };
      }
    }
    throw error;
  }
}

async function excludeWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: SetCatalogStatusInput,
  requestFingerprint: string,
): Promise<SetCatalogStatusResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as SetCatalogStatusResult), replayed: true };
  }

  const current = await loadCigar(tx, input.cigarId);
  if (!current) throw new CigarNotFoundError();
  // A merged tombstone is not an exclude target — it is undone by unmergeCigars,
  // which re-points its data back, not by exclude/restore.
  if (current.catalogStatus === "merged") {
    throw new ValidationError([{ path: "cigarId", message: "A merged cigar cannot be excluded." }]);
  }

  // HELD INVENTORY IS NEVER EXCLUDABLE (#169). catalog_status='excluded' drops the
  // row out of every catalog-facing read, so excluding a cigar somebody bought
  // hides their sticks with nothing on screen saying why. That is not hypothetical:
  // on 2026-08-29 the curation agent excluded three samplers the owner held and 23
  // sticks left the humidor until a hand-restore the next day. The agent's manual
  // has since been tightened, but guidance is not enforcement — this is.
  //
  // ANY purchases row blocks, for ANY user:
  //   - any row, not "rows with stock left". `remaining` is derived (total acquired
  //     minus consumption links, ADR-008) and floors at zero, so a "remaining > 0"
  //     test would make excludability flicker as the owner smokes, and a
  //     fully-consumed lot is still the provenance of a journal entry.
  //   - any user, not `principal.userId`. Someone else's inventory is no more
  //     excludable than the curator's own, and the curator is by definition not the
  //     only person whose humidor an exclusion can empty.
  //
  // No override argument, deliberately — the same house rule as
  // queue_enrichment_backlog's preconditions: the way past a precondition is to do
  // the thing it asserts (remove the lots, rename the entry, or merge it into the
  // right one), and a flag would just be the old footgun with a longer name.
  //
  // ONE-DIRECTIONAL, deliberately. This refuses the exclude of a held cigar; it
  // does NOT stop a lot from landing on an already-excluded one. recordPurchase
  // resolves by id and never consults catalog_status, so an explicit cigarId held
  // from before the exclusion still buys, and — the same mechanism at a smaller
  // scale — a record_purchase committing between this SELECT and the UPDATE below
  // is invisible under READ COMMITTED. Locking the race would need
  // SELECT ... FOR UPDATE here plus a matching FOR SHARE in record-purchase.ts,
  // which does not touch `cigars` at all today, and locking the general case means
  // a new refusal on the journal's hottest write. Neither is bought here: this
  // guard exists to stop a deliberate agent/console decision, the resulting state
  // is visible in the humidor (getMyInventory does not filter catalog_status) and
  // recoverable with restoreCigar.
  const [held] = await tx
    .select({
      lots: sql<number>`count(*)::int`,
      // Nullable and occasionally negative (correction rows) — coalesced so the
      // refusal always has a number to name, never a null.
      sticks: sql<number>`coalesce(sum(${purchases.quantity}), 0)::int`,
    })
    .from(purchases)
    .where(eq(purchases.cigarId, current.id));
  if (held && held.lots > 0) {
    // The counts ride the prose, not a structured payload: every peer curation
    // refusal is a field-pathed ValidationError, and `validation_error` is the code
    // the published tool contract already documents for them. A dedicated
    // `cigar_held` code would let a client branch programmatically, but the only
    // correct client response here is "tell the operator", which prose serves.
    throw new ValidationError([
      {
        path: "cigarId",
        message:
          `This cigar is held: ${countOf(held.lots, "purchase lot")} (${countOf(held.sticks, "stick")}). ` +
          `Excluding it would hide inventory from its owner — rename or merge it instead.`,
      },
    ]);
  }

  const before = cigarSnapshot(current);
  await tx
    .update(cigars)
    .set({ catalogStatus: "excluded", updatedAt: deps.now() })
    .where(eq(cigars.id, current.id));

  // Cascade: an excluded cigar must not keep resurfacing in match_triage. Its
  // 'auto' listing links are unmatched IN THE SAME TRANSACTION (status→'unmatched',
  // cigar cleared — the setListingMatchStatus 'unmatched' contract), so the 20
  // gift-card listings that point at excluded cigars in prod (#126) leave the
  // triage queue for good. The unmatched ids ride the exclude audit's `after` so
  // the action is transparent and auditable as one write.
  //
  // ASYMMETRY (documented): restoreCigar / an Undo of this exclude reactivates the
  // cigar only — it does NOT re-match these listings. A legitimate listing is
  // re-proposed as 'auto' by the crawler's next run; a bad gift-card match stays
  // gone. The match_triage read ALSO filters non-active cigars, so even a
  // re-proposed 'auto' against a still-excluded cigar never resurfaces.
  const unmatched = await tx
    .update(listingMatches)
    .set({ status: "unmatched", cigarId: null, updatedAt: deps.now() })
    .where(and(eq(listingMatches.cigarId, current.id), eq(listingMatches.status, "auto")))
    .returning({ id: listingMatches.id });

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(principal, input.attribution),
    action: "cigar.exclude",
    smokeId: null,
    before,
    after: { ...before, catalogStatus: "excluded", cascadeUnmatched: unmatched.map((r) => r.id) },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: SetCatalogStatusResult = { cigarId: current.id, catalogStatus: "excluded", replayed: false };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "exclude_cigar",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// Restore an excluded cigar to active. The audit's `reverts` self-links the most
// recent cigar.exclude for this cigar (the reversibility substrate, migration
// 0012) so the review console can render this as an undo of that action.
export async function restoreCigar(
  deps: Deps,
  principal: Principal,
  input: SetCatalogStatusInput,
): Promise<SetCatalogStatusResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => restoreWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SetCatalogStatusResult), replayed: true };
      }
    }
    throw error;
  }
}

async function restoreWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: SetCatalogStatusInput,
  requestFingerprint: string,
): Promise<SetCatalogStatusResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as SetCatalogStatusResult), replayed: true };
  }

  const current = await loadCigar(tx, input.cigarId);
  if (!current) throw new CigarNotFoundError();
  // A merged tombstone is restored by unmergeCigars (which re-points its data back
  // and returns the pre-merge status), not by flipping the flag — restore only
  // reverses an exclude.
  if (current.catalogStatus === "merged") {
    throw new ValidationError([{ path: "cigarId", message: "A merged cigar is restored by unmerge, not restore." }]);
  }

  // The exclude this restore undoes: the most recent cigar.exclude audit whose
  // snapshot names this cigar. Null when the cigar was never excluded (a restore
  // of an already-active row is a harmless no-op with no revert link).
  const excludeAudit = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, "cigar.exclude"), sql`(${auditLog.after} ->> 'id') = ${current.id}`))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const revertsId = excludeAudit[0]?.id ?? null;

  const before = cigarSnapshot(current);
  await tx
    .update(cigars)
    .set({ catalogStatus: "active", updatedAt: deps.now() })
    .where(eq(cigars.id, current.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(principal, input.attribution),
    action: "cigar.restore",
    smokeId: null,
    before,
    after: { ...before, catalogStatus: "active" },
    reverts: revertsId,
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: SetCatalogStatusResult = { cigarId: current.id, catalogStatus: "active", replayed: false };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "restore_cigar",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// setProductPhotoRights — approve or suppress a catalog cigar's product photo
// (DESIGN-003 §Curation "Fix the rights bug first").
// --------------------------------------------------------------------------

// Sets the single product photo's rights. `suppressed` is a takedown: getProductPhoto
// stops serving it and every cover/has-photo read (catalog-browse) drops it, falling
// back to the monogram. `approved` clears a photo for the (future) public path;
// `pending` is the crawl default. Curator-only, audited in-transaction, idempotent
// via the ADR-003 envelope — the reachable approve/suppress the rights bug lacked.
export async function setProductPhotoRights(
  deps: Deps,
  principal: Principal,
  input: SetProductPhotoRightsInput,
): Promise<SetProductPhotoRightsResult> {
  assertCurator(principal);
  // This one reaches product_photos directly rather than through loadCigar, and
  // so answers PhotoNotFoundError — a cigar with no photo row is the same refusal
  // as no cigar at all here. Before the transaction: a 22P02 would abort it
  // (./uuid.ts).
  if (!isUuid(input.cigarId)) throw new PhotoNotFoundError();
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) =>
      setProductPhotoRightsWithinTx(tx, principal, input, requestFingerprint),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SetProductPhotoRightsResult), replayed: true };
      }
    }
    throw error;
  }
}

async function setProductPhotoRightsWithinTx(
  tx: Tx,
  principal: Principal,
  input: SetProductPhotoRightsInput,
  requestFingerprint: string,
): Promise<SetProductPhotoRightsResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as SetProductPhotoRightsResult), replayed: true };
  }

  const rows = await tx.select().from(productPhotos).where(eq(productPhotos.cigarId, input.cigarId)).limit(1);
  const photo = rows[0];
  if (!photo) throw new PhotoNotFoundError();

  const before = productPhotoSnapshot(photo);
  await tx.update(productPhotos).set({ rights: input.rights }).where(eq(productPhotos.id, photo.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(principal, input.attribution),
    action: "product_photo.set_rights",
    smokeId: null,
    before,
    after: { ...before, rights: input.rights },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: SetProductPhotoRightsResult = {
    cigarId: input.cigarId,
    rights: input.rights,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "set_product_photo_rights",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// setCigarFacts — curator write of a cigar's identity facts (curator-only,
// DESIGN-003 wave 4a). The authoritative counterpart to the conversational
// update_cigar: it OVERWRITES a wrong value and may touch a verified row.
// --------------------------------------------------------------------------

// Only these four identity facts are writable through the curator path. Each maps
// a request key → the cigar column it sets; `type` is enum-constrained upstream
// (schema), the rest are free text. A key present in `fields` is written (a string
// sets it, `null` clears a wrong value); an omitted key is untouched. Unlike
// update_cigar this is NOT fill-nulls-only and NOT unverified-only — the curator's
// verdict is trusted over whatever the crawler/chat guessed (ADR-006 trust order).
const CIGAR_FACT_COLUMNS: { key: "brand" | "line" | "type" | "manufacturer"; column: keyof NewCigarRow }[] = [
  { key: "brand", column: "brand" },
  { key: "line", column: "line" },
  { key: "type", column: "type" },
  { key: "manufacturer", column: "manufacturer" },
];

export async function setCigarFacts(
  deps: Deps,
  principal: Principal,
  input: SetCigarFactsInput,
): Promise<SetCigarFactsResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => setCigarFactsWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SetCigarFactsResult), replayed: true };
      }
    }
    throw error;
  }
}

async function setCigarFactsWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: SetCigarFactsInput,
  requestFingerprint: string,
): Promise<SetCigarFactsResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as SetCigarFactsResult), replayed: true };
  }

  const current = await loadCigar(tx, input.cigarId);
  if (!current) throw new CigarNotFoundError();

  const set: Partial<NewCigarRow> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const unchanged: string[] = [];

  // A field is a candidate only when its key is present (undefined = untouched);
  // `null` is a deliberate clear. A candidate that already equals the stored value
  // is a no-op — recorded as `unchanged`, never audited.
  for (const { key, column } of CIGAR_FACT_COLUMNS) {
    const requested = input.fields[key];
    if (requested === undefined) continue;
    const currentValue = (current as unknown as Record<string, unknown>)[column as string] ?? null;
    const nextValue = requested ?? null;
    if (currentValue === nextValue) {
      unchanged.push(key);
      continue;
    }
    (set as Record<string, unknown>)[column as string] = nextValue;
    before[key] = currentValue;
    after[key] = nextValue;
    changedFields.push(key);
  }

  // Rewriting the brand text re-derives the registry link in the same UPDATE.
  // Not audited and not reported in `changedFields`: `brand_id` is a projection
  // of `brand`, not a fact the curator asserted, and an undo that restores the
  // text re-derives it again by the same rule.
  if (changedFields.includes("brand")) {
    set.brandId = await deriveBrandId(tx, (set.brand as string | null) ?? null);

    // ANCESTRY IS CHECKED WHEREVER A STRUCTURAL FK MOVES (ADR-012 Wave 2), and
    // this path moves one as a side effect. Re-spelling the marca on a row that
    // also carries a line would leave that line belonging to the brand the row
    // USED to claim — the exact inconsistency `assertCigarAncestry` exists to
    // name. Refused rather than silently repaired: clearing the line would
    // destroy a known fact, and picking a line under the new brand would invent
    // one. The curator's fix is `assignCigarParts`, which moves the levels
    // together. Unreachable today — 0026 minted no lines, so no row has one —
    // and wired now so it cannot become reachable unnoticed.
    const ancestry = {
      brandId: (set.brandId as string | null) ?? null,
      lineId: current.lineId,
      blendId: current.blendId,
    };
    assertCigarAncestry(ancestry, await loadAncestryContext(tx, ancestry));
  }

  if (changedFields.length > 0) {
    await tx
      .update(cigars)
      .set({ ...set, updatedAt: deps.now() })
      .where(eq(cigars.id, current.id));

    // A `composed` name is a projection of the parts; a part just changed, so it
    // is recomputed in the same transaction. A `freeform` row is untouched —
    // recomposeCigarName no-ops on one.
    await recomposeCigarName(tx, current.id, deps.now());

    // The cigar id rides both snapshots (like cigarSnapshot's `id`) so the review
    // console can name the target and an Undo knows which row to write the
    // before-values back to (undoCurationAction, DESIGN-003 wave 4b). Additive —
    // the changed-field keys are unchanged.
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "cigar.set_facts",
      smokeId: null,
      before: { id: current.id, ...before },
      after: { id: current.id, ...after },
      correlationId: input.correlationId ?? input.clientRequestId,
    });
  }

  const result: SetCigarFactsResult = {
    cigarId: current.id,
    changedFields,
    unchanged,
    verification: current.verification,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "set_cigar_facts",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// renameCigar — set a Cigar's canonical name (#45; curator-only, wave 4b).
// canonicalName is identity — update_cigar/setCigarFacts never touch it, so this
// is the one authorized path. Uniqueness is trigram-fuzzy (no constraint), so a
// rename never collides at write time. Audited before→after; idempotent via the
// envelope; a no-op (no audit) when the trimmed name already matches.
// --------------------------------------------------------------------------

export async function renameCigar(
  deps: Deps,
  principal: Principal,
  input: RenameCigarInput,
): Promise<RenameCigarResult> {
  assertCurator(principal);
  const name = input.canonicalName.trim();
  if (name.length === 0) {
    throw new ValidationError([{ path: "canonicalName", message: "A cigar needs a name." }]);
  }
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => renameWithinTx(tx, deps, principal, input, name, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as RenameCigarResult), replayed: true };
      }
    }
    throw error;
  }
}

async function renameWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: RenameCigarInput,
  name: string,
  requestFingerprint: string,
): Promise<RenameCigarResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as RenameCigarResult), replayed: true };
  }

  const current = await loadCigar(tx, input.cigarId);
  if (!current) throw new CigarNotFoundError();

  // A COMPOSED NAME IS NOT EDITABLE AS A STRING (ADR-012). `canonical_name` on a
  // composed row is a projection of brand + line + blend + vitola + edition, so
  // typing over it would be undone by the next part change and would meanwhile
  // make the row look maintained while disagreeing with its own parts. The edit
  // the curator wants is on the parts; say so and name the path.
  if (current.nameSource === "composed") {
    throw new ValidationError([
      {
        path: "canonicalName",
        message: "This cigar's name is composed from its brand, line, blend and vitola. Edit those parts instead.",
      },
    ]);
  }

  const changed = current.canonicalName !== name;
  if (changed) {
    await tx.update(cigars).set({ canonicalName: name, updatedAt: deps.now() }).where(eq(cigars.id, current.id));
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "cigar.rename",
      smokeId: null,
      before: { id: current.id, canonicalName: current.canonicalName },
      after: { id: current.id, canonicalName: name },
      correlationId: input.correlationId ?? input.clientRequestId,
    });
  }

  const result: RenameCigarResult = { cigarId: current.id, canonicalName: name, changed, replayed: false };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "rename_cigar",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// curationQueue — the admin read: unverified backlog + duplicate candidates.
// --------------------------------------------------------------------------

// Load identity + reference counts for a set of cigars, keyed by id. The counts
// are correlated subqueries (offer counts hop through listing_matches, since an
// Offer references a Cigar only via its match). One round trip regardless of set
// size.
async function queueCigarsByIds(tx: Queryer, ids: string[]): Promise<Map<string, CurationQueueCigar>> {
  if (ids.length === 0) return new Map();
  // Raw SQL with explicit table aliases: the offer count hops offers → matches →
  // cigar, and every subquery reuses `id`/`cigar_id`, so the aliases are what
  // keep the correlation unambiguous.
  const result = await tx.execute(sql`
    SELECT c.id AS cigar_id, c.canonical_name, c.brand, c.created_at,
           (SELECT count(*) FROM smokes s WHERE s.cigar_id = c.id)::int AS smoke_count,
           (SELECT count(*) FROM purchases p WHERE p.cigar_id = c.id)::int AS purchase_count,
           (SELECT count(*) FROM offers o
              JOIN listing_matches lm ON o.listing_match_id = lm.id
              WHERE lm.cigar_id = c.id)::int AS offer_count
    FROM cigars c
    WHERE c.id::text IN (${sql.join(ids, sql`, `)})
  `);
  const rows = result.rows as unknown as {
    cigar_id: string;
    canonical_name: string;
    brand: string | null;
    created_at: Date;
    smoke_count: number;
    purchase_count: number;
    offer_count: number;
  }[];

  return new Map(
    rows.map((r) => [
      r.cigar_id,
      {
        cigarId: r.cigar_id,
        canonicalName: r.canonical_name,
        brand: r.brand,
        createdAt: new Date(r.created_at).toISOString(),
        smokeCount: Number(r.smoke_count),
        purchaseCount: Number(r.purchase_count),
        offerCount: Number(r.offer_count),
      },
    ]),
  );
}

export async function curationQueue(deps: Deps, principal: Principal): Promise<CurationQueueResult> {
  assertCurator(principal);
  const db = deps.db;

  // Unverified backlog, oldest first (the entries that have waited longest). Only
  // active rows — excluded pollution and merged tombstones are not backlog
  // (DESIGN-003 §Curation).
  const unverifiedIdRows = await db
    .select({ id: cigars.id })
    .from(cigars)
    .where(and(eq(cigars.verification, "unverified"), eq(cigars.catalogStatus, "active")))
    .orderBy(asc(cigars.createdAt))
    .limit(UNVERIFIED_CAP);
  const unverifiedIds = unverifiedIdRows.map((r) => r.id);

  // Near-duplicate candidate pairs across DISTINCT rows (c1.id < c2.id dedupes
  // the mirror pair). The `%` join prefilters via the trigram GIN index; the
  // explicit similarity filter applies the strong-match bar. Only active rows are
  // candidates (DESIGN-003 §Curation) — an already-merged tombstone or an excluded
  // row is never re-surfaced as a duplicate. Pairs a curator has ruled distinct
  // (duplicate_dismissals, stored with the same id-ordering) stay out of the queue.
  const pairResult = await db.execute(sql`
    SELECT c1.id AS a_id, c2.id AS b_id,
           c1.canonical_name AS a_name, c2.canonical_name AS b_name,
           similarity(c1.canonical_name, c2.canonical_name) AS sim
    FROM cigars c1
    JOIN cigars c2 ON c1.id < c2.id AND c1.canonical_name % c2.canonical_name
    WHERE c1.catalog_status = 'active' AND c2.catalog_status = 'active'
      AND similarity(c1.canonical_name, c2.canonical_name) > ${DUPLICATE_THRESHOLD}
      AND NOT EXISTS (
        SELECT 1 FROM duplicate_dismissals d
        WHERE d.cigar_a_id = c1.id AND d.cigar_b_id = c2.id
      )
    ORDER BY sim DESC
    LIMIT ${DUPLICATE_PAIR_CAP}
  `);
  const rawPairRows = pairResult.rows as unknown as {
    a_id: string;
    b_id: string;
    a_name: string;
    b_name: string;
    sim: number;
  }[];

  // The resolver's strong-link guard, applied to candidates: names carrying
  // distinct digit-bearing tokens ("No. 9" vs "T52", "1964" vs "1926", or a
  // one-sided "Signature 2000" vs "Signature"), an extra packaging token
  // ("… Tubos Pack" vs the naked stick), or a mutual word residue ("Monster
  // Series The Face" vs "… The Bride") are different products by definition —
  // never merge candidates, regardless of trigram score. Post-filtering after
  // the LIMIT can under-fill a capped page, acceptable for an admin backlog view.
  const pairRows = rawPairRows.filter((p) => strongLinkCompatible(p.a_name, p.b_name));

  // One metadata+counts fetch for every cigar referenced by either list.
  const allIds = new Set<string>(unverifiedIds);
  for (const p of pairRows) {
    allIds.add(p.a_id);
    allIds.add(p.b_id);
  }
  const meta = await queueCigarsByIds(db, [...allIds]);

  const unverified = unverifiedIds.map((id) => meta.get(id)).filter((c): c is CurationQueueCigar => c != null);
  const duplicates = pairRows
    .map((p) => {
      const a = meta.get(p.a_id);
      const b = meta.get(p.b_id);
      return a && b ? { similarity: Number(p.sim), a, b } : null;
    })
    .filter((p): p is { similarity: number; a: CurationQueueCigar; b: CurationQueueCigar } => p != null);

  return { unverified, duplicates };
}

// --------------------------------------------------------------------------
// curationWorklist — the paged admin drain queue (curator-only, DESIGN-003
// wave 4a). One tool, six kinds: the reads the ops agent works through.
// --------------------------------------------------------------------------

// Page defaults: a bounded read the agent drains cursor by cursor. Same caps as
// the legacy curationQueue's UNVERIFIED_CAP ceiling.
const WORKLIST_DEFAULT_LIMIT = 50;
const WORKLIST_MAX_LIMIT = 200;

// Opaque keyset cursor: [createdAt-ISO, id] for the row-ordered kinds, [aId, bId]
// for duplicates. Base64url JSON; a malformed value decodes to the first page
// rather than an error — a stale cursor degrades, mirroring the catalog/smoke
// cursors.
function encodeWorklistCursor(parts: [string, string]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

// Postgres' own rendering of a timestamptz (`created_at::text`), which is what
// the three time-ordered lanes put in the cursor's first slot — full microsecond
// precision and a space rather than a T, so it is deliberately matched by shape
// instead of Date.parse, whose acceptance of that spelling is not guaranteed.
const PG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/;

// Both halves are spent unquoted — every lane casts the second to ::uuid, and the
// first to ::timestamptz except the duplicates lane, which pairs two cigar ids and
// casts both to ::uuid. A well-formed envelope carrying junk therefore used to
// reach the database and raise an untyped cast error (22P02, or 22007 for the
// instant), which is a 500 rather than the graceful first page promised above.
// Accepting only what the encoder can emit makes that promise true; anything else
// is a cursor we did not issue, and absent is the honest reading (#206, ./uuid.ts).
//
// The caller declares which shape ITS lane will cast the first half to, because
// checking "uuid or instant" is not enough: cursors are opaque, so a client that
// pages the duplicates lane and then switches `kind` while still holding its
// cursor hands a pair of uuids to a lane that casts the first to ::timestamptz.
// That cursor is real — we issued it — and a shape check that accepts either
// spelling waves it through to the same 500 this guard exists to prevent. Only the
// lane knows which half is which, so only the lane can say.
type WorklistCursorHead = "uuid" | "instant";

function decodeWorklistCursor(
  raw: string | null | undefined,
  head: WorklistCursorHead,
): [string, string] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      (head === "uuid" ? isUuid(parsed[0]) : PG_TIMESTAMP_RE.test(parsed[0])) &&
      isUuid(parsed[1])
    ) {
      return [parsed[0], parsed[1]];
    }
    return null;
  } catch {
    return null;
  }
}

interface CigarFactsRow {
  id: string;
  canonicalName: string;
  brand: string | null;
  line: string | null;
  brandId: string | null;
  lineId: string | null;
  blendId: string | null;
  vitolaName: string | null;
  nameSource: CigarNameSource;
  type: "NC" | "CC" | null;
  manufacturer: string | null;
  verification: "verified" | "unverified";
  createdAt: Date;
  heldLots: number;
}

// Purchase lots pointing at a cigar, all users (#169). Every worklist row carries
// it so the exclude guard is ANTICIPABLE: without it the agent cannot tell a held
// row from a pile of gift cards and only learns by refusal, once per row, every
// run. A correlated subquery rather than a join — the page is bounded by `limit`,
// and a join would need a GROUP BY over the whole predicate.
//
// The outer column is written with sql.identifier, NOT `${cigars.id}`: in a SELECT
// LIST position drizzle renders a column reference UNQUALIFIED ("id"), which inside
// this subquery binds to `purchases p`.`id` instead of the cigar — a correlated
// subquery that silently counts nothing. (It qualifies correctly in a WHERE, which
// is what makes the bug easy to miss.) Verified against the embedded Postgres.
const heldLotsSql = sql<number>`(SELECT count(*) FROM purchases p WHERE p.cigar_id = ${sql.identifier("cigars")}.${sql.identifier("id")})::int`;

function toWorklistCigar(row: CigarFactsRow): WorklistCigar {
  return {
    cigarId: row.id,
    canonicalName: row.canonicalName,
    brand: row.brand,
    line: row.line,
    brandId: row.brandId,
    lineId: row.lineId,
    blendId: row.blendId,
    vitola: row.vitolaName,
    nameSource: row.nameSource,
    type: row.type,
    manufacturer: row.manufacturer,
    verification: row.verification,
    createdAt: row.createdAt.toISOString(),
    heldLots: row.heldLots,
  };
}

// A page of active cigars matching a kind-specific predicate, keyset-ordered by
// (createdAt, id) so the agent walks the whole backlog deterministically. Shared
// by unverified / unbranded / untyped / missing_photos — only the predicate differs.
async function cigarWorklistPage(
  db: Database,
  predicate: SQL,
  cursor: [string, string] | null,
  limit: number,
): Promise<{ cigars: WorklistCigar[]; nextCursor: string | null }> {
  // The cursor carries the boundary row's created_at as its FULL-precision Postgres
  // text (::text), not a JS ISO string — a Date is only millisecond-precise, but
  // the column is microsecond-precise, so an ISO cursor would truncate and re-admit
  // the boundary row on the next page. The text round-trips through ::timestamptz
  // exactly, so the keyset is gap-free and overlap-free.
  const keyset = cursor
    ? sql`(${cigars.createdAt}, ${cigars.id}) > (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
    : sql`true`;
  const rows = await db
    .select({
      id: cigars.id,
      canonicalName: cigars.canonicalName,
      brand: cigars.brand,
      line: cigars.line,
      brandId: cigars.brandId,
      lineId: cigars.lineId,
      blendId: cigars.blendId,
      vitolaName: cigars.vitolaName,
      nameSource: cigars.nameSource,
      type: cigars.type,
      manufacturer: cigars.manufacturer,
      verification: cigars.verification,
      createdAt: cigars.createdAt,
      createdAtText: sql<string>`${cigars.createdAt}::text`,
      heldLots: heldLotsSql,
    })
    .from(cigars)
    .where(and(eq(cigars.catalogStatus, "active"), predicate, keyset))
    .orderBy(asc(cigars.createdAt), asc(cigars.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeWorklistCursor([last.createdAtText, last.id]) : null;
  return { cigars: page.map(toWorklistCigar), nextCursor };
}

// A page of vendor listings awaiting triage, in BOTH shapes the crawler produces.
// The listing side (vendor name, key, latest offer URL) and the resolver's guessed
// cigar facts sit side by side so a verdict is judgeable without another read.
// Keyset-ordered by the match's (createdAt, id).
//
// THIS READ USED TO SHOW ONLY `status='auto'`, and that made the crawler's own
// refusals invisible. #170 gave the resolver a third answer — a candidate cleared
// the similarity floor and was DECLINED because the vendor's focus contradicts the
// cigar's evidenced market — and routed it here, "to the triage queue a curator
// already works". It was not routed anywhere: a refusal writes `unmatched`, this
// read filtered `unmatched` out, and the claim was false in the code, the CLI
// output and the PR body alike. Prod was carrying 3 such rows already, from the
// ordinary no-match path, and no surface in the system named them.
//
// WHAT IS ADMITTED, and each exclusion is load-bearing:
//   * `status='auto'` — the proposed links, as before.
//   * `status='unmatched'` with `decided_by='crawler'` AND a reason set — the
//     resolver's own non-links (0025). The reason column is what distinguishes
//     them from the excludeCigar cascade (#126), which also leaves
//     crawler-decided `unmatched` rows behind and whose whole point was to remove
//     20 gift-card listings from this queue FOR GOOD. Keying on `decided_by`
//     alone would have resurrected them.
//   * NOT `decided_by` in ('curator', 'agent') — 591 rows on prod. Those are
//     SETTLED DECISIONS. A queue that re-asks a question a human already answered
//     is worse than one that never asked.
//
// WHAT A CURATOR CAN DO WITH AN UNMATCHED ROW IS DEFERRED (Wave 2, matching v2).
// `setListingMatchStatus` takes `confirmed | unmatched` and confirms whatever
// cigar the row already points at — which for these rows is nothing, so there is
// no verdict to give yet. The resolution verbs (link-to-cigar, create-from-listing)
// are a matching-v2 question, not a visibility one. Making the rows VISIBLE is
// what this read is for: a refusal cluster from one vendor is the signal that its
// `vendors.focus` is wrong, which is the defect that started #170, and it was
// unobservable.
async function matchTriagePage(
  db: Database,
  cursor: [string, string] | null,
  limit: number,
): Promise<{ matches: WorklistMatch[]; nextCursor: string | null }> {
  const keyset = cursor
    ? sql`AND (lm.created_at, lm.id) > (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
    : sql``;
  // match_created_at_text is the boundary cursor at full Postgres precision (see the
  // cigarWorklistPage note on the ms-truncation trap).
  const result = await db.execute(sql`
    SELECT lm.id AS match_id, lm.listing_key, lm.created_at::text AS match_created_at_text,
           lm.status, lm.unmatched_reason, lm.suggested_parse,
           v.name AS vendor_name,
           (SELECT o.listing_url FROM offers o
              WHERE o.listing_match_id = lm.id
              ORDER BY o.seen_at DESC LIMIT 1) AS listing_url,
           c.id AS cigar_id, c.canonical_name, c.brand, c.line, c.type,
           c.brand_id, c.line_id, c.blend_id, c.vitola_name, c.name_source,
           c.manufacturer, c.verification, c.created_at AS cigar_created_at,
           -- Same held-lot count the other worklist kinds carry (#169), so a
           -- match_triage row reports it too and WorklistCigar has one shape
           -- everywhere rather than a field that is sometimes absent.
           (SELECT count(*) FROM purchases p WHERE p.cigar_id = c.id)::int AS held_lots
    FROM listing_matches lm
    JOIN vendors v ON v.id = lm.vendor_id
    LEFT JOIN cigars c ON c.id = lm.cigar_id
    -- Only matches whose cigar is still active surface for triage: a match pointing
    -- at an excluded/merged cigar must not resurface (DESIGN-003 §Curation, #126).
    -- A null-cigar 'auto' row (defensive — the resolver links one) still shows, and
    -- an unmatched row has no cigar by construction.
    WHERE (
            lm.status = 'auto'
            OR (lm.status = 'unmatched' AND lm.decided_by = 'crawler' AND lm.unmatched_reason IS NOT NULL)
          )
      AND (c.id IS NULL OR c.catalog_status = 'active') ${keyset}
    ORDER BY lm.created_at ASC, lm.id ASC
    LIMIT ${limit + 1}
  `);
  const rows = result.rows as unknown as {
    match_id: string;
    listing_key: string;
    match_created_at_text: string;
    status: "auto" | "unmatched";
    unmatched_reason: "market_refusal" | "no_match" | "no_anchor" | "ambiguous" | null;
    suggested_parse: SuggestedParse | null;
    vendor_name: string;
    listing_url: string | null;
    cigar_id: string | null;
    canonical_name: string | null;
    brand: string | null;
    line: string | null;
    brand_id: string | null;
    line_id: string | null;
    blend_id: string | null;
    vitola_name: string | null;
    name_source: CigarNameSource | null;
    type: "NC" | "CC" | null;
    manufacturer: string | null;
    verification: "verified" | "unverified" | null;
    cigar_created_at: Date | null;
    held_lots: number | null;
  }[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeWorklistCursor([last.match_created_at_text, last.match_id]) : null;

  const matches: WorklistMatch[] = page.map((r) => ({
    matchId: r.match_id,
    vendorName: r.vendor_name,
    listingKey: r.listing_key,
    listingUrl: r.listing_url,
    status: r.status,
    // Absent on an `auto` row rather than null: an unmatched row always has one
    // (the read admits no other kind), so present-vs-absent tracks the two shapes.
    ...(r.unmatched_reason != null ? { reason: r.unmatched_reason } : {}),
    // Absent rather than null when the resolver recorded none, matching how
    // `reason` distinguishes "no value" from "not applicable" on this row.
    ...(r.suggested_parse != null ? { suggestedParse: r.suggested_parse } : {}),
    cigar:
      r.cigar_id != null
        ? {
            cigarId: r.cigar_id,
            canonicalName: r.canonical_name ?? "",
            brand: r.brand,
            line: r.line,
            brandId: r.brand_id,
            lineId: r.line_id,
            blendId: r.blend_id,
            vitola: r.vitola_name,
            nameSource: r.name_source ?? "freeform",
            type: r.type,
            manufacturer: r.manufacturer,
            verification: r.verification ?? "unverified",
            createdAt: r.cigar_created_at ? new Date(r.cigar_created_at).toISOString() : "",
            heldLots: r.held_lots ?? 0,
          }
        : null,
  }));
  return { matches, nextCursor };
}

// A page of near-duplicate name pairs (human-merge candidates). Unlike the legacy
// curationQueue (which orders by similarity DESC, unpaged), this is keyset-ordered
// by (a.id, b.id) so the whole set is pageable. The resolver's strong-link guard
// post-filters within the raw page window; nextCursor advances off the last RAW
// candidate examined, so the post-filter can under-fill a page without ever
// skipping or repeating a pair.
async function duplicatesPage(
  db: Database,
  cursor: [string, string] | null,
  limit: number,
): Promise<{ duplicates: DuplicateCandidatePair[]; nextCursor: string | null }> {
  const keyset = cursor ? sql`AND (c1.id, c2.id) > (${cursor[0]}::uuid, ${cursor[1]}::uuid)` : sql``;
  const pairResult = await db.execute(sql`
    SELECT c1.id AS a_id, c2.id AS b_id,
           c1.canonical_name AS a_name, c2.canonical_name AS b_name,
           similarity(c1.canonical_name, c2.canonical_name) AS sim
    FROM cigars c1
    JOIN cigars c2 ON c1.id < c2.id AND c1.canonical_name % c2.canonical_name
    WHERE c1.catalog_status = 'active' AND c2.catalog_status = 'active'
      AND similarity(c1.canonical_name, c2.canonical_name) > ${DUPLICATE_THRESHOLD}
      AND NOT EXISTS (
        SELECT 1 FROM duplicate_dismissals d
        WHERE d.cigar_a_id = c1.id AND d.cigar_b_id = c2.id
      )
      ${keyset}
    ORDER BY c1.id ASC, c2.id ASC
    LIMIT ${limit + 1}
  `);
  const rawRows = pairResult.rows as unknown as {
    a_id: string;
    b_id: string;
    a_name: string;
    b_name: string;
    sim: number;
  }[];

  const hasMore = rawRows.length > limit;
  const windowRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const last = windowRows[windowRows.length - 1];
  const nextCursor = hasMore && last ? encodeWorklistCursor([last.a_id, last.b_id]) : null;

  const pairRows = windowRows.filter((p) => strongLinkCompatible(p.a_name, p.b_name));
  const ids = new Set<string>();
  for (const p of pairRows) {
    ids.add(p.a_id);
    ids.add(p.b_id);
  }
  const meta = await queueCigarsByIds(db, [...ids]);
  const duplicates = pairRows
    .map((p) => {
      const a = meta.get(p.a_id);
      const b = meta.get(p.b_id);
      return a && b ? { similarity: Number(p.sim), a, b } : null;
    })
    .filter((p): p is DuplicateCandidatePair => p != null);
  return { duplicates, nextCursor };
}

// The paged worklist read. Exactly one payload array is populated per kind. Gated
// to curators like every curation service — a non-admin principal is rejected
// before any query runs.
export async function curationWorklist(
  deps: Deps,
  principal: Principal,
  input: CurationWorklistInput,
): Promise<CurationWorklistResult> {
  assertCurator(principal);
  const db = deps.db;
  const limit = Math.min(Math.max(input.limit ?? WORKLIST_DEFAULT_LIMIT, 1), WORKLIST_MAX_LIMIT);
  // Only the duplicates lane pairs two cigar ids; every other kind leads with the
  // boundary row's created_at.
  const cursor = decodeWorklistCursor(input.cursor, input.kind === "duplicates" ? "uuid" : "instant");

  switch (input.kind) {
    case "unverified": {
      const page = await cigarWorklistPage(db, eq(cigars.verification, "unverified"), cursor, limit);
      return { kind: input.kind, cigars: page.cigars, nextCursor: page.nextCursor };
    }
    // THE STRUCTURAL LADDER (ADR-012 Wave 3). Each rung is "has the level above,
    // lacks this one", so a row appears in exactly one of the three at a time and
    // moves down as it is structured. `unbranded` keys on `brand_id`, NOT on the
    // free-text `brand`: the column that decides whether the catalog can navigate
    // to the row is the FK, and a row spelled `Padrón` with a null link is exactly
    // the work this queue exists to hand out.
    case "unbranded": {
      const page = await cigarWorklistPage(db, isNull(cigars.brandId), cursor, limit);
      return { kind: input.kind, cigars: page.cigars, nextCursor: page.nextCursor };
    }
    case "unlined": {
      const page = await cigarWorklistPage(
        db,
        and(isNotNull(cigars.brandId), isNull(cigars.lineId))!,
        cursor,
        limit,
      );
      return { kind: input.kind, cigars: page.cigars, nextCursor: page.nextCursor };
    }
    case "unblended": {
      const page = await cigarWorklistPage(
        db,
        and(isNotNull(cigars.lineId), isNull(cigars.blendId))!,
        cursor,
        limit,
      );
      return { kind: input.kind, cigars: page.cigars, nextCursor: page.nextCursor };
    }
    case "untyped": {
      const page = await cigarWorklistPage(db, isNull(cigars.type), cursor, limit);
      return { kind: input.kind, cigars: page.cigars, nextCursor: page.nextCursor };
    }
    case "missing_photos": {
      const page = await cigarWorklistPage(
        db,
        sql`NOT EXISTS (SELECT 1 FROM product_photos pp WHERE pp.cigar_id = ${cigars.id})`,
        cursor,
        limit,
      );
      return { kind: input.kind, cigars: page.cigars, nextCursor: page.nextCursor };
    }
    case "match_triage": {
      const page = await matchTriagePage(db, cursor, limit);
      return { kind: input.kind, matches: page.matches, nextCursor: page.nextCursor };
    }
    case "duplicates": {
      const page = await duplicatesPage(db, cursor, limit);
      return { kind: input.kind, duplicates: page.duplicates, nextCursor: page.nextCursor };
    }
  }
}

// --------------------------------------------------------------------------
// cigarsMissingPhotos — the "Missing photos" worklist (DESIGN-003 §Images): the
// curator's held cigars that lack a servable product photo. Curator-only.
// --------------------------------------------------------------------------

// Every active catalog cigar the CALLER holds a purchase lot for, that has no
// non-suppressed product photo — the worklist the upload path clears (the owner's
// Cuban humidor can never be crawled). Principal-scoped to the curator's own
// holdings (a suppressed-only photo counts as missing, matching the tile join's
// `rights <> 'suppressed'` gate). Highest remaining first, so what is actually in
// the humidor leads; capped like the other admin reads.
export async function cigarsMissingPhotos(deps: Deps, principal: Principal): Promise<MissingPhotoCigar[]> {
  assertCurator(principal);
  const result = await deps.db.execute(sql`
    SELECT c.id AS cigar_id, c.canonical_name, c.brand,
           greatest(coalesce(pur.acquired, 0) - coalesce(con.consumed, 0), 0)::int AS remaining
    FROM cigars c
    JOIN (
      SELECT cigar_id, sum(quantity)::int AS acquired
      FROM purchases WHERE user_id = ${principal.userId}
      GROUP BY cigar_id
    ) pur ON pur.cigar_id = c.id
    LEFT JOIN (
      SELECT s2.cigar_id, count(sc.smoke_id)::int AS consumed
      FROM smokes s2 JOIN smoke_consumptions sc ON sc.smoke_id = s2.id
      WHERE s2.user_id = ${principal.userId}
      GROUP BY s2.cigar_id
    ) con ON con.cigar_id = c.id
    WHERE c.catalog_status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM product_photos pp
        WHERE pp.cigar_id = c.id AND pp.rights <> 'suppressed'
      )
    ORDER BY remaining DESC, c.canonical_name ASC
    LIMIT ${MISSING_PHOTOS_CAP}
  `);
  const rows = result.rows as unknown as {
    cigar_id: string;
    canonical_name: string;
    brand: string | null;
    remaining: number;
  }[];
  return rows.map((r) => ({
    cigarId: r.cigar_id,
    canonicalName: r.canonical_name,
    brand: r.brand,
    remaining: Number(r.remaining),
  }));
}

// --------------------------------------------------------------------------
// queueEnrichmentBacklog — bulk-enqueue the photoless-holdings worklist (#154).
// --------------------------------------------------------------------------

// A press drains the "Missing photos" section into enrichment_requests, which the
// crawler's enrich runs consume. It replaces calling request_cigar_enrichment 55
// times by hand; the console button and the curate agent's MCP tool both land here.
//
// Selection is cigarsMissingPhotos itself — the SAME read the section renders — so
// the number on screen is the number queued. That matters beyond tidiness: the
// worklist gates on `rights <> 'suppressed'` while curationWorklist's missing_photos
// kind uses a bare NOT EXISTS, so the two diverge the first time a rights takedown
// lands, and a taken-down photo must re-queue rather than silently vanish.
//
// The per-row verdict comes from classifyEnrichmentRequest (enrichment.ts), so this
// report and request_cigar_enrichment speak one vocabulary. It is deliberately NOT
// maybeQueueEnrichment: that returns a bare boolean (it cannot say WHY a row was
// skipped) and its dedupe misses `in_progress`.
//
// Enveloped (ADR-003) where request_cigar_enrichment is deliberately bare: a bulk
// press is a batch effect worth replaying identically, and a button can be
// double-clicked. Not in REVERSIBLE_ACTIONS — the inverse (deleting a pending
// request) has no user-visible value, so the run shows with no Undo by design.
//
// TWO PRECONDITIONS ARE ENFORCED, NOT DOCUMENTED. A queued request that cannot be
// served is not inert: every drain that looks and misses spends one of that
// VENDOR'S two attempts against the request (ATTEMPTS_PER_VENDOR, migration 0023),
// and a request retires once every lane that runs is spent. So a press only writes
// a row when both hold, and reports every other row with the reason:
//
//   1. `unverified_name` — drainEnrichment resolves BY canonical name twice over
//      (slug-token ranking, then a pg_trgm similarity floor), so a name nobody has
//      reviewed is a request that misses and burns an attempt AT EVERY VENDOR that
//      looks at it. `verified` is the existing curator signal for "a human or agent
//      read this row" (only verifyCigar sets it), so it is the gate. Fix the name
//      with rename_cigar, verify it, then press.
//   2. `no_vendor_coverage` — a market with no enrich lane running cannot serve
//      any request. See liveEnrichMarkets (enrichment-coverage.ts). Note this is
//      the SAME liveness the exhaustion denominator uses, read as markets rather
//      than as vendors.
//
// The gate and the exhaustion denominator are ONE predicate read at two
// granularities: LIVE — crawl-enabled, focus covers the market, and the lane has
// completed an `enrich` run — as markets here (one fleet-wide read) and as vendors
// in the rollup (per row, because eligibility depends on the cigar's market).
// `crawl_enabled` alone is not either of them: no crawler consults that flag
// (#156), so enabling a vendor schedules nothing — one with a suspended CronJob
// would gate nothing and retire nothing while holding every matching request open
// forever.
//
// There is no circularity in using liveness as the denominator, because the drain
// does NOT gate on it: its open set admits `exhausted` rows and its only
// per-vendor filter is that vendor's own budget, so a lane that has never run
// still picks work up on its first night and reopens what it has not looked at.
//
// Neither has an override argument. The way past them is to do the thing they
// assert; a flag would just be the old footgun with a longer name.
export const ENRICHMENT_BACKLOG_MAX = 100;

// The cap covers today's backlog with headroom and refuses to become a 900-row
// self-inflicted crawl. One transaction over up to this many rows stays short-lived;
// raising the ceiling means batching the writes, not just raising the number.
function clampBacklogLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return ENRICHMENT_BACKLOG_MAX;
  return Math.min(Math.max(Math.trunc(limit), 1), ENRICHMENT_BACKLOG_MAX);
}

// An untyped cigar could be either market, so it needs BOTH covered — enrichment is
// what would tell us which, and guessing is how the 41 CC rows would get retired.
//
// THIS DELIBERATELY STILL READS `cigars.type`, not the evidenced market (#170
// §7). It is the QUEUE GATE, a conservative positive claim, and it is the only
// one of the three predicates that decides how much crawling to CREATE. On the
// evidenced market it would accept prod's 821 Fox-evidenced untyped rows the
// moment it shipped: ~800 new asks and, at ENRICH_DEFAULT_LIMIT = 50 a night,
// weeks of nightly Fox drains. That is a crawl-volume and vendor-courtesy
// decision, not a correctness one, and it belongs in its own PR with the owner's
// sign-off. The cost of leaving it is a real and stated inconsistency — the
// enqueue gate and the exhaustion denominator now read the market from two
// different sources — which is defensible only because they are different
// predicates with opposite postures, and is written into ADR-006 rather than left
// implicit here.
function marketCovered(type: CigarType | null, markets: Set<CigarType>): boolean {
  if (type === "CC" || type === "NC") return markets.has(type);
  return markets.has("CC") && markets.has("NC");
}

// The per-row verdict. Ordered so the report answers the curator's actual question:
// what stopped this row, given everything else was fine.
function backlogStatus(
  classified: EnrichmentClassification,
  markets: Set<CigarType>,
  retryExhausted: boolean,
): EnrichmentBacklogStatus {
  // Not a queue decision at all: nothing to fill, or a live request already exists.
  if (classified.status === "not_needed" || classified.status === "already_queued") {
    return classified.status;
  }
  // A row the crawler retired is reported, not re-queued, unless asked for. Since
  // migration 0023 "retired" means retired AT EVERY LANE THAT RUNS, computed from
  // the per-vendor ledger rather than read off enrichment_requests.status — so a
  // lane going live reopens the row on its own and this verdict stops firing, with
  // no reopen job and no backfill. The entry names the vendors that looked.
  //
  // This deliberately outranks `recently_enriched`: ingest marks a request
  // `fulfilled` on a name match even when the photo capture threw, so
  // exhausted-AND-fulfilled is reachable for exactly the rows most likely to need
  // the retry — keying the override off `status === "queued"` alone made it inert
  // there.
  if (classified.exhausted && !retryExhausted) return "exhausted";
  // Retired without anybody finishing a look. Reported apart from `exhausted`
  // (#158 review) because the two say opposite things about the catalogue, and
  // reported at all because the alternative — letting it fall through to
  // `already_queued` — is an invisible row no operator can act on.
  if (classified.blocked && !retryExhausted) return "vendor_unreachable";
  if (!classified.exhausted && !classified.blocked && classified.status === "recently_enriched") {
    return "recently_enriched";
  }
  // Preconditions for an actual insert.
  if (classified.cigar.verification !== "verified") return "unverified_name";
  if (!marketCovered(classified.cigar.type, markets)) return "no_vendor_coverage";
  return "queued";
}

export async function queueEnrichmentBacklog(
  deps: Deps,
  principal: Principal,
  input: QueueEnrichmentBacklogInput,
): Promise<QueueEnrichmentBacklogResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);
  const limit = clampBacklogLimit(input.limit);

  // The worklist read runs before the write transaction opens (it is the console's
  // own read, which takes Deps). Every candidate is re-classified INSIDE the tx, so
  // a row that gained a photo or a queue entry in between is reported, not
  // double-queued.
  const worklist = await cigarsMissingPhotos(deps, principal);
  const candidates = worklist.slice(0, limit);

  try {
    return await deps.db.transaction((tx) =>
      queueBacklogWithinTx(tx, principal, input, requestFingerprint, worklist.length, candidates),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as QueueEnrichmentBacklogResult), replayed: true };
      }
    }
    throw error;
  }
}

async function queueBacklogWithinTx(
  tx: Tx,
  principal: Principal,
  input: QueueEnrichmentBacklogInput,
  requestFingerprint: string,
  eligible: number,
  candidates: MissingPhotoCigar[],
): Promise<QueueEnrichmentBacklogResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as QueueEnrichmentBacklogResult), replayed: true };
  }

  // Market coverage is fleet-wide, so it is read ONCE here rather than per row.
  // The rest is not amortized and should not be read as if it were: each candidate
  // runs its own classifyEnrichmentRequest, which is a vendor-fleet read, an
  // enrichment_requests read and a ledger join, because both the vendor set and
  // the rollup depend on that row's market. At ENRICHMENT_BACKLOG_MAX = 100 that
  // is a few hundred round-trips inside one transaction — fine at prod's scale
  // (63 photoless cigars) and the reason raising the cap means batching the reads,
  // not just raising the number. The same three reads land on the add_cigar /
  // record_purchase path through maybeQueueEnrichment.
  const markets = await liveEnrichMarkets(tx);

  const eligibleVendors = new Set<string>();
  const entries: EnrichmentBacklogEntry[] = [];
  for (const candidate of candidates) {
    const classified = await classifyEnrichmentRequest(tx, candidate.cigarId);
    const status = backlogStatus(classified, markets, input.retryExhausted === true);
    for (const vendor of classified.coverage.eligible) eligibleVendors.add(vendor.name);

    if (status === "queued") {
      await tx.insert(enrichmentRequests).values({
        cigarId: candidate.cigarId,
        requestedBy: principal.userId,
      });
      // One audit row per INSERT (never for a skip), so "Recent agent runs" shows
      // exactly what the press changed, attributed to the run.
      await tx.insert(auditLog).values({
        userId: principal.userId,
        ...auditAttribution(principal, input.attribution),
        action: "cigar.enrichment_request",
        smokeId: null,
        before: null,
        after: { cigarId: candidate.cigarId, missingFields: classified.assessment.missingFields },
        correlationId: input.correlationId ?? input.clientRequestId,
      });
    }

    entries.push({
      cigarId: candidate.cigarId,
      canonicalName: candidate.canonicalName,
      status,
      // Only on the two retirement verdicts: everywhere else the vendor list is
      // either irrelevant (nothing was tried) or already implied by the verdict,
      // and an always-present array would push noise through the MCP payload for
      // 100 rows a press.
      ...(status === "exhausted" || status === "vendor_unreachable"
        ? { triedVendors: classified.coverage.tried.map((v) => v.name) }
        : {}),
      // ...and its mirror on the one verdict that is not a retirement (#185). An
      // `already_queued` row held open by a lane that stopped running was
      // indistinguishable, on this report, from one being worked through tonight.
      // Naming the lanes that owe it a look is what makes the operator's two
      // levers — unsuspend, or `crawl_enabled = false` — obvious. The real fix is
      // #156; this is the honest report until then.
      ...(status === "already_queued" && classified.coverage.awaiting.length > 0
        ? { awaitingVendors: classified.coverage.awaiting.map((v) => v.name) }
        : {}),
      // ...and the third reading (#209), on the same verdict. A lane that found
      // the cigar and was refused its photo slot holds the ask open without ever
      // being able to close it — no attempt is burned, so it cannot retire, and
      // the refusal is structural, so it recurs every crawl. On this report that
      // was an `already_queued` indistinguishable from one being worked tonight.
      ...(status === "already_queued" && classified.coverage.photoRefused.length > 0
        ? { photoRefusedVendors: classified.coverage.photoRefused.map((v) => v.name) }
        : {}),
    });
  }

  const queued = entries.filter((e) => e.status === "queued").length;
  const result: QueueEnrichmentBacklogResult = {
    eligible,
    considered: candidates.length,
    queued,
    skipped: entries.length - queued,
    enrichedMarkets: [...markets].sort(),
    eligibleVendors: [...eligibleVendors].sort(),
    entries,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "queue_enrichment_backlog",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// Recent agent runs + Undo (DESIGN-003 §Curation review console, #126). Two
// reads (grouped runs, a run's rows) and one write (undo an action by its inverse).
// --------------------------------------------------------------------------

// The actions with a TRUE inverse — the only ones the review offers an Undo for.
// Dismiss has none. Two are conditional on the data the forward action recorded:
// set_facts needs its audit to carry the cigar id (recorded from wave 4b on), and
// merge needs its `cigar_merges` ledger (migration 0020) — a legacy row of either
// kind has nothing to reverse onto and reports non-reversible (state, not a button).
const REVERSIBLE_ACTIONS = new Set([
  "cigar.exclude",
  "cigar.verify",
  "listing_match.set_status",
  "product_photo.set_rights",
  "cigar.set_facts",
  "cigar.rename",
  "cigar.merge",
]);

// `live` carries the per-row facts the audit JSONB cannot answer on its own: an
// unspent merge ledger, and whether a rename is still the cigar's current name.
// Absent (the undo path, which re-checks against the loaded row) they default to
// permissive — applyInverse is the gate that must not be bypassed, this one keeps
// the console from offering a button that would error.
function isReversibleAudit(
  action: string,
  before: Record<string, unknown>,
  live: { hasLedger?: boolean; nameIsCurrent?: boolean } = {},
): boolean {
  if (!REVERSIBLE_ACTIONS.has(action)) return false;
  if (action === "cigar.set_facts") return typeof before.id === "string";
  if (action === "cigar.merge") return live.hasLedger === true;
  if (action === "cigar.rename") return live.nameIsCurrent !== false;
  return true;
}

// A compact "before → after" line for one audit row, per action. Data-derived (not
// chrome), so the review row reads at a glance without opening the raw JSONB.
function fmtValue(v: unknown): string {
  return v == null ? "—" : String(v);
}

function summarizeAudit(action: string, before: Record<string, unknown>, after: Record<string, unknown>): string | null {
  switch (action) {
    case "cigar.exclude":
      return `${fmtValue(before.catalogStatus ?? "active")} → ${fmtValue(after.catalogStatus ?? "excluded")}`;
    case "cigar.restore":
      return `${fmtValue(before.catalogStatus ?? "excluded")} → ${fmtValue(after.catalogStatus ?? "active")}`;
    case "cigar.verify":
      return `${fmtValue(before.verification ?? "unverified")} → verified`;
    case "cigar.unverify":
      return `${fmtValue(before.verification ?? "verified")} → unverified`;
    case "listing_match.set_status":
      return `${fmtValue(before.status ?? "auto")} → ${fmtValue(after.status)}`;
    case "product_photo.set_rights":
      return `${fmtValue(before.rights)} → ${fmtValue(after.rights)}`;
    case "cigar.rename":
      return `${fmtValue(before.canonicalName)} → ${fmtValue(after.canonicalName)}`;
    case "cigar.merge": {
      const source = (before.source ?? {}) as Record<string, unknown>;
      const target = (before.target ?? {}) as Record<string, unknown>;
      return `${fmtValue(source.canonicalName)} → ${fmtValue(target.canonicalName)}`;
    }
    // A bulk enqueue lands one row per cigar (#154); without this case every row of
    // a press renders blank.
    case "cigar.enrichment_request": {
      const missing = Array.isArray(after.missingFields) ? after.missingFields.map(fmtValue) : [];
      return missing.length > 0 ? `queued · missing ${missing.join(", ")}` : "queued";
    }
    case "cigar.set_facts": {
      const parts = Object.keys(after)
        .filter((k) => k !== "id")
        .map((k) => `${k}: ${fmtValue(before[k])} → ${fmtValue(after[k])}`);
      return parts.length > 0 ? parts.join("; ") : null;
    }
    // The taxonomy registry (ADR-012). Wave 2 wrote these actions with no console
    // case, so every registry write rendered as a blank row — invisible in exactly
    // the surface a curation run is reviewed through. Wave 3 turns them on.
    case "brand.create":
    case "line.create":
    case "blend.create":
    case "blender.create":
      return `minted ${fmtValue(after.name)}`;
    case "brand.set_aliases":
    case "line.set_aliases":
    case "blend.set_aliases":
    case "blender.set_aliases": {
      const added = Array.isArray(after.added) ? after.added.map(fmtValue) : [];
      const removed = Array.isArray(after.removed) ? after.removed.map(fmtValue) : [];
      const parts = [
        ...(added.length > 0 ? [`+${added.join(" +")}`] : []),
        ...(removed.length > 0 ? [`-${removed.join(" -")}`] : []),
      ];
      return parts.length > 0 ? `${fmtValue(after.name)}: ${parts.join(" ")}` : null;
    }
    case "blend.credit_blender":
      return "blender credited";
    case "cigar.assign_parts": {
      const parts = Object.keys(after)
        .filter((k) => k !== "id" && k !== "canonicalName")
        .map((k) => `${k}: ${fmtValue(before[k])} → ${fmtValue(after[k])}`);
      const renamed =
        before.canonicalName !== after.canonicalName
          ? `name: ${fmtValue(before.canonicalName)} → ${fmtValue(after.canonicalName)}`
          : null;
      const all = [...parts, ...(renamed != null ? [renamed] : [])];
      return all.length > 0 ? all.join("; ") : null;
    }
    case "cigar.split": {
      const splits = Array.isArray(after.splits) ? after.splits : [];
      return `${fmtValue(before.canonicalName)} → ${splits.length} leaves, ${fmtValue(after.remainingListings)} listings left`;
    }
    case "cigar.split_leaf":
      return `${fmtValue(before.canonicalName)} → ${fmtValue(after.canonicalName)}`;
    // External review scores (ADR-013, migration 0028). `recordReviewObservation`
    // writes these itself — it has no caller that would — so without a case here
    // every review an enrichment agent brought back would render as a blank row
    // in the run it was brought back by, which is the same defect the taxonomy
    // actions had above.
    case "review.record":
      return `${fmtValue(after.source)} · ${fmtValue(after.nativeScore)} (${fmtValue(after.nativeScale)}) → ${fmtValue(after.normalizedScore)}`;
    // What the source CHANGED — the whole reason an amendment is a separate
    // action. Field by field, and only the fields that moved: a reviewer who
    // swapped the pull quote under an unchanged score should read as exactly
    // that. `before` and `after` carry the same key set, which is what makes the
    // comparison total rather than a guess about which half is authoritative.
    case "review.amend": {
      const moved = ["normalizedScore", "nativeScore", "nativeScale", "reviewedAt", "excerpt", "reviewer"]
        .filter((k) => fmtValue(before[k]) !== fmtValue(after[k]))
        .map((k) => `${k}: ${fmtValue(before[k])} → ${fmtValue(after[k])}`);
      // Only the target moved (a re-point), or the writer amended nothing it
      // records — say so rather than rendering an empty line.
      return moved.length > 0
        ? `${fmtValue(after.source)} · ${moved.join("; ")}`
        : `${fmtValue(after.source)} · re-pointed`;
    }
    default:
      return null;
  }
}

// Recent agent runs, newest first (by last action): the run key, its action tally,
// span, and total. Grouped from audit_log by run_id where actor='agent'. Two bounded
// reads — the top runs by recency, then per-action counts for exactly those runs.
const AGENT_RUNS_CAP = 50;

export async function agentRuns(deps: Deps, principal: Principal): Promise<AgentRunsResult> {
  assertCurator(principal);

  const runResult = await deps.db.execute(sql`
    SELECT run_id,
           count(*)::int AS total,
           min(created_at)::text AS first_at,
           max(created_at)::text AS last_at
    FROM audit_log
    WHERE actor = 'agent' AND run_id IS NOT NULL
    GROUP BY run_id
    ORDER BY max(created_at) DESC
    LIMIT ${AGENT_RUNS_CAP}
  `);
  const runRows = runResult.rows as unknown as {
    run_id: string;
    total: number;
    first_at: string;
    last_at: string;
  }[];
  if (runRows.length === 0) return { runs: [] };

  const ids = runRows.map((r) => r.run_id);
  const countResult = await deps.db.execute(sql`
    SELECT run_id, action, count(*)::int AS n
    FROM audit_log
    WHERE actor = 'agent' AND run_id IN (${sql.join(ids, sql`, `)})
    GROUP BY run_id, action
  `);
  const countRows = countResult.rows as unknown as { run_id: string; action: string; n: number }[];
  const byRun = new Map<string, AgentRunActionCount[]>();
  for (const c of countRows) {
    const arr = byRun.get(c.run_id) ?? [];
    arr.push({ action: c.action, count: Number(c.n) });
    byRun.set(c.run_id, arr);
  }

  const runs: AgentRunSummary[] = runRows.map((r) => ({
    runId: r.run_id,
    total: Number(r.total),
    actions: (byRun.get(r.run_id) ?? []).sort(
      (a, b) => b.count - a.count || a.action.localeCompare(b.action),
    ),
    firstAt: new Date(r.first_at).toISOString(),
    lastAt: new Date(r.last_at).toISOString(),
  }));
  return { runs };
}

// One run's rows, newest first, keyset-paged by (created_at, id). Each row carries
// its target (a cigar canonical name, resolved by direct id even for an excluded
// cigar; else a listing key), a compact before→after summary, and whether it can
// still be undone (a true inverse exists AND no undo already links back). Only
// actor='agent' rows of the run — a human Undo (actor 'web', no run_id) never appears.
const RUN_ROWS_DEFAULT_LIMIT = 100;
const RUN_ROWS_MAX_LIMIT = 500;

export async function agentRunRows(
  deps: Deps,
  principal: Principal,
  input: AgentRunRowsInput,
): Promise<AgentRunRowsResult> {
  assertCurator(principal);
  const limit = Math.min(Math.max(input.limit ?? RUN_ROWS_DEFAULT_LIMIT, 1), RUN_ROWS_MAX_LIMIT);
  const cursor = decodeWorklistCursor(input.cursor, "instant");
  const keyset = cursor
    ? sql`AND (a.created_at, a.id) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
    : sql``;

  const result = await deps.db.execute(sql`
    SELECT a.id, a.action, a.created_at::text AS created_at_text, a.confidence,
           a.before, a.after,
           EXISTS (SELECT 1 FROM audit_log r WHERE r.reverts = a.id) AS reverted,
           cm.id IS NOT NULL AS has_live_ledger,
           -- A rename is undoable only while the cigar still carries the name it
           -- wrote: a later rename supersedes it, and writing the older name back
           -- would silently discard the newer one (canonicalName is identity).
           tc.canonical_name IS NOT DISTINCT FROM (a.after ->> 'canonicalName') AS name_is_current,
           tc.canonical_name AS target_cigar_name
    FROM audit_log a
    LEFT JOIN cigars tc ON tc.id = (
      CASE
        WHEN a.action IN ('cigar.exclude', 'cigar.verify', 'cigar.set_facts', 'cigar.rename')
          THEN nullif(a.before->>'id', '')
        WHEN a.action IN ('product_photo.set_rights', 'listing_match.set_status')
          THEN nullif(a.before->>'cigarId', '')
        WHEN a.action = 'cigar.merge'
          THEN nullif(a.after->>'tombstonedSourceId', '')
        -- An enqueue has no before-image (nothing changed on the cigar), so its
        -- target lives in after. Without this branch a bulk press (#154) renders as
        -- N identically-titled rows and the run review is unreadable.
        WHEN a.action = 'cigar.enrichment_request'
          THEN nullif(a.after->>'cigarId', '')
        -- A review ingest has no before-image on the cigar either, and its target
        -- is the leaf the reviewer named. Null for a BLEND-linked observation:
        -- that row is about the blend, and naming one of its vitolas here would
        -- invent the specificity ADR-013 §1 exists to refuse.
        WHEN a.action IN ('review.record', 'review.amend')
          THEN nullif(a.after->>'cigarId', '')
      END
    )::uuid
    -- The un-undone merge ledger, if any: merge is reversible only through it.
    -- Merges are actor 'web' today (there is no agent merge tool, and DESIGN-003
    -- keeps merges human-only), so this join only ever fires if that changes —
    -- carried so the two reversibility paths cannot drift apart.
    LEFT JOIN cigar_merges cm ON cm.audit_id = a.id AND cm.undone_at IS NULL
    WHERE a.actor = 'agent' AND a.run_id = ${input.runId} ${keyset}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit + 1}
  `);
  const rows = result.rows as unknown as {
    id: string;
    action: string;
    created_at_text: string;
    confidence: number | null;
    before: unknown;
    after: unknown;
    reverted: boolean;
    has_live_ledger: boolean;
    name_is_current: boolean;
    target_cigar_name: string | null;
  }[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeWorklistCursor([last.created_at_text, last.id]) : null;

  const out: AgentRunRow[] = page.map((r) => {
    const before = (r.before ?? {}) as Record<string, unknown>;
    const after = (r.after ?? {}) as Record<string, unknown>;
    const reverted = r.reverted === true;
    return {
      auditId: r.id,
      action: r.action,
      createdAt: new Date(r.created_at_text).toISOString(),
      confidence: r.confidence != null ? Number(r.confidence) : null,
      targetName: r.target_cigar_name ?? (before.listingKey as string | undefined) ?? null,
      summary: summarizeAudit(r.action, before, after),
      reversible:
        isReversibleAudit(r.action, before, {
          hasLedger: r.has_live_ledger === true,
          nameIsCurrent: r.name_is_current === true,
        }) && !reverted,
      reverted,
    };
  });
  return { runId: input.runId, rows: out, nextCursor };
}

// Undo one agent action by writing its inverse, linked through `reverts` (migration
// 0012). The whole check-and-reverse is one transaction, so a double request can
// never double-undo (the already-reverted guard sees the first undo's row). The
// inverse audit is actor 'web' (a human curator drove it) with no run_id, so it
// never re-enters a "Recent agent runs" list. Idempotent via the envelope.
export async function undoCurationAction(
  deps: Deps,
  principal: Principal,
  input: UndoCurationActionInput,
): Promise<UndoCurationActionResult> {
  assertCurator(principal);
  // The audit row is reached directly, so this repeats undoWithinTx's own
  // "no such action" answer before the transaction opens (./uuid.ts).
  if (!isUuid(input.auditId)) {
    throw new ValidationError([{ path: "auditId", message: "No audit action matches the given id." }]);
  }
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => undoWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as UndoCurationActionResult), replayed: true };
      }
    }
    throw error;
  }
}

async function undoWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: UndoCurationActionInput,
  requestFingerprint: string,
): Promise<UndoCurationActionResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as UndoCurationActionResult), replayed: true };
  }

  const target = (await tx.select().from(auditLog).where(eq(auditLog.id, input.auditId)).limit(1))[0];
  if (!target) {
    throw new ValidationError([{ path: "auditId", message: "No audit action matches the given id." }]);
  }
  const before = (target.before ?? {}) as Record<string, unknown>;
  // Already undone? An audit row whose `reverts` points here means the inverse
  // already ran — the review shows state, not a button, and a second distinct
  // request must not double-undo. (A replay of the SAME request short-circuited
  // above.) Checked BEFORE reversibility: an undone merge's ledger is spent, so
  // the reversibility gate would otherwise report the vaguer "cannot be undone".
  const already = (
    await tx.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.reverts, target.id)).limit(1)
  )[0];
  if (already) {
    throw new ValidationError([{ path: "auditId", message: "This action was already undone." }]);
  }
  // A merge is undoable only through a live `cigar_merges` ledger — a merge audited
  // before that ledger existed has nothing to restore and says so honestly.
  const liveLedger =
    target.action === "cigar.merge"
      ? (
          await tx
            .select({ id: cigarMerges.id })
            .from(cigarMerges)
            .where(and(eq(cigarMerges.auditId, target.id), isNull(cigarMerges.undoneAt)))
            .limit(1)
        )[0]
      : undefined;
  if (!isReversibleAudit(target.action, before, { hasLedger: liveLedger != null })) {
    throw new ValidationError([{ path: "auditId", message: "This action cannot be undone." }]);
  }

  const undoAuditId = await applyInverse(
    tx,
    deps,
    principal,
    target.id,
    target.action,
    before,
    (target.after ?? {}) as Record<string, unknown>,
    input,
  );

  const result: UndoCurationActionResult = {
    auditId: target.id,
    action: target.action,
    undoAuditId,
    replayed: false,
  };
  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "undo_curation_action",
    requestFingerprint,
    smokeId: null,
    result,
  });
  return result;
}

// Apply the inverse of one audit row and write a single audit row for it, linked
// `reverts` = the undone row's id. Returns the new audit id. Each case reverses the
// exact column the forward action set, reading the target from the `before` snapshot.
async function applyInverse(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  targetId: string,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  input: UndoCurationActionInput,
): Promise<string> {
  const correlationId = input.correlationId ?? input.clientRequestId;

  async function writeUndo(values: {
    action: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }): Promise<string> {
    const inserted = await tx
      .insert(auditLog)
      .values({
        userId: principal.userId,
        // A human curator drove the undo: actor 'web', no runId/confidence — so it
        // never re-enters a "Recent agent runs" list. Called here rather than
        // hoisted so the attribution is visible AT the insert, which is the shape
        // the audit-attribution drift test reads (#183).
        ...auditAttribution(principal, undefined),
        action: values.action,
        smokeId: null,
        before: values.before,
        after: values.after,
        reverts: targetId,
        correlationId,
      })
      .returning({ id: auditLog.id });
    return inserted[0]!.id;
  }

  switch (action) {
    case "cigar.exclude": {
      const cigarId = String(before.id);
      const current = await loadCigar(tx, cigarId);
      if (!current) throw new CigarNotFoundError();
      const prior = (before.catalogStatus as CatalogStatus | undefined) ?? "active";
      const snap = cigarSnapshot(current);
      await tx.update(cigars).set({ catalogStatus: prior, updatedAt: deps.now() }).where(eq(cigars.id, cigarId));
      return writeUndo({ action: "cigar.restore", before: snap, after: { ...snap, catalogStatus: prior } });
    }
    case "cigar.verify": {
      const cigarId = String(before.id);
      const current = await loadCigar(tx, cigarId);
      if (!current) throw new CigarNotFoundError();
      const prior = (before.verification as Verification | undefined) ?? "unverified";
      const snap = cigarSnapshot(current);
      await tx.update(cigars).set({ verification: prior, updatedAt: deps.now() }).where(eq(cigars.id, cigarId));
      return writeUndo({ action: "cigar.unverify", before: snap, after: { ...snap, verification: prior } });
    }
    case "listing_match.set_status": {
      const matchId = String(before.id);
      const match = await loadListingMatch(tx, matchId);
      if (!match) throw new ValidationError([{ path: "auditId", message: "The listing match no longer exists." }]);
      const priorStatus = (before.status as ListingMatchStatus | undefined) ?? "auto";
      const priorCigarId = (before.cigarId as string | null | undefined) ?? null;
      // RESTORED, NOT LEFT ALONE. `splitCigar` re-points a listing by writing all
      // five of these at once — cigar, status, decider, and the two evidence
      // fields it clears because a settled link must not read as a live doubt. An
      // undo that put back only the first two would hand the listing back to the
      // bucket already stamped 'confirmed' by a curator, which the split's own
      // settled-link refusal then reads as somebody's verdict and declines to
      // touch: the bucket becomes unsplittable by the tool that mis-split it.
      const priorDecidedBy = (before.decidedBy as ListingMatchRow["decidedBy"] | undefined) ?? "crawler";
      // KEY-PRESENT, NOT VALUE-NULL. Audit rows written before this snapshot
      // carried these fields say nothing about them, and writing null for
      // "unrecorded" would destroy live evidence in the name of restoring it. An
      // absent key leaves the column exactly as the narrower undo left it.
      const restoreEvidence = "unmatchedReason" in before || "suggestedParse" in before;
      const priorEvidence = restoreEvidence
        ? {
            unmatchedReason: (before.unmatchedReason as ListingMatchRow["unmatchedReason"] | undefined) ?? null,
            suggestedParse: (before.suggestedParse as SuggestedParse | null | undefined) ?? null,
          }
        : {};
      const snap = listingMatchSnapshot(match);
      await tx
        .update(listingMatches)
        .set({
          status: priorStatus,
          cigarId: priorCigarId,
          decidedBy: priorDecidedBy,
          ...priorEvidence,
          updatedAt: deps.now(),
        })
        .where(eq(listingMatches.id, matchId));
      return writeUndo({
        action: "listing_match.set_status",
        before: snap,
        after: { ...snap, status: priorStatus, cigarId: priorCigarId, decidedBy: priorDecidedBy, ...priorEvidence },
      });
    }
    case "product_photo.set_rights": {
      const photoId = String(before.id);
      const photo = (await tx.select().from(productPhotos).where(eq(productPhotos.id, photoId)).limit(1))[0];
      if (!photo) throw new PhotoNotFoundError();
      const prior = (before.rights as ProductPhotoRights | undefined) ?? "pending";
      const snap = productPhotoSnapshot(photo);
      await tx.update(productPhotos).set({ rights: prior }).where(eq(productPhotos.id, photoId));
      return writeUndo({ action: "product_photo.set_rights", before: snap, after: { ...snap, rights: prior } });
    }
    case "cigar.rename": {
      const cigarId = String(before.id);
      const current = await loadCigar(tx, cigarId);
      if (!current) throw new CigarNotFoundError();
      // The same refusal renameCigar makes, and for the same reason (ADR-012): the
      // row may have been flipped to `composed` since this rename was audited, and
      // an undo is not a licence to write what the forward path rejects — a
      // freehand string over a projection is undone by the next part change and
      // meanwhile makes the row look maintained while disagreeing with its parts.
      // Checked before the staleness gate below, which would otherwise report the
      // recomposition as a newer rename and send the curator hunting for an edit
      // nobody made.
      if (current.nameSource === "composed") {
        throw new ValidationError([
          {
            path: "canonicalName",
            message: "This cigar's name is composed from its brand, line, blend and vitola. Edit those parts instead.",
          },
        ]);
      }
      // renameCigar rejects an empty name and skips the audit entirely on a no-op,
      // so a rename audit always carries a real prior name — but the undo reads it
      // out of JSONB, so it is checked rather than trusted.
      const prior = before.canonicalName;
      if (typeof prior !== "string" || prior.trim().length === 0) {
        throw new ValidationError([{ path: "auditId", message: "This action cannot be undone." }]);
      }
      // Staleness gate. canonicalName is identity and nothing versions it, so
      // undoing a SUPERSEDED rename would write the older raw string over a newer
      // fix with no error — the daily agent renaming the same cigar twice is the
      // live shape. The undo applies only while the cigar still carries exactly
      // the name this audit produced. `agentRunRows` hides the button for the same
      // reason; this is the check that survives a stale page or a direct call.
      const applied = after.canonicalName;
      if (typeof applied === "string" && current.canonicalName !== applied) {
        throw new ValidationError([
          { path: "auditId", message: "This rename is no longer the cigar's current name." },
        ]);
      }
      await tx.update(cigars).set({ canonicalName: prior, updatedAt: deps.now() }).where(eq(cigars.id, cigarId));
      return writeUndo({
        action: "cigar.rename",
        before: { id: cigarId, canonicalName: current.canonicalName },
        after: { id: cigarId, canonicalName: prior },
      });
    }
    case "cigar.merge": {
      // Delegate to the shared restore, so undoing a merge audit and the console's
      // Unmerge cannot drift apart. No UI reaches this today: merges are actor
      // 'web' with no run_id, and `agentRunRows` — the only producer of auditIds
      // for the Undo button — lists agent rows of a run, so this branch is reached
      // only by a direct `curation.undo` call. It exists so that call is correct
      // rather than a no-op, and so an agent merge tool (DESIGN-003 keeps merges
      // human-only today) would inherit the working inverse. The ledger claim is
      // the same single-use gate, and unmergeWithinTx writes its own
      // `cigar.unmerge` audit with reverts = this row, so writeUndo is not used.
      const merge = await claimMerge(
        tx,
        deps,
        eq(cigarMerges.auditId, targetId),
        "auditId",
        "This action cannot be undone.",
      );
      const outcome = await unmergeWithinTx(tx, deps, principal, merge, correlationId);
      return outcome.undoAuditId;
    }
    case "cigar.set_facts": {
      const cigarId = String(before.id);
      const current = await loadCigar(tx, cigarId);
      if (!current) throw new CigarNotFoundError();
      const set: Partial<NewCigarRow> = {};
      const undoBefore: Record<string, unknown> = { id: cigarId };
      const undoAfter: Record<string, unknown> = { id: cigarId };
      for (const { key, column } of CIGAR_FACT_COLUMNS) {
        if (!(key in before)) continue;
        const restore = (before[key] as string | null | undefined) ?? null;
        (set as Record<string, unknown>)[column as string] = restore;
        undoBefore[key] = (current as unknown as Record<string, unknown>)[column as string] ?? null;
        undoAfter[key] = restore;
      }
      // The undo writes `brand` directly, so it owes the same re-derivation the
      // forward path does — otherwise undoing a brand correction restores the
      // old text against the new brand's id.
      if ("brand" in before) {
        set.brandId = await deriveBrandId(tx, (set.brand as string | null) ?? null);
        const ancestry = {
          brandId: (set.brandId as string | null) ?? null,
          lineId: current.lineId,
          blendId: current.blendId,
        };
        assertCigarAncestry(ancestry, await loadAncestryContext(tx, ancestry));
      }
      await tx.update(cigars).set({ ...set, updatedAt: deps.now() }).where(eq(cigars.id, cigarId));
      // Same reason as the forward path: a composed name is a projection, and a
      // part just moved.
      await recomposeCigarName(tx, cigarId, deps.now());
      return writeUndo({ action: "cigar.set_facts", before: undoBefore, after: undoAfter });
    }
    default:
      throw new ValidationError([{ path: "auditId", message: "This action cannot be undone." }]);
  }
}
