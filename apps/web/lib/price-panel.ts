import {
  packagingTier,
  TIER_NOT_STATED,
  TIER_SINGLE,
  type CigarOffer,
  type CigarPricing,
} from "@cj/domain";
import { formatPrice } from "./format";

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

// ---- Packaging tiers (DESIGN-005) -----------------------------------------

// The packaging descriptor a price is quoted WITH (ADR-009's display rule) in
// running text: the stored label, gaining its count when the row carries one
// ("box" + 20 → "box of 20") and left alone when it already names it ("5-pack").
// A row nobody recorded a packaging for reads as the DESIGN-005 string — the one
// case where the descriptor is not the shop's word but ours.
export const PACKAGING_NOT_STATED = "packaging not stated";

export function packagingDescriptor(offer: {
  packaging: string | null;
  sticksPerPackage: number | null;
}): string {
  if (!offer.packaging) return PACKAGING_NOT_STATED;
  if (offer.sticksPerPackage && offer.sticksPerPackage > 1 && !/\d/.test(offer.packaging)) {
    return `${offer.packaging} of ${offer.sticksPerPackage}`;
  }
  return offer.packaging;
}

// One block of the Price section: the tier's heading label, the best per-stick
// inside it (the figure at the right of the heading), and its vendor rows.
export interface OfferTier {
  label: string;
  order: number;
  // Null for `Not stated`, where a per-stick figure would be exactly the claim
  // DESIGN-005 rule 1 forbids, and for a tier no row derives one from.
  bestPerStick: number | null;
  currency: string | null;
  offers: CigarOffer[];
}

// Group the offers into their tier blocks. `getCigarOffers` already returns the
// rows in DESIGN-005's order, so this GROUPS rather than re-sorts: the page shows
// the same sequence get_offers hands the model, and the two can never disagree
// about which tier a shop's listing belongs to.
export function offerTiers(offers: CigarOffer[]): OfferTier[] {
  const blocks: OfferTier[] = [];
  const byLabel = new Map<string, OfferTier>();
  for (const offer of offers) {
    const { order, label } = packagingTier(offer.packaging, offer.sticksPerPackage);
    let block = byLabel.get(label);
    if (!block) {
      block = { label, order, bestPerStick: null, currency: offer.currency, offers: [] };
      byLabel.set(label, block);
      blocks.push(block);
    }
    block.offers.push(offer);
    if (order !== TIER_NOT_STATED && offer.pricePerStick != null) {
      if (block.bestPerStick == null || offer.pricePerStick < block.bestPerStick) {
        block.bestPerStick = offer.pricePerStick;
        block.currency = offer.currency;
      }
    }
  }
  return blocks;
}

// The two facts of DESIGN-005 rule 4, rendered as `lead` and `singles`: the best
// per-stick with its packaging, and what one stick costs on its own. `singles` is
// null when there is no single, or when the single IS the headline figure — the
// same number twice is not a second fact.
export interface PriceHeadline {
  lead: string;
  singles: string | null;
}

export function priceHeadline(
  pricing: CigarPricing | null,
  tiers: OfferTier[],
): PriceHeadline | null {
  const lowest = pricing?.lowest;
  if (!pricing || !lowest) return null;

  // `from` says "this is the cheapest way in, and it is not a stick" — so a
  // catalogue of singles alone drops it and quotes the stick price flat.
  const onlySingles = tiers.length > 0 && tiers.every((tier) => tier.order === TIER_SINGLE);
  const money = formatPrice(lowest.amount, pricing.currency);
  const descriptor = packagingDescriptor(lowest);
  // A package price is not a per-stick figure and never wears the unit: where
  // per-stick is not derivable the headline quotes the package, with its
  // packaging (or the not-stated words) exactly as ADR-009 requires.
  const lead = lowest.perStick
    ? `${onlySingles ? "" : "from "}${money}/stick · ${descriptor}`
    : `${money} · ${descriptor}`;

  const single = pricing.bestSingle;
  const sameFigure = single != null && lowest.perStick && lowest.amount === single.amount;
  return {
    lead,
    singles:
      single && !onlySingles && !sameFigure
        ? `singles from ${formatPrice(single.amount, single.currency)}`
        : null,
  };
}
