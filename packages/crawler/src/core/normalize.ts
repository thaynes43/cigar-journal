import { assortmentPhrase, parsePackagingFacts, type PackagingFacts } from "@cj/domain";
import { productImageUrl, type JsonLdOffer, type JsonLdPriceSpecification, type JsonLdProduct } from "./jsonld.js";
import type { VariantPrice } from "./variant-prices.js";
import type { CategorySource, ImpliedPackaging, ProductMarkup, VendorAdapter } from "../adapters/types.js";

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
  // Packaging tier + count parsed from the listing name; failing that, on an
  // OpenGraph vendor, from its `og:description`; failing that, from the adapter's
  // `impliedPackaging` (`packagingOf` below). ADR-009 CONSERVATIVE still: a
  // packaging no source states — and whose vendor declares no posture — stays
  // null, never guessed. Fed to the offers observation so per-stick can be
  // derived.
  packaging: string | null;
  sticksPerPackage: number | null;
  // THE PAGE'S PER-PACK PRICES, where the vendor declares an HTML source for
  // them (`adapter.variantPrices`, ADR-015). Empty for every other vendor and
  // for a simple product at a vendor that declares one, in which case the four
  // fields above are the whole of what this listing says about money.
  //
  // NON-EMPTY, IT REPLACES THEM AS THE OFFER SET: a grouped product's parent has
  // no price of its own to record, so ingest writes ONE OFFER PER VARIANT and
  // none for the parent. Each carries its own packaging tier, so each is its own
  // observation series (ADR-009) and per-stick derives per pack (DESIGN-005).
  variants: NormalizedVariant[];
}

