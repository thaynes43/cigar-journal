import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vendors, listingMatches, offers, type ListingMatchRow } from "@cj/db";
import { createHarness, type DomainHarness } from "./testing/harness.js";
import { getCigarPriceHistory } from "./reads.js";

describe("getCigarPriceHistory", () => {
  let h: DomainHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // Explicit `displayEnabled` for the reason cigar-offers.test.ts states: the
  // column defaults to false and the price reads gate on it (ADR-015).
  async function addVendor(name: string): Promise<string> {
    const [v] = await h.deps.db
      .insert(vendors)
      .values({ name, displayEnabled: true })
      .returning({ id: vendors.id });
    return v!.id;
  }

  async function addMatch(
    vendorId: string,
    cigarId: string,
    listingKey: string,
    status: ListingMatchRow["status"] = "confirmed",
  ): Promise<string> {
    const [m] = await h.deps.db
      .insert(listingMatches)
      .values({ vendorId, cigarId, listingKey, status })
      .returning({ id: listingMatches.id });
    return m!.id;
  }

  async function addOffer(over: Partial<typeof offers.$inferInsert>): Promise<void> {
    await h.deps.db.insert(offers).values(over);
  }

  it("returns per-stick observations oldest first, across crawler and ad-hoc rows, dropping null per-stick", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "History Toro", brand: "Hist" });

    // Crawler series (reached via a confirmed listing match): two priced obs plus
    // one with no derivable per-stick (excluded — no honest place on the axis).
    const vendorA = await addVendor("Alpha Cigars");
    const matchA = await addMatch(vendorA, cigarId, "alpha-sku-1");
    await addOffer({ vendorId: vendorA, listingMatchId: matchA, pricePerStickCents: 1200, seenAt: new Date("2026-06-01T00:00:00Z") });
    await addOffer({ vendorId: vendorA, listingMatchId: matchA, pricePerStickCents: 1100, seenAt: new Date("2026-07-01T00:00:00Z") });
    await addOffer({ vendorId: vendorA, listingMatchId: matchA, pricePerStickCents: null, price: "55.00", seenAt: new Date("2026-07-15T00:00:00Z") });

    // Ad-hoc chat observation linked directly to the cigar (no listing match).
    await addOffer({ cigarId, sourceName: "Reddit", pricePerStickCents: 1000, seenAt: new Date("2026-08-01T00:00:00Z") });

    const points = await getCigarPriceHistory(h.deps, { cigarId });
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.pricePerStick)).toEqual([12, 11, 10]); // oldest first
    expect(points[0]!.seenAt).toBe("2026-06-01T00:00:00.000Z");
    expect(points[2]!.seenAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("excludes other cigars and unmatched listings", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "History Robusto", brand: "Hist" });
    const otherId = await h.seedCigar({ canonicalName: "Other Robusto", brand: "Oth" });

    const good = await addVendor("Good Shop");
    const goodMatch = await addMatch(good, cigarId, "good-sku", "confirmed");
    await addOffer({ vendorId: good, listingMatchId: goodMatch, pricePerStickCents: 900, seenAt: new Date("2026-08-01T00:00:00Z") });

    // Unmatched listing for the SAME cigar — excluded by the status filter.
    const un = await addVendor("Unmatched Shop");
    const unMatch = await addMatch(un, cigarId, "un-sku", "unmatched");
    await addOffer({ vendorId: un, listingMatchId: unMatch, pricePerStickCents: 100, seenAt: new Date("2026-08-02T00:00:00Z") });

    // Confirmed match for a DIFFERENT cigar — excluded by the cigar filter.
    const other = await addVendor("Other Shop");
    const otherMatch = await addMatch(other, otherId, "other-sku", "confirmed");
    await addOffer({ vendorId: other, listingMatchId: otherMatch, pricePerStickCents: 200, seenAt: new Date("2026-08-03T00:00:00Z") });

    const points = await getCigarPriceHistory(h.deps, { cigarId });
    expect(points).toHaveLength(1);
    expect(points[0]!.pricePerStick).toBe(9);
  });

  it("returns an empty array when the cigar has no derivable-per-stick observations", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Priceless Corona", brand: "Pri" });
    // A single package-only observation (no per-stick) yields no history points.
    await addOffer({ cigarId, sourceName: "Shop", price: "80.00", seenAt: new Date("2026-08-01T00:00:00Z") });
    expect(await getCigarPriceHistory(h.deps, { cigarId })).toEqual([]);
  });
});
