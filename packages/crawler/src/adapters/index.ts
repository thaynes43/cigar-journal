import type { VendorAdapter } from "./types.js";
import { foxCigar } from "./fox-cigar.js";
import { twoGuysCigars } from "./two-guys-cigars.js";
import { smallBatchCigar } from "./small-batch-cigar.js";
import { cubanLous } from "./cuban-lous.js";

export { foxCigar } from "./fox-cigar.js";
export { twoGuysCigars } from "./two-guys-cigars.js";
export { smallBatchCigar } from "./small-batch-cigar.js";
export { cubanLous } from "./cuban-lous.js";
export type { VendorAdapter } from "./types.js";

// The adapter registry — slug → adapter. Admin data in code for now (ADR-006:
// the vendor registry is admin-managed, the admin UI lands later). Each adapter
// carries its own registry posture (focus/approval/linkout/crawlEnabled); the
// CLI's resolveVendor seeds the vendors row from it. Only Fox is probe-verified
// (crawlEnabled true); the rest ship crawlEnabled false until the coordinator's
// in-cluster probe passes a live robots/ToS read.
export const adapters: Record<string, VendorAdapter> = {
  [foxCigar.slug]: foxCigar,
  [twoGuysCigars.slug]: twoGuysCigars,
  [smallBatchCigar.slug]: smallBatchCigar,
  [cubanLous.slug]: cubanLous,
};

export function getAdapter(slug: string): VendorAdapter | undefined {
  return adapters[slug];
}

// THE OTHER KEY, and it is the one the registry actually joins on. `resolveVendor`
// looks a row up by `vendors.name`, so a fleet walk that starts from the registry
// (`--all-enabled`) has to come back the same way — a slug never appears in the
// database. Names are unique per shop in practice and a duplicate would simply
// share an adapter, which is what a duplicate row means anyway.
export function getAdapterByName(name: string): VendorAdapter | undefined {
  return Object.values(adapters).find((adapter) => adapter.name === name);
}

export function adapterSlugs(): string[] {
  return Object.keys(adapters);
}
