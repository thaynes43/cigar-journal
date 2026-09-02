import { describe, expect, it } from "vitest";
import type { CigarOffer, CigarPricing } from "@cj/domain";
import {
  isPricedOffer,
  offerTiers,
  packagingDescriptor,
  priceHeadline,
  priceSectionState,
} from "./price-panel";

// DESIGN-002 §Price draws two different no-offer outcomes, and the difference is
// the whole rule: a seeded cigar nothing ever priced shows no Price section at
// all, while a cigar whose offers have lapsed says so.

describe("isPricedOffer", () => {
  it("keeps a row carrying either figure", () => {
    expect(isPricedOffer({ price: 142, pricePerStick: null })).toBe(true);
    expect(isPricedOffer({ price: null, pricePerStick: 7.1 })).toBe(true);
  });

  it("rejects a row carrying neither — it is not an offer", () => {
    expect(isPricedOffer({ price: null, pricePerStick: null })).toBe(false);
  });
});

describe("priceSectionState", () => {
  it("renders the vendor rows when a current offer carries a price", () => {
    expect(priceSectionState(2, 9)).toBe("offers");
  });

  it("is absent for a cigar nobody ever observed an offer for", () => {
    expect(priceSectionState(0, 0)).toBe("absent");
  });

  it("says the offers lapsed once observations exist but none is current", () => {
    expect(priceSectionState(0, 4)).toBe("lapsed");
  });

  // The delta this closes (#219, filed from #218): the gate used to read the
  // per-stick price history, which counts only observations with a derivable
  // per-stick figure. A cigar whose offers were all package-only therefore had an
  // empty price history and read as never-offered — the section vanished instead
  // of saying the offers had lapsed. The offer series counts the observation
  // either way.
  it("still says lapsed when the observations never carried a per-stick figure", () => {
    const offers = [
      { price: null, pricePerStick: null },
      { price: null, pricePerStick: null },
    ];
    const observationCount = 6; // recorded offers, none of them per-stick priced
    expect(priceSectionState(offers.filter(isPricedOffer).length, observationCount)).toBe("lapsed");
  });
});

function offer(over: Partial<CigarOffer>): CigarOffer {
  return {
    vendor: "Shop",
    isRegistryVendor: true,
    purchaseLinkout: true,
    price: null,
    currency: "USD",
    inStock: true,
    listingUrl: null,
    seenAt: "2026-09-02T00:00:00.000Z",
    packaging: null,
    sticksPerPackage: null,
    pricePerStick: null,
    priceType: "retail",
    ...over,
  };
}

// DESIGN-005's mock, as data: a single, a 5-pack, a box two shops carry, and one
// listing whose packaging nobody recorded.
const SINGLE = offer({
  vendor: "2 Guys Cigars",
  packaging: "single",
  sticksPerPackage: 1,
  price: 11.59,
  pricePerStick: 11.59,
});
const FIVE = offer({
  vendor: "Small Batch Cigar",
  packaging: "5-pack",
  sticksPerPackage: 5,
  price: 55,
  pricePerStick: 11,
});
const BOX = offer({
  vendor: "2 Guys Cigars",
  packaging: "box",
  sticksPerPackage: 20,
  price: 210,
  pricePerStick: 10.5,
});
const BOX_DEARER = offer({
  vendor: "Fox Cigar",
  packaging: "box",
  sticksPerPackage: 20,
  price: 224,
  pricePerStick: 11.2,
  inStock: false,
});
const BARE = offer({ vendor: "Cuban Lou's", price: 452.6, purchaseLinkout: false });

describe("packagingDescriptor", () => {
  it("quotes the packaging a price came at, gaining its count when the row has one", () => {
    expect(packagingDescriptor({ packaging: "box", sticksPerPackage: 20 })).toBe("box of 20");
    expect(packagingDescriptor({ packaging: "5-pack", sticksPerPackage: 5 })).toBe("5-pack");
    expect(packagingDescriptor({ packaging: "single", sticksPerPackage: 1 })).toBe("single");
  });

  it("says so when nobody recorded one — never a bare package price (DESIGN-005 rule 1)", () => {
    expect(packagingDescriptor({ packaging: null, sticksPerPackage: null })).toBe(
      "packaging not stated",
    );
  });
});

describe("offerTiers", () => {
  it("makes one block per packaging label, each carrying its best per-stick", () => {
    const tiers = offerTiers([SINGLE, FIVE, BOX, BOX_DEARER, BARE]);
    expect(tiers.map((t) => [t.label, t.bestPerStick])).toEqual([
      ["Single", 11.59],
      ["5-pack", 11],
      ["Box of 20", 10.5],
      ["Not stated", null],
    ]);
    // The two shops carrying the box share its block rather than each getting one.
    expect(tiers[2]!.offers.map((o) => o.vendor)).toEqual(["2 Guys Cigars", "Fox Cigar"]);
  });

  it("never derives a per-stick for the Not stated block", () => {
    const tiers = offerTiers([offer({ price: 452.6, pricePerStick: 22.63 })]);
    expect(tiers[0]!.label).toBe("Not stated");
    expect(tiers[0]!.bestPerStick).toBeNull();
  });
});

function pricing(over: Partial<CigarPricing>): CigarPricing {
  return {
    lowest: null,
    bestSingle: null,
    currency: "USD",
    observedAt: "2026-09-02T00:00:00.000Z",
    sourceCount: 1,
    observationCount: 1,
    refreshRecommended: false,
    ...over,
  };
}

const BEST_SINGLE = {
  amount: 11.59,
  currency: "USD",
  vendor: "2 Guys Cigars",
  seenAt: "2026-09-02T00:00:00.000Z",
};

describe("priceHeadline — two facts, not one (DESIGN-005 rule 4)", () => {
  it("leads with the best per-stick and its packaging, then the cheapest single", () => {
    const tiers = offerTiers([SINGLE, FIVE, BOX, BOX_DEARER, BARE]);
    expect(
      priceHeadline(
        pricing({
          lowest: { perStick: true, amount: 10.5, packaging: "box", sticksPerPackage: 20 },
          bestSingle: BEST_SINGLE,
        }),
        tiers,
      ),
    ).toEqual({ lead: "from $10.50/stick · box of 20", singles: "singles from $11.59" });
  });

  it("drops `from` and the second half when singles are all there is", () => {
    expect(
      priceHeadline(
        pricing({
          lowest: { perStick: true, amount: 11.59, packaging: "single", sticksPerPackage: 1 },
          bestSingle: BEST_SINGLE,
        }),
        offerTiers([SINGLE]),
      ),
    ).toEqual({ lead: "$11.59/stick · single", singles: null });
  });

  it("says the same figure once — a single that IS the best per-stick adds nothing", () => {
    expect(
      priceHeadline(
        pricing({
          lowest: { perStick: true, amount: 11.59, packaging: "single", sticksPerPackage: 1 },
          bestSingle: BEST_SINGLE,
        }),
        offerTiers([SINGLE, BOX_DEARER]),
      ),
    ).toEqual({ lead: "from $11.59/stick · single", singles: null });
  });

  it("quotes a package price as a package price, with the not-stated words", () => {
    expect(
      priceHeadline(
        pricing({
          lowest: { perStick: false, amount: 452.6, packaging: null, sticksPerPackage: null },
        }),
        offerTiers([BARE]),
      ),
    ).toEqual({ lead: "$452.60 · packaging not stated", singles: null });
  });

  it("is absent for a cigar with no pricing summary at all", () => {
    expect(priceHeadline(null, [])).toBeNull();
  });
});
