import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vendors, listingMatches, offers, type ListingMatchRow } from "@cj/db";
import { createHarness, type DomainHarness } from "./testing/harness.js";
import { getCigarOffers } from "./reads.js";

describe("getCigarOffers", () => {
  let h: DomainHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function addVendor(name: string): Promise<string> {
    const [v] = await h.deps.db.insert(vendors).values({ name }).returning({ id: vendors.id });
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

  async function addOffer(
    vendorId: string,
    listingMatchId: string,
    over: Partial<typeof offers.$inferInsert>,
  ): Promise<void> {
    await h.deps.db.insert(offers).values({ vendorId, listingMatchId, ...over });
  }

  it("returns the latest offer per vendor, older offers ignored, cheapest first with nulls last", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Padron 1964 Anniversary", brand: "Padron" });

    // Vendor A: two offers for the same listing — the newer (by seen_at) wins,
    // even though the older one is cheaper. Proves latest-per-vendor, not min.
    const vendorA = await addVendor("Alpha Cigars");
    const matchA = await addMatch(vendorA, cigarId, "alpha-sku-1");
    await addOffer(vendorA, matchA, {
      price: "9.00",
      currency: "USD",
      inStock: true,
      listingUrl: "https://alpha.example/old",
      seenAt: new Date("2026-06-01T00:00:00Z"),
    });
    await addOffer(vendorA, matchA, {
      price: "12.50",
      currency: "USD",
      inStock: true,
      listingUrl: "https://alpha.example/new",
      seenAt: new Date("2026-08-20T00:00:00Z"),
    });

    // Vendor B: single offer, cheapest, out of stock.
    const vendorB = await addVendor("Bravo Humidor");
    const matchB = await addMatch(vendorB, cigarId, "bravo-sku-1");
    await addOffer(vendorB, matchB, {
      price: "8.00",
      currency: "USD",
      inStock: false,
      listingUrl: "https://bravo.example/x",
      seenAt: new Date("2026-08-10T00:00:00Z"),
    });

    // Vendor C: single offer with no observed price → sorts last.
    const vendorC = await addVendor("Charlie Cigars");
    const matchC = await addMatch(vendorC, cigarId, "charlie-sku-1");
    await addOffer(vendorC, matchC, {
      price: null,
      currency: null,
      inStock: true,
      listingUrl: null,
      seenAt: new Date("2026-08-15T00:00:00Z"),
    });

    const result = await getCigarOffers(h.deps, { cigarId });

    expect(result.map((o) => o.vendor)).toEqual([
      "Bravo Humidor", // 8.00
      "Alpha Cigars", // 12.50 (newer row, older 9.00 ignored)
      "Charlie Cigars", // null price → last
    ]);

    const alpha = result.find((o) => o.vendor === "Alpha Cigars")!;
    expect(alpha.price).toBe(12.5);
    expect(alpha.listingUrl).toBe("https://alpha.example/new"); // the newer offer's fields
    expect(alpha.seenAt).toBe("2026-08-20T00:00:00.000Z");
    expect(alpha.inStock).toBe(true);

    const bravo = result.find((o) => o.vendor === "Bravo Humidor")!;
    expect(bravo.price).toBe(8);
    expect(bravo.currency).toBe("USD");
    expect(bravo.inStock).toBe(false);

    const charlie = result.find((o) => o.vendor === "Charlie Cigars")!;
    expect(charlie.price).toBeNull();
    expect(charlie.currency).toBeNull();
    expect(charlie.listingUrl).toBeNull();
  });

  it("excludes unmatched listings and offers for other cigars", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Oliva Serie V Melanio", brand: "Oliva" });
    const otherId = await h.seedCigar({ canonicalName: "Oliva Serie O", brand: "Oliva" });

    // A confirmed match for the target cigar — this one should appear.
    const good = await addVendor("Good Shop");
    const goodMatch = await addMatch(good, cigarId, "good-sku", "confirmed");
    await addOffer(good, goodMatch, {
      price: "10.00",
      currency: "USD",
      inStock: true,
      seenAt: new Date("2026-08-01T00:00:00Z"),
    });

    // An `unmatched` listing for the SAME cigar — excluded (status filter).
    const unmatchedVendor = await addVendor("Unmatched Shop");
    const unmatched = await addMatch(unmatchedVendor, cigarId, "un-sku", "unmatched");
    await addOffer(unmatchedVendor, unmatched, {
      price: "1.00",
      currency: "USD",
      inStock: true,
      seenAt: new Date("2026-08-05T00:00:00Z"),
    });

    // A confirmed match for a DIFFERENT cigar — excluded (cigar filter).
    const otherVendor = await addVendor("Other Cigar Shop");
    const otherMatch = await addMatch(otherVendor, otherId, "other-sku", "confirmed");
    await addOffer(otherVendor, otherMatch, {
      price: "2.00",
      currency: "USD",
      inStock: true,
      seenAt: new Date("2026-08-06T00:00:00Z"),
    });

    const result = await getCigarOffers(h.deps, { cigarId });
    expect(result).toHaveLength(1);
    expect(result[0]!.vendor).toBe("Good Shop");
    expect(result[0]!.price).toBe(10);
  });

  it("returns an empty array for a cigar with no offers", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Undocumented Lonsdale", brand: "Nobody" });
    const result = await getCigarOffers(h.deps, { cigarId });
    expect(result).toEqual([]);
  });
});
