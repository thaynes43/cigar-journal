import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  auditLog,
  cigars,
  duplicateDismissals,
  smokes,
  purchases,
  listingMatches,
  offers,
  productPhotos,
  enrichmentRequests,
  wants,
  favorites,
  type CigarRow,
  type ListingMatchRow,
  type ProductPhotoRow,
  type NewCigarRow,
  type Database,
} from "@cj/db";
import type { Deps, Principal, Queryer, Tx } from "./deps.js";
import type {
  MergeCigarsInput,
  MergeCigarsResult,
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
  CurationAttribution,
  CurationWorklistInput,
  CurationWorklistResult,
  WorklistCigar,
  WorklistMatch,
  DuplicateCandidatePair,
} from "./types.js";
import { fingerprint } from "./fingerprint.js";
import { strongLinkCompatible } from "./cigar-resolution.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { CigarNotFoundError, PhotoNotFoundError, UnauthorizedError, ValidationError } from "./errors.js";

// Catalog hygiene — the curator's toolkit (ADR-006). Merge re-points every
// reference off a duplicate and deletes it; verify flips the lifecycle flag; the
// queue surfaces the unverified backlog and near-duplicate candidates. All three
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
function auditAttribution(
  attribution: CurationAttribution | undefined,
): { actor: "web" | "agent"; runId: string | null; confidence: number | null } {
  return {
    actor: attribution?.actor ?? "web",
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
function listingMatchSnapshot(row: ListingMatchRow): Record<string, unknown> {
  return {
    id: row.id,
    vendorId: row.vendorId,
    listingKey: row.listingKey,
    cigarId: row.cigarId,
    status: row.status,
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

async function loadCigar(tx: Queryer, cigarId: string): Promise<CigarRow | undefined> {
  const rows = await tx.select().from(cigars).where(eq(cigars.id, cigarId)).limit(1);
  return rows[0];
}

async function loadListingMatch(tx: Queryer, matchId: string): Promise<ListingMatchRow | undefined> {
  const rows = await tx.select().from(listingMatches).where(eq(listingMatches.id, matchId)).limit(1);
  return rows[0];
}

// --------------------------------------------------------------------------
// mergeCigars — fold a duplicate into the surviving entry (curator-only).
// --------------------------------------------------------------------------

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
  let productPhotosRepointed = 0;
  if (sourcePhoto[0] && !targetPhoto[0]) {
    await tx.update(productPhotos).set({ cigarId: target.id }).where(eq(productPhotos.cigarId, source.id));
    productPhotosRepointed = 1;
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

  // Want marks re-point, closing the #45-noted gap where a merge orphaned the
  // source's wants. The UNIQUE(user_id, cigar_id) pair forbids a user holding two
  // marks, so a user who wanted BOTH sides is de-duped: drop the source's mark
  // (the target's survives) FIRST, then re-point the rest — the re-point can no
  // longer collide. The audit records the de-dupe count.
  const dedupedWantRows = await tx
    .delete(wants)
    .where(
      sql`${wants.cigarId} = ${source.id} AND EXISTS (
        SELECT 1 FROM wants w2 WHERE w2.cigar_id = ${target.id} AND w2.user_id = ${wants.userId}
      )`,
    )
    .returning({ id: wants.id });
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
    .returning({ id: favorites.id });
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
  // NOTE (undo scope): re-pointing back on unmerge would need to know WHICH rows
  // moved (smokes/purchases indistinguishable from the target's own after the
  // merge, and the want/favorite de-dupe dropped rows entirely). That demands a
  // per-merge bookkeeping table, so unmergeCigar is intentionally NOT built here
  // (DESIGN-003 wave 3 note) — the tombstone preserves the data for a later, real
  // undo rather than a half-built one.
  await tx
    .update(cigars)
    .set({ catalogStatus: "merged", mergedInto: target.id, updatedAt: deps.now() })
    .where(eq(cigars.id, source.id));

  const repointed = {
    smokes: smokeRows.length,
    purchases: purchaseRows.length,
    listingMatches: listingRows.length,
    offers: offerRows.length,
    productPhotos: productPhotosRepointed,
    enrichmentRequests: enrichmentRows.length,
    wants: wantRows.length,
    favorites: favoriteRows.length,
  };

  await tx.insert(auditLog).values({
    userId: principal.userId,
    actor: "web",
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
  });

  const result: MergeCigarsResult = {
    sourceCigarId: source.id,
    targetCigarId: target.id,
    repointed,
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
    ...auditAttribution(input.attribution),
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
    actor: "web",
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
  await tx
    .update(listingMatches)
    .set({ status: input.status, cigarId: nextCigarId, updatedAt: deps.now() })
    .where(eq(listingMatches.id, match.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(input.attribution),
    action: "listing_match.set_status",
    smokeId: null,
    before,
    after: { ...before, status: input.status, cigarId: nextCigarId },
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
  // A merged tombstone is not an exclude target — it is undone by unmerge (a future
  // primitive), not by exclude/restore.
  if (current.catalogStatus === "merged") {
    throw new ValidationError([{ path: "cigarId", message: "A merged cigar cannot be excluded." }]);
  }

  const before = cigarSnapshot(current);
  await tx
    .update(cigars)
    .set({ catalogStatus: "excluded", updatedAt: deps.now() })
    .where(eq(cigars.id, current.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(input.attribution),
    action: "cigar.exclude",
    smokeId: null,
    before,
    after: { ...before, catalogStatus: "excluded" },
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
  // A merged tombstone is restored by unmerge (which re-points its data back), not
  // by flipping the flag — restore only reverses an exclude.
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
    ...auditAttribution(input.attribution),
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
    ...auditAttribution(input.attribution),
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

  if (changedFields.length > 0) {
    await tx
      .update(cigars)
      .set({ ...set, updatedAt: deps.now() })
      .where(eq(cigars.id, current.id));

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(input.attribution),
      action: "cigar.set_facts",
      smokeId: null,
      before,
      after,
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
  // one-sided "Signature 2000" vs "Signature") or an extra packaging token
  // ("… Tubos Pack" vs the naked stick) are different products by definition —
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

function decodeWorklistCursor(raw: string | null | undefined): [string, string] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
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
  type: "NC" | "CC" | null;
  manufacturer: string | null;
  verification: "verified" | "unverified";
  createdAt: Date;
}

function toWorklistCigar(row: CigarFactsRow): WorklistCigar {
  return {
    cigarId: row.id,
    canonicalName: row.canonicalName,
    brand: row.brand,
    line: row.line,
    type: row.type,
    manufacturer: row.manufacturer,
    verification: row.verification,
    createdAt: row.createdAt.toISOString(),
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
      type: cigars.type,
      manufacturer: cigars.manufacturer,
      verification: cigars.verification,
      createdAt: cigars.createdAt,
      createdAtText: sql<string>`${cigars.createdAt}::text`,
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

// A page of vendor listing→cigar auto-matches awaiting triage. The listing side
// (vendor name, key, latest offer URL) and the resolver's guessed cigar facts sit
// side by side so a confirm/unmatch verdict is judgeable without another read.
// Keyset-ordered by the match's (createdAt, id).
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
           v.name AS vendor_name,
           (SELECT o.listing_url FROM offers o
              WHERE o.listing_match_id = lm.id
              ORDER BY o.seen_at DESC LIMIT 1) AS listing_url,
           c.id AS cigar_id, c.canonical_name, c.brand, c.line, c.type,
           c.manufacturer, c.verification, c.created_at AS cigar_created_at
    FROM listing_matches lm
    JOIN vendors v ON v.id = lm.vendor_id
    LEFT JOIN cigars c ON c.id = lm.cigar_id
    WHERE lm.status = 'auto' ${keyset}
    ORDER BY lm.created_at ASC, lm.id ASC
    LIMIT ${limit + 1}
  `);
  const rows = result.rows as unknown as {
    match_id: string;
    listing_key: string;
    match_created_at_text: string;
    vendor_name: string;
    listing_url: string | null;
    cigar_id: string | null;
    canonical_name: string | null;
    brand: string | null;
    line: string | null;
    type: "NC" | "CC" | null;
    manufacturer: string | null;
    verification: "verified" | "unverified" | null;
    cigar_created_at: Date | null;
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
    cigar:
      r.cigar_id != null
        ? {
            cigarId: r.cigar_id,
            canonicalName: r.canonical_name ?? "",
            brand: r.brand,
            line: r.line,
            type: r.type,
            manufacturer: r.manufacturer,
            verification: r.verification ?? "unverified",
            createdAt: r.cigar_created_at ? new Date(r.cigar_created_at).toISOString() : "",
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
  const cursor = decodeWorklistCursor(input.cursor);

  switch (input.kind) {
    case "unverified": {
      const page = await cigarWorklistPage(db, eq(cigars.verification, "unverified"), cursor, limit);
      return { kind: input.kind, cigars: page.cigars, nextCursor: page.nextCursor };
    }
    case "unbranded": {
      const page = await cigarWorklistPage(db, isNull(cigars.brand), cursor, limit);
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
