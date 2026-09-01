import type { BrandImageRights } from "@cj/domain";

// Reader-facing names for the domain keys the review console renders (DESIGN-003
// §Copy). The domain returns its own vocabulary — `listingMatches`,
// `listing_match.set_status`, `suppressed` — and none of it is console copy. Every
// map is read as `LABELS[key] ?? key`: an unmapped key falls back to itself rather
// than to a guess, so a new domain action is ugly for one release instead of
// silently mislabelled.

// The ledger slots a merge moved.
export const MOVED_LABELS: Record<string, string> = {
  smokes: "Smokes",
  purchases: "Purchases",
  listingMatches: "Listing matches",
  offers: "Offers",
  // "Review scores", not "Reviews": these rows hold a score, a link and at most a
  // sentence — never the review — and the console should not promise otherwise.
  reviewObservations: "Review scores",
  productPhotos: "Photos",
  enrichmentRequests: "Gap-fill requests",
  wants: "Wants",
  favorites: "Favorites",
};

// Brand-image display gating, the same three states as ProductPhotoRights. The
// console's own buttons are `Approve` and `Suppress`; these are the states those
// actions leave behind.
// `satisfies` keeps the map exhaustive over the union at compile time; the index
// signature keeps the runtime fallback honest, because the value arrives from the
// database and a migration can add a state before this file learns it.
export const RIGHTS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  suppressed: "Suppressed",
} satisfies Record<BrandImageRights, string>;

// The audit actions a run is made of. Scoped to the vocabulary the console
// already reads — every action `summarizeAudit` (domain/curation.ts) writes a
// before→after line for — so a label and its summary can never describe different
// deeds. Each is the deed in the past tense, because an audit row is a record of
// something already done.
export const ACTION_LABELS: Record<string, string> = {
  "cigar.add": "Added",
  "cigar.update": "Updated",
  "cigar.verify": "Verified",
  "cigar.unverify": "Verification cleared",
  "cigar.exclude": "Excluded",
  "cigar.restore": "Restored",
  "cigar.rename": "Renamed",
  "cigar.merge": "Merged",
  "cigar.unmerge": "Unmerged",
  "cigar.dismiss_duplicate": "Duplicate dismissed",
  "cigar.set_facts": "Facts set",
  "cigar.assign_parts": "Parts assigned",
  "cigar.split": "Split",
  "cigar.split_leaf": "Leaf split",
  "cigar.enrichment_request": "Gap-fill requested",
  "listing_match.set_status": "Listing match set",
  "product_photo.attach": "Photo attached",
  "product_photo.set_rights": "Photo rights set",
  "brand_image.choose": "Brand image chosen",
  "brand_image.set_rights": "Brand image rights set",
  "brand.create": "Brand minted",
  "line.create": "Line minted",
  "blend.create": "Blend minted",
  "blender.create": "Blender minted",
  "brand.set_aliases": "Brand aliases set",
  "line.set_aliases": "Line aliases set",
  "blend.set_aliases": "Blend aliases set",
  "blender.set_aliases": "Blender aliases set",
  "blend.credit_blender": "Blender credited",
  "price.record": "Price recorded",
  "review.record": "Review score recorded",
  "review.amend": "Review score amended",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
