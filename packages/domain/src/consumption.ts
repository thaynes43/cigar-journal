import { and, eq } from "drizzle-orm";
import { smokeConsumptions, purchases } from "@cj/db";
import type { Tx, Queryer } from "./deps.js";
import type { ConsumptionInput, ConsumptionChange, SmokeConsumptionView } from "./types.js";
import { ValidationError } from "./errors.js";
import { isUuid } from "./uuid.js";

// Explicit consumption (ADR-008): a smoke deducts one stick from the humidor
// only via a row in smoke_consumptions. save_smoke and update_smoke both write
// through here, in the caller's transaction, so the link and its audit land
// atomically with the smoke. User and cigar derive through the smoke; this
// module only ever validates a lot against the smoke's current cigar.

// Read the current link for a smoke, or null when the stick came from elsewhere.
export async function loadConsumption(
  q: Queryer,
  smokeId: string,
): Promise<SmokeConsumptionView | null> {
  const rows = await q
    .select({ purchaseId: smokeConsumptions.purchaseId, source: smokeConsumptions.source })
    .from(smokeConsumptions)
    .where(eq(smokeConsumptions.smokeId, smokeId))
    .limit(1);
  const row = rows[0];
  return row ? { purchaseId: row.purchaseId, source: row.source } : null;
}

// A lot the caller attributed a consumption to must exist, be theirs, and belong
// to the same cigar the smoke links to — a foreign lot is a validation_error.
async function assertLotOwned(
  tx: Tx,
  userId: string,
  cigarId: string,
  purchaseId: string,
  path: string,
): Promise<void> {
  // A malformed purchaseId is refused exactly as a lot that does not exist, is
  // not the caller's, or belongs to another cigar — all four are "no such lot of
  // this cigar" and already share one message. Guarding here covers both write
  // paths (save and update) at their single point of contact with `purchases`,
  // and refuses before the query so no 22P02 aborts the caller's transaction
  // (./uuid.ts). This is the one guard in the sweep that answers validation_error
  // rather than a not-found: the lot is a field of the request, not the identity
  // being addressed, so it is the existing answer for an unknown lot that is
  // being matched — the rule is "malformed reads as unknown", not "as not-found".
  if (!isUuid(purchaseId)) throw noSuchLot(path);

  const rows = await tx
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.id, purchaseId),
        eq(purchases.userId, userId),
        eq(purchases.cigarId, cigarId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw noSuchLot(path);
}

function noSuchLot(path: string): ValidationError {
  return new ValidationError([
    { path, message: "No humidor lot of this cigar matches the given purchaseId." },
  ]);
}

// Capture consumption at save time. `fromHumidor: true` writes the link (with a
// validated lot when attributed); `false` or an omitted block writes nothing —
// omitted is unknown, and unknown deducts nothing. Returns the resulting link for
// the creation audit's `after` snapshot.
export async function applyConsumptionOnSave(
  tx: Tx,
  ctx: { smokeId: string; cigarId: string; userId: string },
  consumption: ConsumptionInput | undefined,
): Promise<SmokeConsumptionView | null> {
  if (!consumption || consumption.fromHumidor !== true) return null;
  const purchaseId = consumption.purchaseId ?? null;
  if (purchaseId != null) {
    await assertLotOwned(tx, ctx.userId, ctx.cigarId, purchaseId, "consumption.purchaseId");
  }
  await tx.insert(smokeConsumptions).values({ smokeId: ctx.smokeId, purchaseId, source: "user" });
  return { purchaseId, source: "user" };
}

export interface ConsumptionMutationResult {
  before: SmokeConsumptionView | null;
  after: SmokeConsumptionView | null;
  changedFields: string[];
}

// Apply a consumption change on update: set/clear/re-attribute the link, plus the
// cigar-repoint side effect — re-pointing a smoke to a different cigar clears a
// now-foreign lot (kept in the audit before/after). Returns before/after so the
// single in-transaction update audit row records the movement.
export async function applyConsumptionChange(
  tx: Tx,
  ctx: { smokeId: string; newCigarId: string; userId: string; cigarRepointed: boolean },
  change: ConsumptionChange | undefined,
): Promise<ConsumptionMutationResult> {
  const before = await loadConsumption(tx, ctx.smokeId);

  if (change) {
    if (change.fromHumidor === true) {
      const purchaseId = change.purchaseId ?? null;
      if (purchaseId != null) {
        await assertLotOwned(
          tx,
          ctx.userId,
          ctx.newCigarId,
          purchaseId,
          "changes.consumption.purchaseId",
        );
      }
      // Upsert on the unique smoke_id — set the link or re-attribute its lot.
      await tx
        .insert(smokeConsumptions)
        .values({ smokeId: ctx.smokeId, purchaseId, source: "user" })
        .onConflictDoUpdate({
          target: smokeConsumptions.smokeId,
          set: { purchaseId, source: "user" },
        });
      return { before, after: { purchaseId, source: "user" }, changedFields: ["consumption"] };
    }
    // fromHumidor === false → clear the link.
    if (before) {
      await tx.delete(smokeConsumptions).where(eq(smokeConsumptions.smokeId, ctx.smokeId));
    }
    return { before, after: null, changedFields: ["consumption"] };
  }

  // No explicit consumption op. If the smoke was re-pointed to a different cigar
  // and still carries a lot, that lot is now foreign — clear it, keep the link.
  if (ctx.cigarRepointed && before?.purchaseId != null) {
    const stillOwned = await tx
      .select({ id: purchases.id })
      .from(purchases)
      .where(
        and(
          eq(purchases.id, before.purchaseId),
          eq(purchases.userId, ctx.userId),
          eq(purchases.cigarId, ctx.newCigarId),
        ),
      )
      .limit(1);
    if (!stillOwned[0]) {
      await tx
        .update(smokeConsumptions)
        .set({ purchaseId: null })
        .where(eq(smokeConsumptions.smokeId, ctx.smokeId));
      return {
        before,
        after: { purchaseId: null, source: before.source },
        changedFields: ["consumption.purchaseId"],
      };
    }
  }

  return { before, after: before, changedFields: [] };
}
