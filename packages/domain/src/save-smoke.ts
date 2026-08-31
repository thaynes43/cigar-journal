import { auditLog, smokes, smokeProgression } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { SaveSmokeInput, SaveSmokeResult } from "./types.js";
import { validateSaveInput } from "./validation.js";
import { fingerprint } from "./fingerprint.js";
import { normalizeDescriptors, verbatimDescriptors } from "./descriptors.js";
import { resolveCigar } from "./cigar-resolution.js";
import { queueEnrichmentSafely } from "./enrichment.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { provenanceToActor, stampSmokedAt, smokeSnapshot } from "./mapping.js";
import { applyConsumptionOnSave } from "./consumption.js";
import { deriveHoldingSummary } from "./inventory.js";

// Persist one finished Smoke. Validate → resolve cigar (create unverified if
// described) → write smoke + progression + idempotency key + audit row in ONE
// transaction (ADR-002/003). @cj/domain is the single writer of Smokes.
export async function saveSmoke(
  deps: Deps,
  principal: Principal,
  input: SaveSmokeInput,
): Promise<SaveSmokeResult> {
  validateSaveInput(input);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => saveWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    // Concurrent first-writer committed the key between our check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SaveSmokeResult), replayed: true };
      }
    }
    throw error;
  }
}

async function saveWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: SaveSmokeInput,
  requestFingerprint: string,
): Promise<SaveSmokeResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as SaveSmokeResult), replayed: true };
  }

  const provenanceSource = input.provenance?.source ?? "llm-conversation";
  const cigar = await resolveCigar(tx, input.cigar);
  const smokedAt = stampSmokedAt(input.smokedAt, provenanceSource, deps.now);

  const insertedSmoke = await tx
    .insert(smokes)
    .values({
      userId: principal.userId,
      cigarId: cigar.cigarId,
      smokedAt: smokedAt.value ? new Date(smokedAt.value) : null,
      smokedAtSource: smokedAt.source,
      smokedAtPrecision: smokedAt.precision,
      context: input.context ?? null,
      overallDescriptors: normalizeDescriptors(input.overallDescriptors),
      draw: input.construction?.draw ?? null,
      burn: input.construction?.burn ?? null,
      smokeOutput: input.construction?.smokeOutput ?? null,
      constructionNotes: input.construction?.notes ?? null,
      strength: input.assessment?.strength ?? null,
      body: input.assessment?.body ?? null,
      liked: input.assessment?.liked ?? null,
      rating: input.assessment?.rating ?? null,
      impression: input.assessment?.impression ?? null,
      journalTitle: input.journal?.title ?? null,
      journalNarrative: input.journal?.narrative ?? null,
      provenanceSource,
      provenanceClient: input.provenance?.client ?? null,
      originalMarkdown: input.originalMarkdown ?? null,
      version: 1,
    })
    .returning();
  const smoke = insertedSmoke[0]!;

  const entries = input.progression ?? [];
  if (entries.length > 0) {
    await tx.insert(smokeProgression).values(
      entries.map((entry, ordinal) => ({
        smokeId: smoke.id,
        ordinal,
        stage: entry.stage ?? null,
        approximatePosition: entry.approximatePosition != null ? String(entry.approximatePosition) : null,
        descriptors: normalizeDescriptors(entry.descriptors),
        specificDescriptors: verbatimDescriptors(entry.specificDescriptors),
        verbatim: entry.verbatim ?? null,
      })),
    );
  }

  // Explicit consumption (ADR-008): link the smoke to the humidor when the caller
  // said it came from there. Omitted/false writes nothing — unknown deducts
  // nothing. In-transaction with the smoke and its audit.
  const consumption = await applyConsumptionOnSave(
    tx,
    { smokeId: smoke.id, cigarId: cigar.cigarId, userId: principal.userId },
    input.consumption,
  );

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditActor(principal, provenanceToActor(provenanceSource)),
    action: "smoke.created",
    smokeId: smoke.id,
    before: null,
    after: consumption ? { ...smokeSnapshot(smoke), consumption } : smokeSnapshot(smoke),
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  // Gap-fill enrichment (#177). add_cigar → save_smoke is the documented path
  // (owner ruling on #177); a described save is the SAFETY NET for a client that
  // skipped the prelude. When that net catches — the save creates the catalog
  // entry itself — it queues what add_cigar would have queued, specs and a
  // product photo. Three gates, each load-bearing:
  //   * cigar.created — a save that LINKED to an existing row filled no gap.
  //     Queueing there would file a request for any of the ~96% of catalog rows
  //     that fail assessEnrichmentFields.complete, against exactly the unverified
  //     and untyped rows the #154 curation press refuses without an override —
  //     and would make enrichmentQueued:true reachable with cigarCreated:false,
  //     which all four surfaces documenting the field say cannot happen.
  //   * described refs only — a cigarId save never creates, so the common path
  //     takes no enrichment reads at all.
  //   * llm-conversation provenance only — the legacy importer saves per review
  //     with described cigars ("legacy-import"), and an ungated queue would file
  //     one request per distinct cigar on the next archive import. The web form
  //     ("manual") is excluded for the same reason; it has its own repair
  //     surfaces. record_purchase queues under every provenance — this is
  //     deliberately narrower than that, not parity with it.
  // Ordered last on purpose: everything the user actually asked for is already
  // written above.
  const enrichmentQueued =
    cigar.created && "described" in input.cigar && provenanceSource === "llm-conversation"
      ? await queueEnrichmentSafely(tx, cigar.cigarId, principal.userId)
      : false;

  // When the save carried a consumption block (ADR-008 / DESIGN-002 ask-once
  // flow), report the derived stock picture AFTER the smoke so the caller reads
  // back the new remaining without a follow-up read (mirrors record_purchase's
  // holdingAfter). Read inside this transaction to see the just-linked
  // consumption. Absent when no block was supplied — nothing was deducted.
  const holdingAfter =
    input.consumption !== undefined
      ? await deriveHoldingSummary(tx, principal.userId, cigar.cigarId)
      : undefined;

  const result: SaveSmokeResult = {
    smoke: {
      smokeId: smoke.id,
      version: smoke.version,
      cigar: { cigarId: cigar.cigarId, canonicalName: cigar.canonicalName, verification: cigar.verification },
    },
    cigarCreated: cigar.created,
    enrichmentQueued,
    ...(holdingAfter ? { holdingAfter } : {}),
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "save_smoke",
    requestFingerprint,
    smokeId: smoke.id,
    result,
  });

  return result;
}
