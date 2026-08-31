import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { purchases, vendors } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { getHoldingForCigar } from "./inventory.js";
import type { Principal } from "./index.js";

describe("getHoldingForCigar", () => {
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

  async function smoke(user: Principal, cigarId: string, fromHumidor: boolean): Promise<void> {
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      consumption: { fromHumidor },
    });
  }

  it("returns lots newest-first with PPS and humidor date, and ages from earliest humidor date", async () => {
    const user = await h.createUser("hold-lots@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Holding Toro", brand: "Hld" });
    const [vendor] = await h.deps.db
      .insert(vendors)
      .values({ name: "Test Vendor" })
      .returning({ id: vendors.id });

    await addPurchase(user.userId, cigarId, {
      purchasedAt: "2026-05-01",
      quantity: 5,
      vendorId: vendor!.id,
      pricePerStick: "12.50",
      humidorAt: "2025-08-01",
      boxDate: "2025-02-01",
    });
    await addPurchase(user.userId, cigarId, {
      purchasedAt: "2026-04-01",
      quantity: 3,
      humidorAt: "2025-06-01",
    });

    const holding = await getHoldingForCigar(h.deps, user, cigarId);
    expect(holding.hasHolding).toBe(true);
    expect(holding.totalAcquired).toBe(8);
    expect(holding.remaining).toBe(8);
    expect(holding.lots).toHaveLength(2);
    expect(holding.lots[0]!.purchasedAt).toBe("2026-05-01"); // newest first
    expect(holding.lots[0]!.pricePerStick).toBe(12.5); // numeric coerced to number
    expect(holding.lots[0]!.vendor).toBe("Test Vendor");
    expect(holding.lots[0]!.humidorAt).toBe("2025-08-01");
    expect(holding.lots[1]!.pricePerStick).toBeNull();
    expect(holding.agingSince).toBe("2025-06-01"); // earliest humidor date wins
  });

  it("ages from earliest box date when no humidor date exists", async () => {
    const user = await h.createUser("hold-box@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Boxed Belicoso", brand: "Box" });
    await addPurchase(user.userId, cigarId, { purchasedAt: "2026-05-01", quantity: 1, boxDate: "2025-03-01" });
    await addPurchase(user.userId, cigarId, { purchasedAt: "2026-04-01", quantity: 1, boxDate: "2025-01-01" });

    const holding = await getHoldingForCigar(h.deps, user, cigarId);
    expect(holding.agingSince).toBe("2025-01-01");
  });

  it("surfaces over-consumption and floors remaining at zero", async () => {
    const user = await h.createUser("hold-over@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Overdrawn Corona", brand: "Ovr" });
    await addPurchase(user.userId, cigarId, { purchasedAt: "2026-02-01", quantity: 1 });
    await smoke(user, cigarId, true);
    await smoke(user, cigarId, true);

    const holding = await getHoldingForCigar(h.deps, user, cigarId);
    expect(holding.remaining).toBe(0);
    expect(holding.overConsumed).toBe(1);
  });

  it("reports no holding for a cigar the caller has never purchased", async () => {
    const user = await h.createUser("hold-none@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Unowned Lonsdale", brand: "Uno" });
    const holding = await getHoldingForCigar(h.deps, user, cigarId);
    expect(holding.hasHolding).toBe(false);
    expect(holding.lots).toEqual([]);
    expect(holding.agingSince).toBeNull();
    expect(holding.remaining).toBe(0);
  });

  it("getHoldingForCigar answers a malformed id exactly as it answers an unknown one", async () => {
    // #206. The cigarId reaches here from a form's route param, and used to carry
    // into a `uuid` column as-is (Postgres 22P02 → a 500). This read reports a
    // quantity, so the empty holding — not an error — is the answer both cases
    // share; the equality is the contract, the literal pins what it settles on.
    const user = await h.createUser("hold-malformed@example.com");
    const malformed = await getHoldingForCigar(h.deps, user, "not-a-uuid");
    const unknown = await getHoldingForCigar(h.deps, user, newRequestId());
    expect({ ...malformed, cigarId: null }).toEqual({ ...unknown, cigarId: null });
    expect(malformed).toEqual({
      cigarId: "not-a-uuid",
      hasHolding: false,
      totalAcquired: 0,
      remaining: 0,
      overConsumed: 0,
      agingSince: null,
      lots: [],
    });
  });
});
