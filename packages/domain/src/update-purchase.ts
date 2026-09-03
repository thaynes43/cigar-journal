import { and, eq, ne } from "drizzle-orm";
import { auditLog, cigars, purchases, smokes, smokeConsumptions } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { UpdatePurchaseInput, UpdatePurchaseResult } from "./types.js";
import { fingerprint } from "./fingerprint.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { PurchaseNotFoundError, ValidationError } from "./errors.js";
import { provenanceToActor } from "./mapping.js";
import { resolveCigar } from "./cigar-resolution.js";
import { isUuid } from "./uuid.js";

// Re-point ONE purchase lot at the right catalog entry (ADR-017) — the ledger's
// counterpart to `update_smoke { cigar: { resolveTo } }`, and the second half of
// "history moves one record at a time, explicitly". A family row is never
// migrated as a whole, because only the owner knows which stick was which.
//
// Field-scoped like update_smoke and deliberately narrower: the cigar is the only
// thing a lot can change. Quantity, price and date stay append-only ledger facts,
// corrected by another row and never by an edit.
export async function updatePurchase(
  deps: Deps,
  principal: Principal,
  input: UpdatePurchaseInput,
): Promise<UpdatePurchaseResult> {
  // Refused before the transaction opens, exactly as update_smoke refuses a
  // malformed smokeId: a 22P02 does not merely escape as a 500, it aborts the
  // surrounding transaction, so a guard at the query site would still leave a
  // poisoned tx to unwind. A malformed lot id is the same refusal as an unowned
  // or unknown one (./uuid.ts); the destination id is left to `resolveCigar`,
  // which makes the same refusal for itself.
  if (!isUuid(input.purchaseId)) throw new PurchaseNotFoundError();
  if (!input.changes?.cigar?.resolveTo) {
    throw new ValidationError([{ path: "changes.cigar.resolveTo", message: "Required." }]);
  }

  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => updateWithinTx(tx, principal, input, requestFingerprint));
  } catch (error) {
    // Concurrent first-writer committed the key between our check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as UpdatePurchaseResult), replayed: true };
      }
    }
    throw error;
  }
}

async function updateWithinTx(
  tx: Tx,
  principal: Principal,
  input: UpdatePurchaseInput,
  requestFingerprint: string,
): Promise<UpdatePurchaseResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as UpdatePurchaseResult), replayed: true };
  }

  const rows = await tx
    .select({
      id: purchases.id,
      userId: purchases.userId,
      cigarId: purchases.cigarId,
      canonicalName: cigars.canonicalName,
    })
    .from(purchases)
    .innerJoin(cigars, eq(cigars.id, purchases.cigarId))
    .where(eq(purchases.id, input.purchaseId))
    .limit(1);
  const lot = rows[0];
  // Cross-user access is reported as not-found so a lot's existence never leaks
  // to a non-owner (tool-contract error principle, as for smokes).
  if (!lot || lot.userId !== principal.userId) throw new PurchaseNotFoundError();

  // The destination resolves through the one catalog-invariant resolver (ADR-002)
  // on its id branch, so a malformed or unknown id is `cigar_not_found` here for
  // the same reason it is everywhere else. An id ref never creates.
  const destination = await resolveCigar(tx, { cigarId: input.changes.cigar.resolveTo });

  const provenanceSource = input.provenance?.source ?? "llm-conversation";

  // ALREADY THERE — a no-op, not an error. The lot is where the caller wants it,
  // so nothing is written (no update, no audit row) and `changedFields` is empty.
  // This is the "asked twice under two ids" case; a true replay of the SAME id is
  // answered by the envelope above.
  if (lot.cigarId === destination.cigarId) {
    const result: UpdatePurchaseResult = {
      purchase: {
        purchaseId: lot.id,
        cigarId: destination.cigarId,
        canonicalName: destination.canonicalName,
      },
      changedFields: [],
      replayed: false,
    };
    await recordIdempotency(tx, {
      userId: principal.userId,
      clientRequestId: input.clientRequestId,
      tool: "update_purchase",
      requestFingerprint,
      smokeId: null,
      result,
    });
    return result;
  }

  // THE ONE REFUSAL: a stick already smoked out of this lot, logged against a
  // different cigar than the destination. Moving the lot under it would leave the
  // consumption claiming a lot of one product for a smoke of another — the exact
  // inconsistency `assertLotOwned` refuses at the other end (consumption.ts), so
  // refusing here keeps one rule rather than two. The smokes are named because
  // the recovery is per record: move them with update_smoke first, then re-point
  // the lot. Nothing is moved silently and nothing is bulk (ADR-017).
  const foreign = await tx
    .select({ smokeId: smokes.id })
    .from(smokeConsumptions)
    .innerJoin(smokes, eq(smokes.id, smokeConsumptions.smokeId))
    .where(and(eq(smokeConsumptions.purchaseId, lot.id), ne(smokes.cigarId, destination.cigarId)));
  if (foreign.length > 0) {
    const ids = foreign.map((row) => row.smokeId).join(", ");
    throw new ValidationError([
      {
        path: "changes.cigar.resolveTo",
        message: `Smokes consumed from this lot are logged against a different cigar (${ids}) — move them with update_smoke first.`,
      },
    ]);
  }

  await tx.update(purchases).set({ cigarId: destination.cigarId }).where(eq(purchases.id, lot.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditActor(principal, provenanceToActor(provenanceSource)),
    action: "purchase.repoint",
    smokeId: null,
    // Before and after carry the cigar on both sides — the whole content of the
    // change, and what makes the move reversible by hand.
    before: { purchaseId: lot.id, cigarId: lot.cigarId, canonicalName: lot.canonicalName },
    after: {
      purchaseId: lot.id,
      cigarId: destination.cigarId,
      canonicalName: destination.canonicalName,
    },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: UpdatePurchaseResult = {
    purchase: {
      purchaseId: lot.id,
      cigarId: destination.cigarId,
      canonicalName: destination.canonicalName,
    },
    changedFields: ["cigar"],
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "update_purchase",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}
