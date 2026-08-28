import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { purchases, vendors } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { getMyInventory } from "./inventory.js";
import type { Principal } from "./index.js";

describe("getMyInventory", () => {
  let h: DomainHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function addPurchase(
    userId: string,
    cigarId: string,
    over: Partial<typeof purchases.$inferInsert> = {},
  ): Promise<void> {
    await h.deps.db.insert(purchases).values({ userId, cigarId, ...over });
  }

  // A smoke of the cigar with an optional rating, an explicit date, or (nullTime)
  // no time at all — the shape an imported smoke lands in. `fromHumidor` attaches
  // the explicit consumption link (ADR-008): only a linked smoke deducts.
  async function smoke(
    user: Principal,
    cigarId: string,
    opts: { rating?: number; smokedAt?: string; nullTime?: boolean; fromHumidor?: boolean } = {},
  ): Promise<void> {
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      ...(opts.rating != null ? { assessment: { rating: opts.rating } } : {}),
      ...(opts.smokedAt
        ? { smokedAt: { value: opts.smokedAt, source: "user" as const, precision: "day" as const } }
        : {}),
      ...(opts.nullTime ? { provenance: { source: "legacy-import" as const } } : {}),
      ...(opts.fromHumidor != null ? { consumption: { fromHumidor: opts.fromHumidor } } : {}),
    });
  }

  it("groups multiple purchase lots under one holding, newest purchase first", async () => {
    const user = await h.createUser("inv-group@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Group Toro", brand: "Grp" });
    await addPurchase(user.userId, cigarId, { purchasedAt: "2026-01-10", quantity: 10 });
    await addPurchase(user.userId, cigarId, { purchasedAt: "2026-03-15", quantity: 5 });

    const { holdings, totalSticksRemaining } = await getMyInventory(h.deps, user);
    expect(holdings).toHaveLength(1);
    const holding = holdings[0]!;
    expect(holding.lots).toHaveLength(2);
    expect(holding.lots[0]!.purchasedAt).toBe("2026-03-15"); // newest first
    expect(holding.lots[1]!.purchasedAt).toBe("2026-01-10");
    expect(holding.totalAcquired).toBe(15);
    expect(holding.remaining).toBe(15); // nothing smoked
    expect(holding.smokedCount).toBe(0);
    expect(totalSticksRemaining).toBe(15);
  });

  it("derives remaining from explicit consumption links, floors display at 0, surfaces over-consumption", async () => {
    const user = await h.createUser("inv-remaining@example.com");

    // qty 3; two smokes explicitly from the humidor, one off-humidor (a lounge
    // pour of a cigar he also owns) → consumed 2 → remaining 1, all-time 3.
    const c1 = await h.seedCigar({ canonicalName: "Remaining Robusto", brand: "Rem" });
    await addPurchase(user.userId, c1, { purchasedAt: "2026-03-01", quantity: 3 });
    await smoke(user, c1, { smokedAt: "2026-04-01", fromHumidor: true });
    await smoke(user, c1, { nullTime: true, fromHumidor: true });
    await smoke(user, c1, { smokedAt: "2026-01-01", fromHumidor: false }); // off-humidor → no deduction

    // qty 1 but 3 humidor consumptions → remaining floored at 0, over-consumed 2.
    const c2 = await h.seedCigar({ canonicalName: "Overdrawn Corona", brand: "Ovr" });
    await addPurchase(user.userId, c2, { purchasedAt: "2026-02-01", quantity: 1 });
    await smoke(user, c2, { smokedAt: "2026-03-01", fromHumidor: true });
    await smoke(user, c2, { smokedAt: "2026-03-02", fromHumidor: true });
    await smoke(user, c2, { smokedAt: "2026-03-03", fromHumidor: true });

    const { holdings } = await getMyInventory(h.deps, user);
    const rem = holdings.find((holding) => holding.cigar.cigarId === c1)!;
    expect(rem.smokedCount).toBe(3); // all-time smokes
    expect(rem.consumedCount).toBe(2); // only the two humidor-linked ones
    expect(rem.remaining).toBe(1); // 3 acquired − 2 consumed
    expect(rem.overConsumed).toBe(0);

    const over = holdings.find((holding) => holding.cigar.cigarId === c2)!;
    expect(over.smokedCount).toBe(3);
    expect(over.consumedCount).toBe(3);
    expect(over.remaining).toBe(0); // floored, not negative
    expect(over.overConsumed).toBe(2); // the surfaced discrepancy (1 acquired − 3 consumed)

    // In-stock (c1) sorts ahead of the empty (c2).
    expect(holdings[0]!.cigar.cigarId).toBe(c1);
    expect(holdings[1]!.cigar.cigarId).toBe(c2);
  });

  it("a smoke without a consumption link never deducts (the heuristic is gone)", async () => {
    const user = await h.createUser("inv-noheuristic@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Untouched Toro", brand: "Unt" });
    await addPurchase(user.userId, cigarId, { purchasedAt: "2026-01-01", quantity: 5 });
    // Three post-purchase smokes, none linked to the humidor → remaining stays 5.
    await smoke(user, cigarId, { smokedAt: "2026-02-01" });
    await smoke(user, cigarId, { smokedAt: "2026-03-01" });
    await smoke(user, cigarId, { nullTime: true });

    const { holdings } = await getMyInventory(h.deps, user);
    const holding = holdings.find((hh) => hh.cigar.cigarId === cigarId)!;
    expect(holding.smokedCount).toBe(3);
    expect(holding.consumedCount).toBe(0);
    expect(holding.remaining).toBe(5); // no explicit consumption → no deduction
  });

  it("resolves the vendor name via vendor_id and leaves a vendorless lot null", async () => {
    const user = await h.createUser("inv-vendor@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Vendor Lancero", brand: "Vnd" });
    const [vendor] = await h.deps.db
      .insert(vendors)
      .values({ name: "Test Vendor" })
      .returning({ id: vendors.id });
    await addPurchase(user.userId, cigarId, {
      purchasedAt: "2026-05-01",
      quantity: 2,
      vendorId: vendor!.id,
      pricePerStick: "12.50",
    });
    await addPurchase(user.userId, cigarId, { purchasedAt: "2026-04-01", quantity: 2 });

    const { holdings } = await getMyInventory(h.deps, user);
    const lots = holdings[0]!.lots;
    expect(lots[0]!.vendor).toBe("Test Vendor"); // newest, with vendor
    expect(lots[0]!.pricePerStick).toBe(12.5); // numeric coerced to number
    expect(lots[1]!.vendor).toBeNull();
  });

  it("ages from earliest humidor_at, falling back to earliest box_date", async () => {
    const user = await h.createUser("inv-aging@example.com");

    // No humidor date anywhere → earliest box date wins.
    const boxed = await h.seedCigar({ canonicalName: "Boxed Belicoso", brand: "Box" });
    await addPurchase(user.userId, boxed, { purchasedAt: "2026-05-01", quantity: 1, boxDate: "2025-03-01" });
    await addPurchase(user.userId, boxed, { purchasedAt: "2026-04-01", quantity: 1, boxDate: "2025-01-01" });

    // Humidor date present → earliest humidor date wins, box dates ignored.
    const humid = await h.seedCigar({ canonicalName: "Humid Hermoso", brand: "Hum" });
    await addPurchase(user.userId, humid, {
      purchasedAt: "2026-05-01",
      quantity: 1,
      humidorAt: "2025-06-01",
      boxDate: "2025-02-01",
    });
    await addPurchase(user.userId, humid, {
      purchasedAt: "2026-04-01",
      quantity: 1,
      humidorAt: "2025-08-01",
    });

    const { holdings } = await getMyInventory(h.deps, user);
    expect(holdings.find((holding) => holding.cigar.cigarId === boxed)!.agingSince).toBe("2025-01-01");
    expect(holdings.find((holding) => holding.cigar.cigarId === humid)!.agingSince).toBe("2025-06-01");
  });

  it("averages the caller's ratings, ignoring unrated smokes and empty holdings", async () => {
    const user = await h.createUser("inv-rating@example.com");

    const rated = await h.seedCigar({ canonicalName: "Rated Rothschild", brand: "Rat" });
    await addPurchase(user.userId, rated, { purchasedAt: "2026-01-01", quantity: 5 });
    await smoke(user, rated, { rating: 80, smokedAt: "2026-02-01" });
    await smoke(user, rated, { rating: 90, smokedAt: "2026-02-02" });
    await smoke(user, rated, { smokedAt: "2026-02-03" }); // unrated — excluded from average

    const unrated = await h.seedCigar({ canonicalName: "Unrated Perfecto", brand: "Unr" });
    await addPurchase(user.userId, unrated, { purchasedAt: "2026-01-01", quantity: 2 });

    const { holdings } = await getMyInventory(h.deps, user);
    expect(holdings.find((holding) => holding.cigar.cigarId === rated)!.myRating).toBe(85);
    expect(holdings.find((holding) => holding.cigar.cigarId === unrated)!.myRating).toBeNull();
  });

  it("scopes holdings and consumption to the caller", async () => {
    const owner = await h.createUser("inv-owner@example.com");
    const intruder = await h.createUser("inv-intruder@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Isolation Idolo", brand: "Iso" });

    await addPurchase(owner.userId, cigarId, { purchasedAt: "2026-01-01", quantity: 4 });
    // The intruder smokes the same cigar from his own (nonexistent) humidor.
    await smoke(intruder, cigarId, { smokedAt: "2026-02-01", fromHumidor: true });

    const ownerInv = await getMyInventory(h.deps, owner);
    expect(ownerInv.holdings).toHaveLength(1);
    expect(ownerInv.holdings[0]!.remaining).toBe(4); // the intruder's consumption doesn't count
    expect(ownerInv.holdings[0]!.consumedCount).toBe(0);
    expect(ownerInv.holdings[0]!.smokedCount).toBe(0);

    const intruderInv = await getMyInventory(h.deps, intruder);
    expect(intruderInv.holdings).toHaveLength(0); // owns nothing
    expect(intruderInv.totalSticksRemaining).toBe(0);
  });
});
