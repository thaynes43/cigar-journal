import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, purchases } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { recordPurchase } from "./record-purchase.js";
import { updateSmoke } from "./update-smoke.js";
import { updatePurchase } from "./update-purchase.js";
import type { Principal } from "./index.js";
import {
  CigarNotFoundError,
  IdempotencyConflictError,
  PurchaseNotFoundError,
  ValidationError,
} from "./errors.js";

// ADR-017's ledger half: a lot moves to the right catalog entry one record at a
// time, on the owner's word. Everything here is the counterpart of a rule
// update_smoke already keeps — ownership never leaks, the destination resolves
// through the one resolver, and the move is audited in its own transaction.
describe("updatePurchase", () => {
  let h: DomainHarness;
  let user: Principal;
  let stranger: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("lots@example.com");
    stranger = await h.createUser("stranger-lots@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function seedLot(owner: Principal, cigarId: string): Promise<string> {
    const recorded = await recordPurchase(h.deps, owner, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 5,
    });
    return recorded.purchaseId;
  }

  async function lotCigar(purchaseId: string): Promise<string> {
    const rows = await h.deps.db
      .select({ cigarId: purchases.cigarId })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .limit(1);
    return rows[0]!.cigarId;
  }

  async function repointAudits(purchaseId: string) {
    const rows = await h.deps.db.select().from(auditLog);
    return rows.filter(
      (row) =>
        row.action === "purchase.repoint" &&
        (row.after as { purchaseId?: string } | null)?.purchaseId === purchaseId,
    );
  }

  it("re-points the lot, reports the destination, and audits before/after", async () => {
    const family = await h.seedCigar({ canonicalName: `Lot Family ${newRequestId()}` });
    const sibling = await h.seedCigar({ canonicalName: `Lot Sibling ${newRequestId()}` });
    const purchaseId = await seedLot(user, family);

    const result = await updatePurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      purchaseId,
      changes: { cigar: { resolveTo: sibling } },
    });

    expect(result.purchase.purchaseId).toBe(purchaseId);
    expect(result.purchase.cigarId).toBe(sibling);
    expect(result.purchase.canonicalName).toContain("Lot Sibling");
    expect(result.changedFields).toEqual(["cigar"]);
    expect(result.replayed).toBe(false);
    expect(await lotCigar(purchaseId)).toBe(sibling);

    const audits = await repointAudits(purchaseId);
    expect(audits).toHaveLength(1);
    expect((audits[0]!.before as { cigarId: string }).cigarId).toBe(family);
    expect((audits[0]!.after as { cigarId: string }).cigarId).toBe(sibling);
  });

  // Already there: nothing to write, and nothing to complain about either.
  it("is a no-op when the lot already points at the destination", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Lot Settled ${newRequestId()}` });
    const purchaseId = await seedLot(user, cigarId);

    const result = await updatePurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      purchaseId,
      changes: { cigar: { resolveTo: cigarId } },
    });

    expect(result.changedFields).toEqual([]);
    expect(result.purchase.cigarId).toBe(cigarId);
    expect(await repointAudits(purchaseId)).toHaveLength(0);
  });

  // THE REFUSAL. A stick already smoked out of this lot is logged against the
  // family entry; moving the lot under it would leave that consumption claiming a
  // lot of one product for a smoke of another.
  it("refuses while a smoke consumed from the lot sits on another cigar", async () => {
    const family = await h.seedCigar({ canonicalName: `Lot Consumed ${newRequestId()}` });
    const sibling = await h.seedCigar({ canonicalName: `Lot Consumed Sibling ${newRequestId()}` });
    const purchaseId = await seedLot(user, family);
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: family },
      overallDescriptors: ["cedar"],
      consumption: { fromHumidor: true, purchaseId },
    });

    const error = await updatePurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      purchaseId,
      changes: { cigar: { resolveTo: sibling } },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    const fields = (error as ValidationError).fields;
    expect(fields[0]!.path).toBe("changes.cigar.resolveTo");
    // The recovery is per record, so the smokes to move are named.
    expect(fields[0]!.message).toContain(saved.smoke.smokeId);
    expect(fields[0]!.message).toContain("update_smoke");
    // Nothing was written.
    expect(await lotCigar(purchaseId)).toBe(family);
    expect(await repointAudits(purchaseId)).toHaveLength(0);
  });

  // THE DOCUMENTED RECOVERY, end to end: move the smoke first (update_smoke
  // clears the now-foreign lot on its own, ADR-008), then the lot, then
  // re-attribute the stick to it. Each step is one record, which is the point.
  it("allows the move once the consuming smoke has been moved", async () => {
    const family = await h.seedCigar({ canonicalName: `Lot Moved ${newRequestId()}` });
    const sibling = await h.seedCigar({ canonicalName: `Lot Moved Sibling ${newRequestId()}` });
    const purchaseId = await seedLot(user, family);
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: family },
      overallDescriptors: ["cedar"],
      consumption: { fromHumidor: true, purchaseId },
    });

    await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId: saved.smoke.smokeId,
      changes: { cigar: { resolveTo: sibling } },
    });

    const result = await updatePurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      purchaseId,
      changes: { cigar: { resolveTo: sibling } },
    });
    expect(result.changedFields).toEqual(["cigar"]);
    expect(await lotCigar(purchaseId)).toBe(sibling);

    // And the lot can take its stick back, now that both name the same cigar.
    const reattributed = await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId: saved.smoke.smokeId,
      changes: { consumption: { fromHumidor: true, purchaseId } },
    });
    expect(reattributed.changedFields).toContain("consumption");
  });

  it("reports another user's lot, and a malformed id, exactly as unknown", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Lot Foreign ${newRequestId()}` });
    const theirs = await seedLot(stranger, cigarId);
    const destination = await h.seedCigar({ canonicalName: `Lot Foreign Dest ${newRequestId()}` });
    const attempt = (purchaseId: string) =>
      updatePurchase(h.deps, user, {
        clientRequestId: newRequestId(),
        purchaseId,
        changes: { cigar: { resolveTo: destination } },
      }).catch((e: unknown) => e);

    const foreign = await attempt(theirs);
    const malformed = await attempt("not-a-uuid");
    const unknown = await attempt(newRequestId());

    expect(foreign).toBeInstanceOf(PurchaseNotFoundError);
    expect(malformed).toBeInstanceOf(PurchaseNotFoundError);
    expect(unknown).toBeInstanceOf(PurchaseNotFoundError);
    expect((malformed as PurchaseNotFoundError).toPayload()).toEqual(
      (unknown as PurchaseNotFoundError).toPayload(),
    );
    // The stranger's lot did not move.
    expect(await lotCigar(theirs)).toBe(cigarId);
  });

  it("answers a malformed or unknown destination as cigar_not_found", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Lot Dest ${newRequestId()}` });
    const purchaseId = await seedLot(user, cigarId);
    const attempt = (resolveTo: string) =>
      updatePurchase(h.deps, user, {
        clientRequestId: newRequestId(),
        purchaseId,
        changes: { cigar: { resolveTo } },
      }).catch((e: unknown) => e);

    expect(await attempt("not-a-uuid")).toBeInstanceOf(CigarNotFoundError);
    expect(await attempt(newRequestId())).toBeInstanceOf(CigarNotFoundError);
    expect(await lotCigar(purchaseId)).toBe(cigarId);
  });

  it("replays under the same envelope and conflicts on a different payload", async () => {
    const family = await h.seedCigar({ canonicalName: `Lot Replay ${newRequestId()}` });
    const sibling = await h.seedCigar({ canonicalName: `Lot Replay Sibling ${newRequestId()}` });
    const other = await h.seedCigar({ canonicalName: `Lot Replay Other ${newRequestId()}` });
    const purchaseId = await seedLot(user, family);
    const clientRequestId = newRequestId();

    const first = await updatePurchase(h.deps, user, {
      clientRequestId,
      purchaseId,
      changes: { cigar: { resolveTo: sibling } },
    });
    const replay = await updatePurchase(h.deps, user, {
      clientRequestId,
      purchaseId,
      changes: { cigar: { resolveTo: sibling } },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.purchase).toEqual(first.purchase);
    expect(await repointAudits(purchaseId)).toHaveLength(1);

    const conflict = await updatePurchase(h.deps, user, {
      clientRequestId,
      purchaseId,
      changes: { cigar: { resolveTo: other } },
    }).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(IdempotencyConflictError);
    expect(await lotCigar(purchaseId)).toBe(sibling);
  });
});
