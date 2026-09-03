import type { VendorAdapter } from "./types.js";
import { foxCigar } from "./fox-cigar.js";
import { twoGuysCigars } from "./two-guys-cigars.js";
import { smallBatchCigar } from "./small-batch-cigar.js";
import { cubanLous } from "./cuban-lous.js";
import { montefortuna } from "./montefortuna.js";
import { egmCigars } from "./egm-cigars.js";
import { cigarworldDe } from "./cigarworld-de.js";
import { jjFox } from "./jj-fox.js";
import { halfwheel } from "./halfwheel.js";

export { foxCigar } from "./fox-cigar.js";
export { twoGuysCigars } from "./two-guys-cigars.js";
export { smallBatchCigar } from "./small-batch-cigar.js";
export { cubanLous } from "./cuban-lous.js";
export { montefortuna } from "./montefortuna.js";
export { egmCigars } from "./egm-cigars.js";
export { cigarworldDe } from "./cigarworld-de.js";
export { jjFox } from "./jj-fox.js";
export { halfwheel } from "./halfwheel.js";
export type { VendorAdapter } from "./types.js";

// The adapter registry — slug → adapter. Admin data in code for now (ADR-006:
// the vendor registry is admin-managed, the admin UI lands later). Each adapter
// carries its own registry posture (focus/approval/linkout/crawlEnabled/tier);
// the CLI's resolveVendor seeds the vendors row from it. Only Fox is
// probe-verified (crawlEnabled true); the rest ship crawlEnabled false until the
// coordinator's in-cluster probe passes a live robots/ToS read.
//
// Listed in tier order, which is also the order `--all-enabled` walks the fleet
// (ADR-015): the tier-1 NC shops, then the Habanos picture sources tier 2..5
// added 2026-09-02 (#270), whose offers are recorded and never displayed and
// whose job is the one catalogue-photo slot and the enrich drain's fallback.
//
// halfwheel closes the list at tier 9 and is NOT A SHOP (ADR-013 §4, #199 slice
// 2a): `kind: "reviewer"`, no `focus`, no linkout, and a lane that walks a review
// archive instead of a sitemap. It sorts last because it competes for none of the
// three things a tier orders — it publishes no offers, takes no enrich asks and
// writes no photos — so its position can never be read as authority over a shop.
export const adapters: Record<string, VendorAdapter> = {
  [foxCigar.slug]: foxCigar,
  [twoGuysCigars.slug]: twoGuysCigars,
  [smallBatchCigar.slug]: smallBatchCigar,
  [cubanLous.slug]: cubanLous,
  [montefortuna.slug]: montefortuna,
  [egmCigars.slug]: egmCigars,
  [cigarworldDe.slug]: cigarworldDe,
  [jjFox.slug]: jjFox,
  [halfwheel.slug]: halfwheel,
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
