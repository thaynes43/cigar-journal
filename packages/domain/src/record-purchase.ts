import { sql } from "drizzle-orm";
import { auditLog, purchases, vendors } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import type { CigarRef, RecordPurchaseInput, RecordPurchaseResult } from "./types.js";
import { validateRecordPurchaseInput } from "./validation.js";
import { fingerprint } from "./fingerprint.js";
import { resolveAndEnrich } from "./enrichment.js";
import { deriveHoldingSummary } from "./inventory.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { provenanceToActor } from "./mapping.js";
import type { ResolvedCigar } from "./cigar-resolution.js";
import { resolveCigar } from "./cigar-resolution.js";

// Append one acquisition — or a correction — to the purchases ledger (owner,
// 2026-08-28: everything is a purchase row, holdings stay derived). A described
// cigar auto-creates + enqueues enrichment through the SAME path add_cigar uses;
// an unknown vendor name is folded into notes rather than minting a registry row
// (the vendor registry is admin data). Ledger write + audit + idempotency key in
// one transaction.
export async function recordPurchase(
  deps: Deps,
  principal: Principal,
  input: RecordPurchaseInput,
): Promise<RecordPurchaseResult> {
  validateRecordPurchaseInput(input);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => recordWithinTx(tx, principal, input, requestFingerprint));
  } catch (error) {
    // Concurrent first-writer committed the key between our check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as RecordPurchaseResult), replayed: true };
      }
    }
    throw error;
  }
}

// Resolve the vendor name case-insensitively against the admin registry. A known
// vendor links by id; an unknown name is returned so the caller can fold it into
// notes — we never create a registry row from a conversational mention.
async function resolveVendor(
  tx: Tx,
  vendorName: string | null | undefined,
): Promise<{ vendorId: string | null; unknownVendor: string | null }> {
  const name = vendorName?.trim();
  if (!name) return { vendorId: null, unknownVendor: null };
  const rows = await tx
    .select({ id: vendors.id })
    .from(vendors)
    .where(sql`lower(${vendors.name}) = lower(${name})`)
    .limit(1);
  if (rows[0]) return { vendorId: rows[0].id, unknownVendor: null };
  return { vendorId: null, unknownVendor: name };
}

async function recordWithinTx(
  tx: Tx,
  principal: Principal,
  input: RecordPurchaseInput,
  requestFingerprint: string,
): Promise<RecordPurchaseResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as RecordPurchaseResult), replayed: true };
  }

  // A described cigar takes the add_cigar path (create + enqueue enrichment); a
  // resolved id links directly with no enrichment.
  let cigar: ResolvedCigar;
  if ("described" in input.cigar) {
    ({ cigar } = await resolveAndEnrich(tx, input.cigar as CigarRef, principal.userId, true));
  } else {
    cigar = await resolveCigar(tx, input.cigar as CigarRef);
  }

  const { vendorId, unknownVendor } = await resolveVendor(tx, input.vendorName);
  // Fold an unknown vendor into notes; keep the user's own notes ahead of it.
  const notes =
    [input.notes?.trim() || null, unknownVendor ? `vendor: ${unknownVendor}` : null]
      .filter((part): part is string => part != null)
      .join("\n") || null;

  const provenanceSource = input.provenance?.source ?? "llm-conversation";
  const inserted = await tx
    .insert(purchases)
    .values({
      userId: principal.userId,
      cigarId: cigar.cigarId,
      purchasedAt: input.purchasedAt ?? null,
      quantity: input.quantity,
      packaging: input.packaging ?? null,
      boxDate: input.boxDate ?? null,
      humidorAt: input.humidorAt ?? null,
      pricePerStick: input.pricePerStick != null ? String(input.pricePerStick) : null,
      vendorId,
      notes,
      source: "llm-conversation",
    })
    .returning({ id: purchases.id });
  const purchaseId = inserted[0]!.id;

  await tx.insert(auditLog).values({
    userId: principal.userId,
    actor: provenanceToActor(provenanceSource),
    action: "purchase.record",
    smokeId: null,
    before: null,
    after: {
      purchaseId,
      cigarId: cigar.cigarId,
      quantity: input.quantity,
      vendorId,
      source: "llm-conversation",
    },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  // Derived stock picture AFTER this row lands (same formula as getMyInventory).
  const holdingAfter = await deriveHoldingSummary(tx, principal.userId, cigar.cigarId);

  const result: RecordPurchaseResult = {
    purchaseId,
    cigar: { cigarId: cigar.cigarId, canonicalName: cigar.canonicalName, verification: cigar.verification },
    holdingAfter,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "record_purchase",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}
