import { parsePackagingFacts, type PackagingFacts } from "@cj/domain";
import { productImageUrl, type JsonLdOffer, type JsonLdPriceSpecification, type JsonLdProduct } from "./jsonld.js";
import type { CategorySource, ProductMarkup, VendorAdapter } from "../adapters/types.js";

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
  // The vendor published a price and it parsed to zero (or below) — see the guard
  // in `normalizeListing`. `priceCents` is null on such a listing, exactly as it
  // is when the vendor published nothing, and this is the difference: "no price
  // stated" vs "a placeholder stated where the price goes". The probe fails a
  // vendor on it; nothing else needs to care.
  priceIsPlaceholder: boolean;
  inStock: boolean | null;
  imageUrl: string | null;
  sku: string | null;
  categoryPath: string[];
  // Packaging tier + count parsed from the listing name — and, on an OpenGraph
  // vendor, from its `og:description` when the name states nothing (`packagingOf`
  // below). ADR-009 CONSERVATIVE: an unstated packaging stays null, never
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

// Packaging from the NAME first and, failing that, from an OpenGraph vendor's
// `og:description` (probe 2026-09-02, #270). 2 Guys prices some listings BY THE
// BOX under a name that states no packaging — `Rough Rider Toro Maduro` at
// $169.99, `Liga Privada No9 Belicoso` at $452.60 — so price-at-a-glance read a
// box price as the price of one stick on a tier-1 LINKOUT vendor, which is an
// ADR-009 display defect. Its `og:description` is the spec line the shop writes
// for every listing (`5 X 54 - Sun Grown - Single`, `4 1/2 x 56 - Ecuador
// Connecticut - Bundle of 10`) and it states the unit.
//
// Three constraints keep the widened source conservative:
//   - THE NAME WINS. The description is read only where the name stated nothing,
//     so a vendor that packages in the title keeps the answer it already gave.
//   - ONLY AN OPENGRAPH VENDOR'S DESCRIPTION IS READ, because only that one is
//     DECLARED to be a spec line. A JSON-LD `description` is marketing prose —
//     Fox's box listing reads "The full box of the same box-pressed Nicaraguan
//     puro" — and prose that mentions a box is not a statement that this listing
//     IS one. Every JSON-LD vendor's packaging is unchanged by this.
//   - A DESCRIPTION MUST YIELD A COUNT. The shared vocabulary's last rule takes a
//     standalone container word, which is right for a title and wrong for a
//     sentence; requiring `sticksPerPackage` keeps `Single`, `Box of 20`,
//     `Bundle of 10`, `Pack of 5`, `5-Pack` and `20 Count`, and drops the stray
//     "box" or "tin" a sentence happened to contain.
// An unparseable description therefore leaves packaging null, exactly as before.
function packagingOf(product: JsonLdProduct, name: string, productMarkup: ProductMarkup): PackagingFacts {
  const fromName = parsePackaging(name);
  if (fromName.packaging != null || fromName.sticksPerPackage != null) return fromName;
  if (productMarkup !== "opengraph") return fromName;
  const description = typeof product.description === "string" ? product.description : "";
  if (!description) return fromName;
  const fromDescription = parsePackaging(description);
  return fromDescription.sticksPerPackage != null ? fromDescription : fromName;
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
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      // HEX character references, the Magento 2 spelling: J.J. Fox serves
      // `og:title="Partagas&#x20;Shorts"` — every space in every og:* value is
      // `&#x20;` (live 2026-09-02, #270). Without this the catalog name carries
      // the escape, which no matcher would ever resolve to a cigar.
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
    if (next === value) break;
    value = next;
  }
  return value;
}

// The category as the adapter declared its source (ADR-006 2026-09-02). A
// breadcrumb trail ENDS WITH THE PRODUCT, so its last crumb is dropped and the
// taxonomy remains; every other source is taxonomy END TO END and is taken whole
// — dropping the last element of a keywords tag list, or of a `category` string
// that is one term ("Cigars", EGM), would throw away a real category.
function categoryPathFrom(category: string[], source: CategorySource): string[] {
  if (source !== "breadcrumbs") return [...category];
  return category.length > 1 ? category.slice(0, -1) : [...category];
}

export function normalizeListing(
  product: JsonLdProduct,
  category: string[],
  categorySource: CategorySource = "breadcrumbs",
  // The extractor that produced `product`, from `extractProductMarkup`. Read only
  // by `packagingOf`; a caller that omits it gets the JSON-LD reading, which is
  // the name-only parse this function has always done.
  productMarkup: ProductMarkup = "json-ld",
): NormalizedListing | null {
  const name = typeof product.name === "string" ? decodeEntities(product.name.trim()) : "";
  if (!name) return null;

  const offer = firstOf(product.offers);
  const { cents, currency } = priceFromOffer(offer);
  // A JSON-LD price of zero is a PLACEHOLDER, not a price. Vendor-neutral because
  // the platform behaviour is: a GROUPED/parent product has no single price, so
  // the parent node publishes `"0.00"` and the real figures live per variant in
  // HTML. Small Batch (live 2026-09-02, #270) does exactly this on 20 of 20 cigar
  // pages, and a seed there would have written ~8,000 offers at $0.00 — not a
  // missing price but a false one, which price-at-a-glance and every cheapest-per-
  // stick sort would have ranked first. Unknown is the honest reading; the rest of
  // the listing (name, sku, stock, image) is good and is carried through, and an
  // offer row with a null price still records availability.
  const priceIsPlaceholder = cents != null && cents <= 0;
  const packaging = packagingOf(product, name, productMarkup);

  return {
    name,
    priceCents: priceIsPlaceholder ? null : cents,
    currency,
    priceIsPlaceholder,
    inStock: availabilityToStock(offer?.availability),
    imageUrl: productImageUrl(product.image),
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
