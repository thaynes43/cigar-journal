import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vendors, listingMatches, offers } from "@cj/db";
import { createHarness, type DomainHarness } from "./testing/harness.js";
import { getCigar, getCigarOffers, getCigarOfferHistory, getCigarPriceHistory } from "./reads.js";
import { browseCatalog } from "./catalog-browse.js";
import { curationQueue } from "./curation.js";
import type { Principal } from "./deps.js";

// ADR-015's price half: prices are RECORDED from every crawled vendor and
// DISPLAYED only from tier 1, through `display_enabled`. One test per surface
// that puts a price in front of a user, each arranged the same way — the SAME
// cigar priced by a display-enabled vendor and by one that is not — so every
// assertion is "the second vendor is absent and the first is untouched".
// Admin reads see both, and the offers are still in the table either way.
describe("offer display gate (ADR-015)", () => {
  let h: DomainHarness;
  let user: Principal;
  let curator: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("shopper@example.com");
    curator = await h.createUser("curator@example.com", "admin");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // `displayEnabled` is always passed explicitly: the column defaults to FALSE
  // (ADR-015 — "nobody has decided" must not mean "price authority"), so a
  // fixture that omits it is a hidden vendor whether or not the test meant one.
  async function addVendor(name: string, displayEnabled: boolean): Promise<string> {
    const [v] = await h.deps.db
      .insert(vendors)
      .values({ name, focus: "NC", tier: displayEnabled ? 1 : 2, displayEnabled })
      .returning({ id: vendors.id });
    return v!.id;
  }

  // A crawler observation: it reaches the cigar through a confirmed listing
  // match, which is the ONLY gate these reads had before this change.
  async function addCrawlerOffer(
    vendorId: string,
    cigarId: string,
    over: Partial<typeof offers.$inferInsert> = {},
  ): Promise<void> {
    const [m] = await h.deps.db
      .insert(listingMatches)
      .values({ vendorId, cigarId, listingKey: `key-${cigarId}-${vendorId}-${Date.now()}`, status: "confirmed" })
      .returning({ id: listingMatches.id });
    await h.deps.db.insert(offers).values({
      vendorId,
      listingMatchId: m!.id,
      currency: "USD",
      inStock: true,
      packaging: "single",
      sticksPerPackage: 1,
      seenAt: new Date("2026-08-20T00:00:00Z"),
      ...over,
    });
  }

  it("get_cigar's pricing summary reads the displayed vendor only, staleness included", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Gate Padron 1926", brand: "Padron" });
    const shown = await addVendor("Gate Shown Shop", true);
    const hidden = await addVendor("Gate Hidden Shop", false);

    // The hidden vendor is both CHEAPER and FRESHER, so every field of the
    // summary would move if its offer leaked: the lowest price, the source and
    // observation counts, and the 30d staleness flag.
    await addCrawlerOffer(shown, cigarId, {
      price: "12.00",
      pricePerStickCents: 1200,
      seenAt: new Date("2026-06-01T00:00:00Z"),
    });
    await addCrawlerOffer(hidden, cigarId, {
      price: "8.00",
      pricePerStickCents: 800,
      seenAt: new Date("2026-08-25T00:00:00Z"),
    });

    h.setNow(new Date("2026-08-27T12:00:00.000Z"));
    const { pricing } = await getCigar(h.deps, user, { cigarId });
    expect(pricing).not.toBeNull();
    expect(pricing!.lowest).toMatchObject({ perStick: true, amount: 12 });
    expect(pricing!.sourceCount).toBe(1);
    expect(pricing!.observationCount).toBe(1);
    // Stale off the SHOWN observation (2026-06-01), not the hidden fresh one.
    expect(pricing!.refreshRecommended).toBe(true);
  });

  it("get_cigar reports no pricing at all when every vendor pricing the cigar is hidden", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Gate Unpriced Robusto", brand: "Padron" });
    const hidden = await addVendor("Gate Only-Hidden Shop", false);
    await addCrawlerOffer(hidden, cigarId, { price: "9.00", pricePerStickCents: 900 });

    const { pricing } = await getCigar(h.deps, user, { cigarId });
    expect(pricing).toBeNull();
  });

  it("get_offers drops a hidden vendor from the current offers and from the history", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Gate Monte No. 2", brand: "Montecristo" });
    const shown = await addVendor("Gate Offers Shown", true);
    const hidden = await addVendor("Gate Offers Hidden", false);
    await addCrawlerOffer(shown, cigarId, { price: "20.00", pricePerStickCents: 2000 });
    await addCrawlerOffer(hidden, cigarId, { price: "5.00", pricePerStickCents: 500 });

    const current = await getCigarOffers(h.deps, { cigarId });
    expect(current.map((o) => o.vendor)).toEqual(["Gate Offers Shown"]);

    // The history is the same observation set aggregated, so it must agree with
    // the list above — a min per-stick of $5 under a cheapest offer of $20 would
    // be the gate applied to one query and not the other.
    const history = await getCigarOfferHistory(h.deps, { cigarId });
    expect(history.observationCount).toBe(1);
    expect(history.minPricePerStick).toBe(20);
    expect(history.maxPricePerStick).toBe(20);
  });

  it("the price-history line carries no points from a hidden vendor", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Gate Ashton VSG", brand: "Ashton" });
    const shown = await addVendor("Gate History Shown", true);
    const hidden = await addVendor("Gate History Hidden", false);
    await addCrawlerOffer(shown, cigarId, {
      price: "14.00",
      pricePerStickCents: 1400,
      seenAt: new Date("2026-07-01T00:00:00Z"),
    });
    await addCrawlerOffer(hidden, cigarId, {
      price: "6.00",
      pricePerStickCents: 600,
      seenAt: new Date("2026-07-15T00:00:00Z"),
    });

    const points = await getCigarPriceHistory(h.deps, { cigarId });
    expect(points.map((p) => p.pricePerStick)).toEqual([14]);
  });

  it("browse_catalog prices, sorts and filters on displayed vendors alone", async () => {
    const brand = "GateBrowse";
    const priced = await h.seedCigar({ canonicalName: `${brand} Priced`, brand });
    const hiddenOnly = await h.seedCigar({ canonicalName: `${brand} HiddenOnly`, brand });
    const shown = await addVendor("Gate Browse Shown", true);
    const hidden = await addVendor("Gate Browse Hidden", false);
    await addCrawlerOffer(shown, priced, { price: "18.00", pricePerStickCents: 1800, inStock: true });
    await addCrawlerOffer(hidden, hiddenOnly, { price: "3.00", pricePerStickCents: 300, inStock: true });

    const tiles = new Map((await browseCatalog(h.deps, user, { q: brand })).cigars.map((c) => [c.cigarId, c]));
    expect(tiles.get(priced)!.price).toMatchObject({ perStick: true, amount: 18 });
    // Priced in the table, unpriced on the tile: that is what "recorded, not
    // displayed" looks like at a glance.
    expect(tiles.get(hiddenOnly)!.price).toBeNull();

    // …so it sorts with the unpriced tail rather than first at $3.00…
    const byPrice = await browseCatalog(h.deps, user, { q: brand, sort: "price" });
    expect(byPrice.cigars.map((c) => c.cigarId)).toEqual([priced, hiddenOnly]);

    // …and its in-stock offer does not answer the inStock filter.
    const inStock = await browseCatalog(h.deps, user, { q: brand, inStock: true });
    expect(inStock.cigars.map((c) => c.cigarId)).toEqual([priced]);
    expect(inStock.totalCount).toBe(1);
  });

  it("a chat observation with no vendor is never gated — it belongs to no tier", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Gate Chat Lancero", brand: "Chat" });
    const hidden = await addVendor("Gate Chat Hidden", false);
    await addCrawlerOffer(hidden, cigarId, { price: "4.00", pricePerStickCents: 400 });
    // ADR-009's other path: no vendor row, a named source, linked straight to the
    // cigar. `display_enabled` has nothing to say about it (offer-display.ts).
    await h.deps.db.insert(offers).values({
      cigarId,
      sourceName: "A shop the owner mentioned",
      currency: "USD",
      price: "15.00",
      pricePerStickCents: 1500,
      packaging: "single",
      sticksPerPackage: 1,
      inStock: true,
      seenAt: new Date("2026-08-20T00:00:00Z"),
    });

    const current = await getCigarOffers(h.deps, { cigarId });
    expect(current.map((o) => o.vendor)).toEqual(["A shop the owner mentioned"]);
    expect(current[0]!.isRegistryVendor).toBe(false);
    const { pricing } = await getCigar(h.deps, user, { cigarId });
    expect(pricing!.lowest).toMatchObject({ amount: 15 });
  });

  it("admin reads still count a hidden vendor's offers — only display is gated", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: "Gate Curation Corona",
      brand: "Curation",
      verification: "unverified",
    });
    const hidden = await addVendor("Gate Curation Hidden", false);
    await addCrawlerOffer(hidden, cigarId, { price: "7.00", pricePerStickCents: 700 });

    // The curator's queue reports the market evidence behind a row whatever the
    // vendor's display posture — the merge/verify decision needs everything the
    // crawl found, and a curator who cannot see the offer cannot judge it.
    const queue = await curationQueue(h.deps, curator);
    const row = queue.unverified.find((c) => c.cigarId === cigarId);
    expect(row?.offerCount).toBe(1);
    // Same cigar, same offer, user-facing: nothing.
    expect((await getCigar(h.deps, user, { cigarId })).pricing).toBeNull();
  });

  it("a display-enabled vendor is unchanged end to end", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Gate Control Toro", brand: "Control" });
    const shown = await addVendor("Gate Control Shop", true);
    await addCrawlerOffer(shown, cigarId, {
      price: "11.00",
      pricePerStickCents: 1100,
      listingUrl: "https://control.example/toro",
    });

    const offersOut = await getCigarOffers(h.deps, { cigarId });
    expect(offersOut).toHaveLength(1);
    expect(offersOut[0]).toMatchObject({
      vendor: "Gate Control Shop",
      isRegistryVendor: true,
      purchaseLinkout: true,
      pricePerStick: 11,
      listingUrl: "https://control.example/toro",
    });
    expect((await getCigarOfferHistory(h.deps, { cigarId })).observationCount).toBe(1);
    expect(await getCigarPriceHistory(h.deps, { cigarId })).toHaveLength(1);
    expect((await getCigar(h.deps, user, { cigarId })).pricing!.sourceCount).toBe(1);
  });
});
