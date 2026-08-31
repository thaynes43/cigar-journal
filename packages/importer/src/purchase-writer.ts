import { and, eq } from "drizzle-orm";
import { vendors, purchases, idempotencyKeys, auditLog } from "@cj/db";
import {
  resolveCigar,
  fingerprint,
  auditActor,
  CigarAmbiguousError,
  type Deps,
  type Principal,
  type Tx,
} from "@cj/domain";
import type { ParsedPurchase } from "./purchases-parse.js";
import type { NeedsReview } from "./report.js";

// Importer-owned purchase writer. Purchases are a separate aggregate root with
// no domain service (a purchase is an acquisition, not an experience — ADR-002),
// so the importer writes them directly. Cigars are still resolved through the
// domain's resolveCigar so purchase-linked cigars uphold the same catalog
// invariant. Idempotency reuses the idempotency_keys envelope keyed by the
// deterministic row id, written in the same transaction as the effect.
//
// The caller supplies the deterministic key + source ref (archive
// `purchase-history.md#N` or ledger `ledger-2026-08-27#N`), so both the archive
// import and the ledger reconciler share this one write path — never a fork.

export interface PurchaseSource {
  clientRequestId: string; // deterministic idempotency key
  ref: string; // source ref for audit correlation + needs-review notes
}

export interface PurchaseWriteResult {
  status: "imported" | "replayed" | "skipped";
  cigarCreated: boolean;
  vendorCreated: boolean;
  note: NeedsReview | null;
}

// Vendors carry over as owner-added with crawl/display disabled (flow 006).
async function resolveVendor(tx: Tx, name: string): Promise<{ id: string; created: boolean }> {
  const existing = await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.name, name)).limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };
  const inserted = await tx
    .insert(vendors)
    .values({ name, approvalStatus: "owner-added", crawlEnabled: false, displayEnabled: false })
    .returning({ id: vendors.id });
  return { id: inserted[0]!.id, created: true };
}

export async function writePurchase(
  deps: Deps,
  principal: Principal,
  purchase: ParsedPurchase,
  source: PurchaseSource,
): Promise<PurchaseWriteResult> {
  const clientRequestId = source.clientRequestId;
  const requestFingerprint = fingerprint({
    canonicalName: purchase.canonicalName,
    purchasedAt: purchase.purchasedAt,
    quantity: purchase.quantity,
    packaging: purchase.packaging,
    pricePerStick: purchase.pricePerStick,
    retailer: purchase.retailer,
    notes: purchase.notes,
  });

  try {
    return await deps.db.transaction(async (tx): Promise<PurchaseWriteResult> => {
      const existing = await tx
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, principal.userId), eq(idempotencyKeys.clientRequestId, clientRequestId)))
        .limit(1);
      if (existing[0]) return { status: "replayed", cigarCreated: false, vendorCreated: false, note: null };

      const vendor = purchase.retailer ? await resolveVendor(tx, purchase.retailer) : null;

      const cigar = await resolveCigar(tx, {
        described: {
          canonicalName: purchase.canonicalName,
          // An empty brand (the ledger "???" unknown case) resolves as null, not "".
          brand: purchase.brand.trim() || null,
          type: purchase.type,
          vitola: { name: purchase.vitola, lengthInches: purchase.lengthInches, ringGauge: purchase.ringGauge },
        },
      });

      const inserted = await tx
        .insert(purchases)
        .values({
          userId: principal.userId,
          cigarId: cigar.cigarId,
          purchasedAt: purchase.purchasedAt,
          quantity: purchase.quantity,
          packaging: purchase.packaging,
          boxDate: purchase.boxDate,
          humidorAt: purchase.humidorAt,
          pricePerStick: purchase.pricePerStick,
          vendorId: vendor?.id ?? null,
          notes: purchase.notes,
        })
        .returning({ id: purchases.id });
      const purchaseId = inserted[0]!.id;

      await tx.insert(idempotencyKeys).values({
        userId: principal.userId,
        clientRequestId,
        tool: "import_purchase",
        requestFingerprint,
        smokeId: null,
        result: { purchaseId, cigarId: cigar.cigarId },
      });

      await tx.insert(auditLog).values({
        userId: principal.userId,
        // The CLI builds this principal itself and it carries no client, so the
        // column stays null today — but it is READ from the principal, so the day
        // the importer runs under a token the attribution is already right (#183).
        ...auditActor(principal, "import"),
        action: "purchase.imported",
        smokeId: null,
        before: null,
        after: { purchaseId, cigarId: cigar.cigarId, canonicalName: purchase.canonicalName },
        correlationId: clientRequestId,
      });

      return { status: "imported", cigarCreated: cigar.created, vendorCreated: vendor?.created ?? false, note: null };
    });
  } catch (error) {
    if (error instanceof CigarAmbiguousError) {
      return {
        status: "skipped",
        cigarCreated: false,
        vendorCreated: false,
        note: {
          kind: "purchase",
          ref: source.ref,
          reason: `ambiguous cigar match for "${purchase.canonicalName}" → skipped`,
        },
      };
    }
    throw error;
  }
}
