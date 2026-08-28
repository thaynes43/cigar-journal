import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { purchases, vendors, enrichmentRequests, auditLog } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { recordPurchase } from "./record-purchase.js";
import { getMyInventory } from "./inventory.js";
import type { Principal } from "./index.js";
import { ValidationError } from "./errors.js";

describe("recordPurchase", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("record-purchase@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("logs a described-cigar acquisition, auto-creating the cigar and queuing enrichment", async () => {
    const result = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Aurora Arc Toro", brand: "Aurora", type: "NC" } },
      quantity: 10,
      purchasedAt: "2026-01-10",
      packaging: "box",
      pricePerStick: 12.5,
    });
    expect(result.cigar.verification).toBe("unverified"); // created from words
    expect(result.holdingAfter).toEqual({ totalAcquired: 10, remaining: 10 });
    expect(result.replayed).toBe(false);

    const rows = await h.deps.db.select().from(purchases).where(eq(purchases.id, result.purchaseId));
    expect(rows[0]!.source).toBe("llm-conversation");
    expect(rows[0]!.quantity).toBe(10);
    expect(Number(rows[0]!.pricePerStick)).toBe(12.5);

    // Described cigar → enrichment queued through the same path add_cigar uses.
    const queued = await h.deps.db
      .select()
      .from(enrichmentRequests)
      .where(eq(enrichmentRequests.cigarId, result.cigar.cigarId));
    expect(queued).toHaveLength(1);

    // purchase.record audit row, attributed to the mcp actor, no smokeId.
    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId));
    const rec = audits.find(
      (a) => a.action === "purchase.record" && (a.after as { purchaseId?: string }).purchaseId === result.purchaseId,
    );
    expect(rec).toBeDefined();
    expect(rec!.actor).toBe("mcp");
    expect(rec!.smokeId).toBeNull();
  });

  it("resolves a known vendor case-insensitively and links it by id", async () => {
    const [vendor] = await h.deps.db
      .insert(vendors)
      .values({ name: "Small Batch Cigar" })
      .returning({ id: vendors.id });
    const cigarId = await h.seedCigar({ canonicalName: "Vendor Match Robusto", brand: "VM" });

    const result = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 5,
      vendorName: "small batch cigar", // different casing
    });
    const row = (await h.deps.db.select().from(purchases).where(eq(purchases.id, result.purchaseId)))[0]!;
    expect(row.vendorId).toBe(vendor!.id);
    expect(row.notes).toBeNull();
    // A resolved id ref does not queue enrichment.
    expect(
      await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId)),
    ).toHaveLength(0);
  });

  it("stores an unknown vendor name in notes rather than minting a registry row", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Ghost Vendor Corona", brand: "GV" });
    const before = await h.deps.db.select().from(vendors);

    const result = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 3,
      vendorName: "Nowhere Cigar Emporium",
      notes: "birthday gift",
    });
    const row = (await h.deps.db.select().from(purchases).where(eq(purchases.id, result.purchaseId)))[0]!;
    expect(row.vendorId).toBeNull();
    expect(row.notes).toContain("birthday gift");
    expect(row.notes).toContain("vendor: Nowhere Cigar Emporium");

    // No vendor registry row was created for the conversational mention.
    const after = await h.deps.db.select().from(vendors);
    expect(after).toHaveLength(before.length);
  });

  it("corrects an over-count with a negative-quantity row; holdings stay derived", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Overcount Belicoso", brand: "OC" });
    const bought = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 6,
    });
    expect(bought.holdingAfter.totalAcquired).toBe(6);

    const corrected = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: -2,
      notes: "Two were a gift, never mine.",
    });
    expect(corrected.holdingAfter.totalAcquired).toBe(4);
    expect(corrected.holdingAfter.remaining).toBe(4);

    // Both rows persist — the ledger is append-only.
    const rows = await h.deps.db.select().from(purchases).where(eq(purchases.cigarId, cigarId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.quantity).sort()).toEqual([-2, 6]);
  });

  it("rejects a negative quantity with no notes (validation_error on notes)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Reasonless Robusto", brand: "RR" });
    const error = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: -1,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.some((f) => f.path === "notes")).toBe(true);
  });

  it("rejects a zero quantity", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Zero Zino", brand: "ZZ" });
    const error = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 0,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.some((f) => f.path === "quantity")).toBe(true);
  });

  it("counts the caller's smokes since first purchase in remaining", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Consumed Churchill", brand: "CC" });
    // Seed a smoke dated after the purchase, then buy — remaining reflects it.
    const { saveSmoke } = await import("./save-smoke.js");
    await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 3,
      purchasedAt: "2026-01-01",
    });
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      smokedAt: { value: "2026-02-01", source: "user", precision: "day" },
    });
    const again = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 2,
      purchasedAt: "2026-03-01",
    });
    // 5 acquired, 1 smoked since first purchase → remaining 4.
    expect(again.holdingAfter.totalAcquired).toBe(5);
    expect(again.holdingAfter.remaining).toBe(4);
  });

  it("replays an identical retry with no duplicate ledger row", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Replay Rothschild", brand: "RepR" });
    const input = {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 4,
    };
    const first = await recordPurchase(h.deps, user, input);
    const second = await recordPurchase(h.deps, user, input);
    expect(second.replayed).toBe(true);
    expect(second.purchaseId).toBe(first.purchaseId);
    const rows = await h.deps.db.select().from(purchases).where(eq(purchases.cigarId, cigarId));
    expect(rows).toHaveLength(1);
  });

  it("scopes holdings to the caller — another user's purchase is invisible", async () => {
    const intruder = await h.createUser("record-purchase-intruder@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Isolation Idolo II", brand: "Iso" });
    await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 4,
    });
    const intruderInv = await getMyInventory(h.deps, intruder);
    expect(intruderInv.holdings.some((hh) => hh.cigar.cigarId === cigarId)).toBe(false);
  });
});
