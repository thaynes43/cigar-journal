import { parsePackagingFacts } from "@cj/domain";
import type { JsonLdOffer, JsonLdPriceSpecification, JsonLdProduct } from "./jsonld.js";
import type { CategorySource, VendorAdapter } from "../adapters/types.js";

// A vendor-neutral listing distilled from a schema.org Product + the category the
// page states. Price is carried in integer cents (the offers table stores a
// decimal; ingest converts on write); availability collapses schema.org
// InStock/OutOfStock to a tristate, unknown → null (never guessed).
// `categoryPath` is the taxonomy the cigar gate reasons over, never the product
// name: a breadcrumb trail with its trailing product crumb dropped, or the
// vendor's keywords tag list whole (ADR-006 2026-09-02, `categorySource`).
export interface NormalizedListing {
  name: string;
  priceCents: number | null;
  currency: string | null;
  inStock: boolean | null;
  imageUrl: string | null;
  sku: string | null;
  categoryPath: string[];
  // Packaging tier + count parsed from the listing name/breadcrumb when the vendor
  // exposes it (ADR-009). CONSERVATIVE — an unstated packaging stays null, never
  // guessed. Fed to the offers observation so per-stick can be derived.
  packaging: string | null;
  sticksPerPackage: number | null;
}

// Conservative packaging parse (ADR-009): recognize only unambiguous pack/box
// markers in the product name; anything else stays unknown (null/null). A single
// stick yields sticksPerPackage 1 so per-stick equals the price. Ordered most- to
// least-specific so "box of 20" wins over a lone "20".
//
// The rules moved to @cj/domain (catalog-parse.ts) for matching v2 and this
// delegates to them. ONE vocabulary, deliberately: matching v2 strips packaging
// out of a title before reading it as a name, and if the stripper and this
// recognizer disagreed, a token could come off the name without being recorded
// on the offer — the fact would vanish rather than move. The behaviour here is
// byte-identical to what it was; the definition simply lives where both callers
// can reach it.
export function parsePackaging(name: string): { packaging: string | null; sticksPerPackage: number | null } {
  return parsePackagingFacts(name);
}

function firstOf<T>(value: T | T[] | undefined): T | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function toCents(price: string | number | undefined): number | null {
  if (price == null) return null;
  const numeric = typeof price === "number" ? price : Number.parseFloat(String(price).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

// The first offer's first priceSpecification is the price of record; fall back to
// the offer's own `price`/`priceCurrency` when no priceSpecification is present.
function priceFromOffer(offer: JsonLdOffer | undefined): { cents: number | null; currency: string | null } {
  if (!offer) return { cents: null, currency: null };
  const spec: JsonLdPriceSpecification | undefined = firstOf(offer.priceSpecification);
  const cents = toCents(spec?.price ?? offer.price);
  const currency = spec?.priceCurrency ?? offer.priceCurrency ?? null;
  return { cents, currency };
}

function availabilityToStock(availability: string | undefined): boolean | null {
  if (!availability) return null;
  if (/InStock/i.test(availability)) return true;
  if (/OutOfStock|SoldOut|Discontinued/i.test(availability)) return false;
  return null;
}

function imageUrl(image: JsonLdProduct["image"]): string | null {
  const first = firstOf(image);
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof first.url === "string") return first.url;
  return null;
}

// WooCommerce JSON-LD ships names with HTML entities, sometimes double-encoded
// ("Figurado &amp;amp; House ..."); decode until stable so catalog names are clean.
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#039;": "'",
  "&#8217;": "\u2019",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

export function decodeEntities(raw: string): string {
  let value = raw;
  for (let i = 0; i < 3; i++) {
    const next = value
      .replace(/&(amp|quot|lt|gt|nbsp|#039|#8217);/g, (m) => ENTITIES[m] ?? m)
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
    if (next === value) break;
    value = next;
  }
  return value;
}

// The category as the adapter declared its source (ADR-006 2026-09-02). A
// breadcrumb trail ENDS WITH THE PRODUCT, so its last crumb is dropped and the
// taxonomy remains; a keywords tag list is taxonomy end to end and is taken
// whole — dropping its last token would throw away a real category on any page
// whose tags happen to end with one.
function categoryPathFrom(category: string[], source: CategorySource): string[] {
  if (source === "keywords-meta") return [...category];
  return category.length > 1 ? category.slice(0, -1) : [...category];
}

export function normalizeListing(
  product: JsonLdProduct,
  category: string[],
  categorySource: CategorySource = "breadcrumbs",
): NormalizedListing | null {
  const name = typeof product.name === "string" ? decodeEntities(product.name.trim()) : "";
  if (!name) return null;

  const offer = firstOf(product.offers);
  const { cents, currency } = priceFromOffer(offer);
  const packaging = parsePackaging(name);

  return {
    name,
    priceCents: cents,
    currency,
    inStock: availabilityToStock(offer?.availability),
    imageUrl: imageUrl(product.image),
    sku: typeof product.sku === "string" ? product.sku : null,
    categoryPath: categoryPathFrom(category, categorySource),
    packaging: packaging.packaging,
    sticksPerPackage: packaging.sticksPerPackage,
  };
}

// A listing is a cigar when its taxonomy names a cigar category and is not an
// accessory/sampler/etc. (adapter-configured). An EMPTY path matches nothing and
// is therefore refused — the ruling for a page that states no category at all. Samplers are excluded
// on purpose — a mixed box is not one catalog cigar.
export function isCigarCategory(categoryPath: string[], adapter: VendorAdapter): boolean {
  const joined = categoryPath.join(" / ");
  if (adapter.excludePattern.test(joined)) return false;
  return adapter.cigarCategoryPattern.test(joined);
}

// The full listing gate: cigar category AND not a set/kit/mixed case by name
// (those live under cigar categories but are not one catalog cigar).
export function isCigarListing(listing: NormalizedListing, adapter: VendorAdapter): boolean {
  if (!isCigarCategory(listing.categoryPath, adapter)) return false;
  if (adapter.excludeNamePattern?.test(listing.name)) return false;
  return true;
}
