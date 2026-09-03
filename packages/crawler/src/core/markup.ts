// The one place a page is turned into a product + a category + the URL its photo
// is fetched from, per the adapter's declaration (ADR-006 amendments 2026-09-02,
// issues #252 and #270). Two structured sources now exist — JSON-LD and
// OpenGraph/microdata — three category sources — the breadcrumb trail, the
// vendor's keywords tag list, and the JSON-LD `category` string — and two photo
// sources. Which combination runs is read from the adapter, never from the page,
// and every caller (both ingest walks and the probe) goes through here so the
// combinations cannot drift apart.

import { extractJsonLd, productImageUrl, type JsonLdProduct } from "./jsonld.js";
import { extractKeywords, extractOgImage, extractOpenGraphProduct } from "./opengraph.js";
import { extractVariantPrices, type VariantPrice } from "./variant-prices.js";
import type { CategorySource, PhotoUrlRewrite, ProductMarkup, VendorAdapter } from "../adapters/types.js";

export interface ExtractedMarkup {
  product: JsonLdProduct | null;
  // Which extractor produced the node, carried out with it because it says what
  // the node's OTHER fields may be trusted to mean: an OG `description` is the
  // shop's own spec line, a JSON-LD one is marketing prose (`normalizeListing`,
  // packaging-from-description).
  productMarkup: ProductMarkup;
  // The taxonomy as the page states it, in the shape `categorySource` names —
  // a trail ending with the product, a tag list, or the `category` string split
  // on its separators. `normalizeListing` is told which, and reads it accordingly.
  category: string[];
  categorySource: CategorySource;
  // THE URL THE CATALOGUE PHOTO IS FETCHED FROM, and nothing else: the listing's
  // `imageUrl` and the offer's raw payload keep what the markup published. Null
  // when the page names no image, which `capturePhoto` reads as "no photo".
  photoUrl: string | null;
  // The page's declared HTML per-pack prices (ADR-015, `adapter.variantPrices`).
  // Empty for every vendor that declares no source. Read by `normalizeListing`.
  variants: VariantPrice[];
  // DID THIS PAGE STATE THE VENDOR'S OWN STRUCTURED TAXONOMY, whether or not it
  // carried a product? Only a JSON-LD vendor can: it is the BreadcrumbList, the
  // trail every page of such a catalogue publishes, and an OpenGraph vendor's
  // product pages state none at all (2 Guys' is "Home / <brand>" by design), so
  // this is false there without qualification.
  //
  // It exists because the enrich drain has to tell apart two page shapes that a
  // 200 alone cannot (#270): Small Batch's BRAND and LINE landing pages, which
  // sit at product-shaped one-segment URLs and ARE a real read of the shop's
  // shelf, versus a page carrying no structured markup at all, which says
  // nothing about any catalogue. See `tryEnrichCandidates`.
  catalogTaxonomy: boolean;
}

// The JSON-LD Product's own taxonomy string. Split on `>` or `/` because both
// spellings are in the wild for a path; a single term (EGM's `"Cigars"`) is one
// element. Taxonomy end to end — unlike a breadcrumb trail it does not end with
// the product — so `normalizeListing` keeps all of it.
function jsonLdCategoryPath(product: JsonLdProduct | null): string[] {
  const raw = product?.category;
  const value = Array.isArray(raw) ? raw.join(" > ") : raw;
  if (typeof value !== "string") return [];
  return value
    .split(/[>/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

// Correct the photo URL the page stated. `String.replace` substitutes once, so an
// adapter's pattern needs no `g` flag; "strip-query" drops the query and fragment,
// which is how a Magento resize (`?width=265&height=265&…`) becomes the full-size
// asset J.J. Fox serves at the bare path.
export function rewritePhotoUrl(url: string, rewrite: PhotoUrlRewrite | undefined): string {
  if (rewrite === undefined) return url;
  if (rewrite === "strip-query") return url.split(/[?#]/)[0] ?? url;
  return url.replace(rewrite.pattern, rewrite.replacement);
}

export function extractProductMarkup(html: string, adapter: VendorAdapter): ExtractedMarkup {
  const categorySource = adapter.categorySource ?? "breadcrumbs";
  const productMarkup = adapter.productMarkup ?? "json-ld";
  // Only the JSON-LD side carries a breadcrumb trail: an OG vendor's product page
  // states none (2 Guys' is "Home / <brand>" by design). Declaring "opengraph"
  // with the breadcrumb category source therefore yields an EMPTY path, which
  // `isCigarListing` refuses — a stated refusal, not a silent admit.
  const { product, breadcrumbs } =
    productMarkup === "opengraph"
      ? { product: extractOpenGraphProduct(html), breadcrumbs: [] as string[] }
      : extractJsonLd(html);

  const category =
    categorySource === "keywords-meta"
      ? extractKeywords(html)
      : categorySource === "json-ld-category"
        ? jsonLdCategoryPath(product)
        : breadcrumbs;

  // An OG vendor's product node already carries `og:image`, so the default source
  // is that vendor's og image without declaring anything; a JSON-LD vendor
  // declares "og:image" only where its `image` is absent (EGM's ProductGroup
  // names none) or is a thumbnail (Cigarworld's 300x51).
  const statedPhoto =
    adapter.photoSource === "og:image" ? extractOgImage(html) : productImageUrl(product?.image);
  const photoUrl =
    product && statedPhoto ? rewritePhotoUrl(statedPhoto, adapter.photoUrlRewrite) : null;

  return {
    product,
    productMarkup,
    category,
    categorySource,
    photoUrl,
    // Read for EVERY page, product or not: a landing page has no product and its
    // variant list is empty, and a grouped product's is where its prices live.
    variants: extractVariantPrices(html, adapter.variantPrices),
    catalogTaxonomy: breadcrumbs.length > 0,
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
