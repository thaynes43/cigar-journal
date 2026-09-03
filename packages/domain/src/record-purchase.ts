import { sql } from "drizzle-orm";
import { auditLog, purchases, vendors } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { CigarRef, RecordPurchaseInput, RecordPurchaseResult } from "./types.js";
import { validateRecordPurchaseInput } from "./validation.js";
import { fingerprint } from "./fingerprint.js";
import { queueEnrichmentSafely } from "./enrichment.js";
import { deriveHoldingSummary } from "./inventory.js";
import { isWanted } from "./wants.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { provenanceToActor } from "./mapping.js";
import type { ResolvedCigar } from "./cigar-resolution.js";
import { resolveCigar } from "./cigar-resolution.js";

// Append one acquisition — or a correction — to the purchases ledger (owner,
// 2026-08-28: everything is a purchase row, holdings stay derived). A described
// cigar auto-creates + enqueues enrichment through the SAME resolver and queue
// add_cigar uses — queued after the ledger row, never ahead of it (#188);
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

  // Resolve-or-create through the single catalog-invariant resolver (ADR-002) —
  // the same one add_cigar and save_smoke use. A described ref may create the
  // cigar; a resolved id only ever links. Enrichment is queued after the ledger
  // write, below.
  //
  // `confirmedDistinct` is add_cigar's escape hatch, carried here with identical
  // semantics (owner, 2026-08-31): on `cigar_ambiguous` the model confirms with
  // the user and re-issues THIS call with the flag, instead of detouring through
  // search → add_cigar(confirmedDistinct) → record_purchase(cigarId) for every
  // stick of a related-but-distinct sampler. The resolver keeps the one safety
  // it keeps for add_cigar — a case-insensitive exact canonical_name match still
  // links (created:false), so an override can never mint a literal duplicate —
  // and it is inert on a cigarId ref, which resolves before options are read.
  const describedRef = "described" in input.cigar;
  //
  // AN ACQUISITION MAY BE AN ASSORTMENT (#164 Q1). `save_smoke` and `add_cigar`
  // refuse a sampler because a smoke lands on a leaf and a mixed box is not one;
  // a PURCHASE of a sampler is a real event with a real price, and the owner keeps
  // exactly those rows as inventory records. So this path records what was bought.
  const cigar: ResolvedCigar = await resolveCigar(tx, input.cigar as CigarRef, {
    confirmedDistinct: input.confirmedDistinct ?? false,
    allowAssortment: true,
  });

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
    ...auditActor(principal, provenanceToActor(provenanceSource)),
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

  // Gap-fill enrichment for a cigar this purchase just created — the specs and
  // product photo add_cigar would have queued. Ordered AFTER the ledger row and
  // its audit, and wrapped in the savepoint guard (#188): the queue runs six
  // reads and an insert, and a failure among them aborts the transaction, so
  // running it first traded the purchase for it. Two gates:
  //   * cigar.created — a purchase that LINKED to an existing row filled no gap.
  //     Queueing there would file a request against exactly the unverified and
  //     untyped rows the #154 curation press refuses without an override.
  //   * described refs only — a cigarId ref never creates, so the common path
  //     takes no enrichment reads at all.
  // Unlike save_smoke there is no provenance gate: record_purchase queues under
  // every provenance, deliberately — no legacy importer writes purchases.
  const enrichmentQueued =
    cigar.created && describedRef ? await queueEnrichmentSafely(tx, cigar.cigarId, principal.userId) : false;

  // Derived stock picture AFTER this row lands (same formula as getMyInventory).
  const holdingAfter = await deriveHoldingSummary(tx, principal.userId, cigar.cigarId);

  // Acquisition never auto-clears a want (R-WANT-2) — we only report it so the
  // surface can OFFER the clear. Read the caller's current mark (unchanged by
  // this write) to carry the flag out.
  const wanted = await isWanted(tx, principal.userId, cigar.cigarId);

  const result: RecordPurchaseResult = {
    purchaseId,
    cigar: { cigarId: cigar.cigarId, canonicalName: cigar.canonicalName, verification: cigar.verification },
    holdingAfter,
    wanted,
    // Reported, not inferred: `record_purchase_batch` labels each line `created`
    // or `existing` from this flag, and a caller cannot derive it — an
    // auto-created row and a linked unverified row look identical in `cigar`.
    cigarCreated: cigar.created,
    enrichmentQueued,
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
