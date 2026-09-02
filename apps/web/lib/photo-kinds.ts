import type { SmokePhotoKind } from "@cj/domain";

// The photo kinds, in the order the drop page offers them (ADR-014). The values
// are the domain's own (@cj/db smoke_photos.kind, CHECK-constrained in migration
// 0033); the labels are the only place they are written for a reader.
//
// Both the routes and the page read this list: the routes because a kind arrives
// on an anonymous request and a `text` column will happily take any string, the
// page because it renders one chip per kind. Type-only import, so it is erased
// from the client bundle.
export const PHOTO_KINDS = ["cigar", "band", "construction", "burn", "other"] as const;

export const PHOTO_KIND_LABEL: Record<SmokePhotoKind, string> = {
  cigar: "Cigar",
  band: "Band",
  construction: "Construction",
  burn: "Burn",
  other: "Other",
};

export function isSmokePhotoKind(value: unknown): value is SmokePhotoKind {
  return typeof value === "string" && (PHOTO_KINDS as readonly string[]).includes(value);
}
