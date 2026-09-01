import type { CigarOffer } from "@cj/domain";

// The Price section's two no-offer cases (DESIGN-002 §Price). The design draws a
// line the detail page has to draw with it: "no current offer = section absent on
// seeded cigars that never matched, or an explicit `No current offers.` line when
// offers existed before". Kept here, out of the page, so the rule is testable
// without a rendered server component.

// A row is an offer only if it carries a figure. Both price columns are nullable
// and a row with neither is not an offer — it used to render as a bare "—" under
// the Price heading, which reads as a price.
export function isPricedOffer(offer: Pick<CigarOffer, "price" | "pricePerStick">): boolean {
  return offer.pricePerStick != null || offer.price != null;
}

export type PriceSectionState =
  // Nothing true to say about price: no section at all (absent-when-empty).
  | "absent"
  // Offers existed and none is current: the `No current offers.` line.
  | "lapsed"
  // At least one current, priced offer: the vendor rows.
  | "offers";

// `observationCount` is the WHOLE offer series (cigars.offerHistory), not the
// per-stick price history: an offer observed without a derivable per-stick figure
// still happened, and a cigar whose offers were all package-only has genuinely
// lapsed rather than never having been offered.
export function priceSectionState(
  pricedOfferCount: number,
  observationCount: number,
): PriceSectionState {
  if (pricedOfferCount > 0) return "offers";
  return observationCount > 0 ? "lapsed" : "absent";
}
