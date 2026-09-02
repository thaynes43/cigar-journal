import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vendors, listingMatches, offers, type ListingMatchRow } from "@cj/db";
import { createHarness, type DomainHarness } from "./testing/harness.js";
import { getCigarOffers, getCigarOfferHistory, getCigarPricing } from "./reads.js";

describe("getCigarOffers", () => {
  let h: DomainHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // `displayEnabled` is EXPLICIT because the column defaults to false (ADR-015:
  // "nobody has decided" must not mean "price authority"), and every offer read
  // now gates on it — a vendor seeded at the default renders no prices at all,
  // which is a different test than the ones below. The gate itself is covered by
  // offer-display.test.ts.
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

  it("surfaces purchaseLinkout: false for a no-linkout vendor, true otherwise", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Montecristo No. 2", brand: "Montecristo" });

    // A registry vendor crawled for depth but not a purchase destination.
    // `displayEnabled` and `purchaseLinkout` are INDEPENDENT gates: this case is
    // "shown, but never as a place to buy", so display stays on (ADR-015).
    const [noLink] = await h.deps.db
      .insert(vendors)
      .values({
        name: "Cuban Lou's",
        focus: "CC",
        approvalStatus: "unapproved",
        purchaseLinkout: false,
        displayEnabled: true,
      })
      .returning({ id: vendors.id });
    const noLinkMatch = await addMatch(noLink!.id, cigarId, "cl-monte-2", "auto");
    await addOffer(noLink!.id, noLinkMatch, {
      price: "20.00",
      currency: "USD",
      inStock: true,
      listingUrl: "https://cubanlous.example/monte-2",
      seenAt: new Date("2026-08-20T00:00:00Z"),
    });

    // A normal registry vendor (purchase_linkout defaults true).
    const normal = await addVendor("Normal Shop");
    const normalMatch = await addMatch(normal, cigarId, "ns-monte-2", "auto");
    await addOffer(normal, normalMatch, {
      price: "25.00",
      currency: "USD",
      inStock: true,
      listingUrl: "https://normal.example/monte-2",
      seenAt: new Date("2026-08-21T00:00:00Z"),
    });

    // An ad-hoc/chat source (no vendor row) → purchaseLinkout true (nothing to gate).
    await h.deps.db.insert(offers).values({
      cigarId,
      sourceName: "Chat Source",
      price: "22.00",
      currency: "USD",
      inStock: true,
      seenAt: new Date("2026-08-22T00:00:00Z"),
    });

    const result = await getCigarOffers(h.deps, { cigarId });
    expect(result.find((o) => o.vendor === "Cuban Lou's")!.purchaseLinkout).toBe(false);
    expect(result.find((o) => o.vendor === "Normal Shop")!.purchaseLinkout).toBe(true);
    expect(result.find((o) => o.vendor === "Chat Source")!.purchaseLinkout).toBe(true);
  });

  it("getCigarOfferHistory reports span, per-stick range, and observation count", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "History Toro", brand: "Chronicle" });
    const vendor = await addVendor("Chronicle Shop");
    const match = await addMatch(vendor, cigarId, "chron-sku");
    // Three observations over time, per-stick 1420 / 1890 / 1650 cents.
    await addOffer(vendor, match, {
      price: "142.00",
      currency: "USD",
      pricePerStickCents: 1420,
      seenAt: new Date("2026-06-01T00:00:00Z"),
    });
    await addOffer(vendor, match, {
      price: "189.00",
      currency: "USD",
      pricePerStickCents: 1890,
      seenAt: new Date("2026-07-01T00:00:00Z"),
    });
    await addOffer(vendor, match, {
      price: "165.00",
      currency: "USD",
      pricePerStickCents: 1650,
      seenAt: new Date("2026-08-15T00:00:00Z"),
    });

    const history = await getCigarOfferHistory(h.deps, { cigarId });
    expect(history.observationCount).toBe(3);
    expect(history.firstSeenAt).toBe("2026-06-01T00:00:00.000Z");
    expect(history.lastSeenAt).toBe("2026-08-15T00:00:00.000Z");
    expect(history.minPricePerStick).toBe(14.2);
    expect(history.maxPricePerStick).toBe(18.9);
  });

  it("getCigarOfferHistory is empty (nulls, zero count) for a cigar with no offers", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Blank Robusto", brand: "Nobody" });
    const history = await getCigarOfferHistory(h.deps, { cigarId });
    expect(history).toEqual({
      firstSeenAt: null,
      lastSeenAt: null,
      minPricePerStick: null,
      maxPricePerStick: null,
      observationCount: 0,
    });
  });

  // DESIGN-005: the rows come out in the order the page renders them, so the tier
  // blocks are a grouping of the payload rather than a re-sort of it — and
  // get_offers hands the model the same sequence.
  it("orders the rows by packaging tier, best per-stick inside each", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Tiered Belicoso", brand: "Tiered" });
    const shop = await addVendor("Tier Shop");
    const other = await addVendor("Tier Second Shop");

    const single = await addMatch(shop, cigarId, "tier-single");
    await addOffer(shop, single, {
      price: "11.59",
      currency: "USD",
      inStock: true,
      packaging: "single",
      sticksPerPackage: 1,
      pricePerStickCents: 1159,
      seenAt: new Date("2026-09-02T00:00:00Z"),
    });
    const fivePack = await addMatch(shop, cigarId, "tier-5pack");
    await addOffer(shop, fivePack, {
      price: "55.00",
      currency: "USD",
      inStock: true,
      packaging: "5-pack",
      sticksPerPackage: 5,
      pricePerStickCents: 1100,
      seenAt: new Date("2026-09-02T00:00:00Z"),
    });
    const box = await addMatch(shop, cigarId, "tier-box");
    await addOffer(shop, box, {
      price: "210.00",
      currency: "USD",
      inStock: true,
      packaging: "box",
      sticksPerPackage: 20,
      pricePerStickCents: 1050,
      seenAt: new Date("2026-09-02T00:00:00Z"),
    });
    // The same box tier from a second shop, dearer and out of stock — it sorts
    // after the cheaper row inside the block, not into a block of its own.
    const otherBox = await addMatch(other, cigarId, "tier-box-2");
    await addOffer(other, otherBox, {
      price: "224.00",
      currency: "USD",
      inStock: false,
      packaging: "box",
      sticksPerPackage: 20,
      pricePerStickCents: 1120,
      seenAt: new Date("2026-09-02T00:00:00Z"),
    });
    // No packaging word in the listing name: last, whatever the figure.
    const bare = await addMatch(other, cigarId, "tier-bare");
    await addOffer(other, bare, {
      price: "452.60",
      currency: "USD",
      inStock: true,
      seenAt: new Date("2026-09-02T00:00:00Z"),
    });

    const rows = await getCigarOffers(h.deps, { cigarId });
    expect(rows.map((o) => [o.packaging, o.price])).toEqual([
      ["single", 11.59],
      ["5-pack", 55],
      ["box", 210],
      ["box", 224],
      [null, 452.6],
    ]);
  });

  // DESIGN-005 rule 4: the headline is two facts, and this is the second one.
  describe("pricing.bestSingle", () => {
    it("is the cheapest in-stock single, alongside a cheaper box in `lowest`", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Single Toro", brand: "Single" });
      const cheap = await addVendor("Single Cheap Box");
      const dear = await addVendor("Single Dear Stick");
      const boxMatch = await addMatch(cheap, cigarId, "single-box");
      await addOffer(cheap, boxMatch, {
        price: "210.00",
        currency: "USD",
        inStock: true,
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStickCents: 1050,
      });
      const stickMatch = await addMatch(dear, cigarId, "single-stick");
      await addOffer(dear, stickMatch, {
        price: "11.59",
        currency: "USD",
        inStock: true,
        packaging: "single",
        sticksPerPackage: 1,
        pricePerStickCents: 1159,
      });

      const pricing = await getCigarPricing(h.deps, cigarId);
      expect(pricing!.lowest).toMatchObject({ perStick: true, amount: 10.5, packaging: "box" });
      expect(pricing!.bestSingle).toMatchObject({
        amount: 11.59,
        currency: "USD",
        vendor: "Single Dear Stick",
      });
    });

    it("is null when no offer states a single — a missing tier is never invented", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Boxes Only Toro", brand: "Single" });
      const shop = await addVendor("Single Boxes Only");
      const match = await addMatch(shop, cigarId, "boxes-only");
      await addOffer(shop, match, {
        price: "210.00",
        currency: "USD",
        inStock: true,
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStickCents: 1050,
      });
      // An unpackaged row is `Not stated`, never a stick price (DESIGN-005 rule 1).
      await addOffer(shop, await addMatch(shop, cigarId, "boxes-only-bare"), {
        price: "9.99",
        currency: "USD",
        inStock: true,
      });

      expect((await getCigarPricing(h.deps, cigarId))!.bestSingle).toBeNull();
    });

    it("ignores a hidden vendor's single, exactly as `lowest` does (ADR-015)", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Hidden Single Toro", brand: "Single" });
      const shown = await addVendor("Single Shown Shop");
      const [hidden] = await h.deps.db
        .insert(vendors)
        .values({ name: "Single Hidden Shop", displayEnabled: false })
        .returning({ id: vendors.id });
      await addOffer(shown, await addMatch(shown, cigarId, "hidden-shown"), {
        price: "11.59",
        currency: "USD",
        inStock: true,
        packaging: "single",
        sticksPerPackage: 1,
        pricePerStickCents: 1159,
      });
      await addOffer(hidden!.id, await addMatch(hidden!.id, cigarId, "hidden-hidden"), {
        price: "8.00",
        currency: "USD",
        inStock: true,
        packaging: "single",
        sticksPerPackage: 1,
        pricePerStickCents: 800,
      });

      const pricing = await getCigarPricing(h.deps, cigarId);
      expect(pricing!.bestSingle).toMatchObject({ amount: 11.59, vendor: "Single Shown Shop" });
      expect(pricing!.lowest).toMatchObject({ amount: 11.59 });
    });

    it("takes a shop's CURRENT single, not its cheaper older one — the rule `lowest` follows", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Risen Single Toro", brand: "Single" });
      const shop = await addVendor("Single Risen Shop");
      const match = await addMatch(shop, cigarId, "risen-single");
      await addOffer(shop, match, {
        price: "9.00",
        currency: "USD",
        inStock: true,
        packaging: "single",
        sticksPerPackage: 1,
        pricePerStickCents: 900,
        seenAt: new Date("2026-06-01T00:00:00Z"),
      });
      await addOffer(shop, match, {
        price: "11.59",
        currency: "USD",
        inStock: true,
        packaging: "single",
        sticksPerPackage: 1,
        pricePerStickCents: 1159,
        seenAt: new Date("2026-08-20T00:00:00Z"),
      });

      const pricing = await getCigarPricing(h.deps, cigarId);
      expect(pricing!.bestSingle).toMatchObject({
        amount: 11.59,
        seenAt: "2026-08-20T00:00:00.000Z",
      });
      expect(pricing!.lowest).toMatchObject({ amount: 11.59 });
    });

    it("falls back to an out-of-stock single rather than leaving the fact unsaid", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Sold Out Single", brand: "Single" });
      const shop = await addVendor("Single Sold Out Shop");
      await addOffer(shop, await addMatch(shop, cigarId, "sold-out-single"), {
        price: "11.59",
        currency: "USD",
        inStock: false,
        packaging: "single",
        sticksPerPackage: 1,
        pricePerStickCents: 1159,
      });
      await addOffer(shop, await addMatch(shop, cigarId, "sold-out-box"), {
        price: "210.00",
        currency: "USD",
        inStock: true,
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStickCents: 1050,
      });

      const pricing = await getCigarPricing(h.deps, cigarId);
      expect(pricing!.lowest).toMatchObject({ amount: 10.5, packaging: "box" });
      expect(pricing!.bestSingle).toMatchObject({ amount: 11.59 });
    });
  });
});
