// The one place a page is turned into a product + a category, per the adapter's
// declaration (ADR-006 amendment 2026-09-02, issue #252). Two structured sources
// now exist — JSON-LD and OpenGraph/microdata — and two category sources — the
// breadcrumb trail and the vendor's keywords tag list. Which pair runs is read
// from the adapter, never from the page, and every caller (both ingest walks and
// the probe) goes through here so the four combinations cannot drift apart.

import { extractJsonLd, type JsonLdProduct } from "./jsonld.js";
import { extractKeywords, extractOpenGraphProduct } from "./opengraph.js";
import type { CategorySource, VendorAdapter } from "../adapters/types.js";

export interface ExtractedMarkup {
  product: JsonLdProduct | null;
  // The taxonomy as the page states it, in the shape `categorySource` names —
  // a trail ending with the product, or a tag list. `normalizeListing` is told
  // which, and reads it accordingly.
  category: string[];
  categorySource: CategorySource;
}

export function extractProductMarkup(html: string, adapter: VendorAdapter): ExtractedMarkup {
  const categorySource = adapter.categorySource ?? "breadcrumbs";
  // Only the JSON-LD side carries a breadcrumb trail: an OG vendor's product page
  // states none (2 Guys' is "Home / <brand>" by design). Declaring "opengraph"
  // with the breadcrumb category source therefore yields an EMPTY path, which
  // `isCigarListing` refuses — a stated refusal, not a silent admit.
  const { product, breadcrumbs } =
    adapter.productMarkup === "opengraph"
      ? { product: extractOpenGraphProduct(html), breadcrumbs: [] as string[] }
      : extractJsonLd(html);

  return {
    product,
    category: categorySource === "keywords-meta" ? extractKeywords(html) : breadcrumbs,
    categorySource,
  };
}

// What a probe note calls the markup it did not find. Naming the DECLARED format
// is the whole point of the note: "no schema.org Product JSON-LD" on a vendor
// that never served any was the misattribution #217 spent a probe round-trip on.
export function markupLabel(adapter: VendorAdapter): string {
  return adapter.productMarkup === "opengraph"
    ? "OpenGraph/microdata product markup"
    : "schema.org Product JSON-LD";
}
