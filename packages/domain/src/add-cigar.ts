import { auditLog } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { AddCigarInput, AddCigarResult } from "./types.js";
import { fingerprint } from "./fingerprint.js";
import { resolveAndEnrich } from "./enrichment.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { provenanceToActor } from "./mapping.js";
import { ValidationError } from "./errors.js";

// Create an unverified catalog entry from the user's words and queue background
// enrichment — the conversational gap-fill for a cigar search_cigars didn't
// match (owner, 2026-08-28). Resolve-or-create runs through the SAME path
// save_smoke uses (resolveAndEnrich → resolveCigar); this service adds only the
// enrichment queue, the audit row, and the mutation envelope.
export async function addCigar(
  deps: Deps,
  principal: Principal,
  input: AddCigarInput,
): Promise<AddCigarResult> {
  if (!input.cigar?.canonicalName?.trim()) {
    throw new ValidationError([{ path: "cigar.canonicalName", message: "Required." }]);
  }
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => addWithinTx(tx, principal, input, requestFingerprint));
  } catch (error) {
    // Concurrent first-writer committed the key between our check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as AddCigarResult), replayed: true };
      }
    }
    throw error;
  }
}

async function addWithinTx(
  tx: Tx,
  principal: Principal,
  input: AddCigarInput,
  requestFingerprint: string,
): Promise<AddCigarResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as AddCigarResult), replayed: true };
  }

  const provenanceSource = input.provenance?.source ?? "llm-conversation";
  const { cigar, enrichmentQueued } = await resolveAndEnrich(
    tx,
    { described: input.cigar },
    principal.userId,
    input.requestEnrichment ?? true,
    { confirmedDistinct: input.confirmedDistinct ?? false },
  );

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditActor(principal, provenanceToActor(provenanceSource)),
    action: "cigar.add",
    smokeId: null,
    before: null,
    after: {
      cigarId: cigar.cigarId,
      canonicalName: cigar.canonicalName,
      verification: cigar.verification,
      created: cigar.created,
      enrichmentQueued,
    },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: AddCigarResult = {
    cigar: { cigarId: cigar.cigarId, canonicalName: cigar.canonicalName, verification: cigar.verification },
    created: cigar.created,
    enrichmentQueued,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "add_cigar",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}
