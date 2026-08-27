import { and, eq } from "drizzle-orm";
import { vendors, purchases, idempotencyKeys, auditLog } from "@cj/db";
import { resolveCigar, fingerprint, CigarAmbiguousError, type Deps, type Principal, type Tx } from "@cj/domain";
import type { ParsedPurchase } from "./purchases-parse.js";
import type { NeedsReview } from "./report.js";
import { purchaseRequestId } from "./keys.js";

// Importer-owned purchase writer. Purchases are a separate aggregate root with
// no domain service (a purchase is an acquisition, not an experience — ADR-002),
// so the importer writes them directly. Cigars are still resolved through the
// domain's resolveCigar so purchase-linked cigars uphold the same catalog
// invariant. Idempotency reuses the idempotency_keys envelope keyed by the
// deterministic row id, written in the same transaction as the effect.

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
): Promise<PurchaseWriteResult> {
  const clientRequestId = purchaseRequestId(purchase.rowNumber);
  const requestFingerprint = fingerprint({
    canonicalName: purchase.canonicalName,
    purchasedAt: purchase.purchasedAt,
    quantity: purchase.quantity,
    pricePerStick: purchase.pricePerStick,
    retailer: purchase.retailer,
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
          brand: purchase.brand,
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
        actor: "import",
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
          ref: `purchase-history.md#${purchase.rowNumber}`,
          reason: `ambiguous cigar match for "${purchase.canonicalName}" → skipped`,
        },
      };
    }
    throw error;
  }
}
