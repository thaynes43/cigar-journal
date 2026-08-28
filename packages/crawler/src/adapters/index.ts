import type { VendorAdapter } from "./types.js";
import { foxCigar } from "./fox-cigar.js";

export { foxCigar } from "./fox-cigar.js";
export type { VendorAdapter } from "./types.js";

// The adapter registry — slug → adapter. Admin data in code for now (ADR-006:
// the vendor registry is admin-managed, the admin UI lands later). Fox Cigar is
// the only enabled adapter; more NC/CC vendors slot in here as they pass a live
// robots/ToS read.
export const adapters: Record<string, VendorAdapter> = {
  [foxCigar.slug]: foxCigar,
};

export function getAdapter(slug: string): VendorAdapter | undefined {
  return adapters[slug];
}

export function adapterSlugs(): string[] {
  return Object.keys(adapters);
}