// One priced pack of a grouped product, put through the SAME packaging
// vocabulary a listing name goes through — so `Box of 14` on a variant label and
// `Box of 14` in a product title record the identical facts.
export interface NormalizedVariant {
  // The label as the shop wrote it, decoded. Kept for the offer's raw payload:
  // it is the evidence for the packaging fields beside it.
  label: string;
  packaging: string | null;
  sticksPerPackage: number | null;
  priceCents: number | null;
  currency: string | null;
  inStock: boolean | null;
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
//
// AND, LAST, THE VENDOR'S OWN POSTURE (DESIGN-005 amendment 2026-09-02, #270).
// Where neither source states anything, an adapter that declares
// `impliedPackaging: "single"` says what its bare listings ARE: one stick. Fox
// lists a single by default and names every other unit — `Box of 20`, `5 Pack`,
// `Tubos`, `Tin` — so `packaging: null` there is not "unknown", it is the
// everyday case, and it was 6,894 of its 7,169 offers on 2026-09-02.
// DESIGN-005's `Not stated` is for a shop whose bare listing genuinely states
// nothing (Small Batch's grouped parents, Cuban Lou's bundles), and those
// adapters declare nothing here, so their listings are untouched.
//
// It is checked LAST, so a stated packaging always wins over the posture — a Fox
// `Box of 20` is a box, exactly as before. And it is a claim about the UNIT, not
// about the price: a listing with no price (or a placeholder one) becomes a
// single with no per-stick, because `computePricePerStickCents` derives nothing
// from a null price.
function packagingOf(
  product: JsonLdProduct,
  name: string,
  productMarkup: ProductMarkup,
  impliedPackaging: ImpliedPackaging | undefined,
): PackagingFacts {
  const implied: PackagingFacts =
    impliedPackaging === "single"
      ? { packaging: "single", sticksPerPackage: 1 }
      : { packaging: null, sticksPerPackage: null };

  const fromName = parsePackaging(name);
  if (fromName.packaging != null || fromName.sticksPerPackage != null) return fromName;
  if (productMarkup !== "opengraph") return implied;
  const description = typeof product.description === "string" ? product.description : "";
  if (!description) return implied;
  const fromDescription = parsePackaging(description);
  return fromDescription.sticksPerPackage != null ? fromDescription : implied;
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
  // The adapter's `impliedPackaging` — what a listing that states no packaging at
  // all IS at this vendor (DESIGN-005 amendment 2026-09-02). Read only by
  // `packagingOf`; omitted, nothing is implied and an unstated packaging stays
  // null, which is what every caller got before this argument existed.
  impliedPackaging?: ImpliedPackaging,
  // The page's declared HTML variant rows, from `extractProductMarkup`. Empty —
  // the default, and every vendor but Small Batch — leaves this function exactly
  // as it was.
  variantPrices: readonly VariantPrice[] = [],
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
  //
  // …UNLESS THE PAGE PUBLISHES THE REAL FIGURES SOMEWHERE ELSE (ADR-015). A
  // parent at 0.00 with priced variants beneath it is not a shop that failed to
  // state a price; it is a shop that states one per pack. The refusal is
  // unchanged for a TRUE placeholder — a zero with no variant row carrying money
  // is still `priceIsPlaceholder`, and the probe still fails the vendor on it.
  //
  // The parent's own price is null either way when it is zero: nothing may write
  // a $0.00 offer, and where variants exist they are the offer set.
  const parentZero = cents != null && cents <= 0;
  const variants = normalizeVariants(variantPrices);
  const variantsPriced = variants.some((v) => v.priceCents != null && v.priceCents > 0);
  const priceIsPlaceholder = parentZero && !variantsPriced;
  const packaging = packagingOf(product, name, productMarkup, impliedPackaging);

  return {
    name,
    priceCents: parentZero ? null : cents,
    currency,
    priceIsPlaceholder,
    inStock: availabilityToStock(offer?.availability),
    imageUrl: productImageUrl(product.image),
    sku: typeof product.sku === "string" ? product.sku : null,
    categoryPath: categoryPathFrom(category, categorySource),
    packaging: packaging.packaging,
    sticksPerPackage: packaging.sticksPerPackage,
    variants,
  };
}

// A variant's packaging comes off its UNIT — the label's tail — and falls back to
// the whole label only when the shop wrote no separator. Same vocabulary as a
// listing name (`parsePackaging`), so `Box of 14` records `box`/14 wherever it is
// written, and a unit the vocabulary does not recognize stays null rather than
// being guessed (ADR-009).
function normalizeVariants(variants: readonly VariantPrice[]): NormalizedVariant[] {
  return variants.map((variant) => {
    const fromUnit = variant.unit != null ? parsePackaging(variant.unit) : { packaging: null, sticksPerPackage: null };
    const facts =
      fromUnit.packaging != null || fromUnit.sticksPerPackage != null ? fromUnit : parsePackaging(variant.label);
    return {
      label: variant.label,
      packaging: facts.packaging,
      sticksPerPackage: facts.sticksPerPackage,
      // A variant priced at zero is a placeholder in exactly the way the parent's
      // is, and it must not become a $0.00 offer either.
      priceCents: variant.priceCents != null && variant.priceCents > 0 ? variant.priceCents : null,
      currency: variant.currency,
      inStock: variant.inStock,
    };
  });
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
//
// THE ASSORTMENT RULE IS SHARED, NOT PER-ADAPTER (#164). Two adapters had hand-
// written `excludeNamePattern`s for samplers and sets and the rest had none, so
// whether `Mix & Match Cuban Cigar Bundle` reached the matcher depended on which
// shop published it — and where it did reach, it became a triage row a curator
// had to close by hand. `assortmentPhrase` is the one vocabulary
// (`@cj/domain`), so every vendor answers the same way, before a connection is
// opened. The adapter patterns stay: they also exclude accessories and vintage
// listings, which are a different question.
export function isCigarListing(listing: NormalizedListing, adapter: VendorAdapter): boolean {
  if (!isCigarCategory(listing.categoryPath, adapter)) return false;
  if (adapter.excludeNamePattern?.test(listing.name)) return false;
  if (assortmentPhrase(listing.name) != null) return false;
  return true;
}
