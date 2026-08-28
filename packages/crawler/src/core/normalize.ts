import type { JsonLdOffer, JsonLdPriceSpecification, JsonLdProduct } from "./jsonld.js";
import type { VendorAdapter } from "../adapters/types.js";

// A vendor-neutral listing distilled from a schema.org Product + its breadcrumb
// trail. Price is carried in integer cents (the offers table stores a decimal;
// ingest converts on write); availability collapses schema.org InStock/OutOfStock
// to a tristate, unknown → null (never guessed). `categoryPath` is the breadcrumb
// names with the product itself dropped, so the category filter reasons over the
// taxonomy, not the product name.
export interface NormalizedListing {
  name: string;
  priceCents: number | null;
  currency: string | null;
  inStock: boolean | null;
  imageUrl: string | null;
  sku: string | null;
  categoryPath: string[];
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

export function normalizeListing(product: JsonLdProduct, breadcrumbs: string[]): NormalizedListing | null {
  const name = typeof product.name === "string" ? product.name.trim() : "";
  if (!name) return null;

  const offer = firstOf(product.offers);
  const { cents, currency } = priceFromOffer(offer);

  return {
    name,
    priceCents: cents,
    currency,
    inStock: availabilityToStock(offer?.availability),
    imageUrl: imageUrl(product.image),
    sku: typeof product.sku === "string" ? product.sku : null,
    // Drop the trailing breadcrumb (the product itself); the rest is taxonomy.
    categoryPath: breadcrumbs.length > 1 ? breadcrumbs.slice(0, -1) : [...breadcrumbs],
  };
}

// A listing is a cigar when its breadcrumb taxonomy names a cigar category and
// is not an accessory/sampler/etc. (adapter-configured). Samplers are excluded
// on purpose — a mixed box is not one catalog cigar.
export function isCigarCategory(categoryPath: string[], adapter: VendorAdapter): boolean {
  const joined = categoryPath.join(" / ");
  if (adapter.excludePattern.test(joined)) return false;
  return adapter.cigarCategoryPattern.test(joined);
}
