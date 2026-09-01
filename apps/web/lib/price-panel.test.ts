import { describe, expect, it } from "vitest";
import { isPricedOffer, priceSectionState } from "./price-panel";

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
