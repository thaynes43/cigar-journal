// The one packaging vocabulary the price surfaces share (DESIGN-005). The web's
// tier blocks, the tile's `from`, and get_offers' row order all read the same two
// facts off an offer — which tier a buyer would file it under, and what that tier
// is CALLED — so a shop's label can never mean one thing on the cigar page and
// another in the tool payload.
//
// The tiers are the order a buyer thinks in (DESIGN-005 rule 2), and the last one
// is the honesty rule ADR-009 and DESIGN-005 rule 1 both turn on: an offer whose
// packaging nobody recorded is `Not stated`, sorts last, and is never a stick
// price.

export const TIER_SINGLE = 0;
export const TIER_PACK = 1;
export const TIER_BOX = 2;
export const TIER_NOT_STATED = 3;

export interface PackagingTier {
  // Sort rank: single → packs and bundles → box → packaging not stated.
  order: number;
  // The heading the tier block carries (DESIGN-005 §Strings): `Single`, `5-pack`,
  // `Box of 20`, `Bundle of 10`, `Box`/`Pack` when the count is unknown,
  // `Not stated`.
  label: string;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function packagingTier(
  packaging: string | null,
  sticksPerPackage: number | null,
): PackagingTier {
  const stated = packaging?.trim();
  if (!stated) return { order: TIER_NOT_STATED, label: "Not stated" };

  const lower = stated.toLowerCase();
  // A single is the tier bestSingle answers for, and it is the one tier whose
  // stick count is the whole claim — either the shop said "single" or the row
  // carries one stick.
  if (lower === "single" || lower === "singles" || sticksPerPackage === 1) {
    return { order: TIER_SINGLE, label: "Single" };
  }

  // A label that already names its count is the shop's own word for the tier and
  // is kept verbatim (`5-pack`); one that does not gains the count when the row
  // carries it (`box` + 20 → `Box of 20`) and stands alone when it does not
  // (`Box`, `Pack`) — a count is never invented to fill the shape.
  const label = /\d/.test(stated)
    ? stated
    : sticksPerPackage != null && sticksPerPackage > 1
      ? `${capitalize(lower)} of ${sticksPerPackage}`
      : capitalize(lower);
  return { order: lower.includes("box") ? TIER_BOX : TIER_PACK, label };
}

// The fields the display order reads. Structural rather than `CigarOffer`, so the
// web can order a projection and the tests can order a literal.
export interface OfferOrderFields {
  packaging: string | null;
  sticksPerPackage: number | null;
  pricePerStick: number | null;
  price: number | null;
  inStock: boolean | null;
  seenAt: string;
  vendor: string;
}

// DESIGN-005 rule 2, as a comparator: tier, then ascending stick count inside a
// tier (a 5-pack before a 10-pack, a box of 20 before a box of 25), then — within
// one tier block — best per-stick first, in stock before out of stock, then most
// recently seen.
//
// The package price is the tiebreak between rows with NO derivable per-stick,
// because in the `Not stated` block that price IS the figure on screen; it also
// keeps the pre-DESIGN-005 order of unpackaged rows intact.
export function compareOffersByTier(a: OfferOrderFields, b: OfferOrderFields): number {
  const ta = packagingTier(a.packaging, a.sticksPerPackage);
  const tb = packagingTier(b.packaging, b.sticksPerPackage);
  return (
    ta.order - tb.order ||
    (a.sticksPerPackage ?? 0) - (b.sticksPerPackage ?? 0) ||
    ta.label.localeCompare(tb.label) ||
    nullsLast(a.pricePerStick, b.pricePerStick) ||
    nullsLast(a.price, b.price) ||
    Number(a.inStock === false) - Number(b.inStock === false) ||
    b.seenAt.localeCompare(a.seenAt) ||
    a.vendor.localeCompare(b.vendor)
  );
}

// Ascending, with "no figure at all" sorting after every figure — the same
// NULLS LAST the offer SQL uses.
function nullsLast(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}
