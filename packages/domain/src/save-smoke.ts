import { auditLog, smokes, smokeProgression } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import type { SaveSmokeInput, SaveSmokeResult } from "./types.js";
import { validateSaveInput } from "./validation.js";
import { fingerprint } from "./fingerprint.js";
import { normalizeDescriptors } from "./descriptors.js";
import { resolveCigar } from "./cigar-resolution.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { provenanceToActor, stampSmokedAt, smokeSnapshot } from "./mapping.js";

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
        specificDescriptors: normalizeDescriptors(entry.specificDescriptors),
        verbatim: entry.verbatim ?? null,
      })),
    );
  }

  await tx.insert(auditLog).values({
    userId: principal.userId,
    actor: provenanceToActor(provenanceSource),
    action: "smoke.created",
    smokeId: smoke.id,
    before: null,
    after: smokeSnapshot(smoke),
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: SaveSmokeResult = {
    smoke: {
      smokeId: smoke.id,
      version: smoke.version,
      cigar: { cigarId: cigar.cigarId, canonicalName: cigar.canonicalName, verification: cigar.verification },
    },
    cigarCreated: cigar.created,
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
