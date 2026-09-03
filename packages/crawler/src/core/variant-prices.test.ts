import { describe, it, expect } from "vitest";
import { extractVariantPrices, priceTextToCents } from "./variant-prices.js";
import { extractProductMarkup } from "./markup.js";
import { normalizeListing, isCigarListing } from "./normalize.js";
import { smallBatchCigar } from "../adapters/small-batch-cigar.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { loadFixture } from "../testing/fixtures.js";

// THE nopCommerce GROUPED-PRODUCT PRICE EXTRACTOR (ADR-015, #270).
//
// Every fixture named `live-product-*` in `__fixtures__/small-batch/` is REAL
// BYTES, fetched in-cluster on 2026-09-03 and trimmed to the head's JSON-LD plus
// the verbatim `product-variant-list` block. Nothing inside either was edited,
// which is the point: the shape this parser reads was invented once already (the
// pre-2026-09-03 synthetic fixtures guessed `<span class="variant-name">` inside
// a bare `variant-overview` div) and the guess was wrong in both anchors.

const sb = (name: string): string => loadFixture(name, "small-batch");

const variantsOf = (fixture: string) => extractVariantPrices(sb(fixture), smallBatchCigar.variantPrices);

// The whole adapter-driven read, as ingest runs it.
const listingOf = (fixture: string) => {
  const markup = extractProductMarkup(sb(fixture), smallBatchCigar);
  return normalizeListing(
    markup.product!,
    markup.category,
    markup.categorySource,
    markup.productMarkup,
    smallBatchCigar.impliedPackaging,
    markup.variants,
  )!;
};

describe("extractVariantPrices — the live nopCommerce shape", () => {
  // The mixed-availability page: `Low stock` on the pack, `In stock` on the box.
  it("reads a pack and a box off Sobremesa Solita Short Churchill", () => {
    expect(variantsOf("live-product-sobremesa-solita-short-churchill.html")).toEqual([
      {
        label: "Sobremesa Solita Short Churchill - Pack of 5",
        unit: "Pack of 5",
        priceCents: 7100,
        currency: "USD",
        inStock: true, // `Low stock` is IN stock
      },
      {
        label: "Sobremesa Solita Short Churchill - Box of 14",
        unit: "Box of 14",
        priceCents: 19800,
        currency: "USD",
        inStock: true,
      },
    ]);
  });

  // A BUNDLE rather than a box, and every pack out of stock — the availability
  // arm, and the reason a variant does not inherit the parent's `InStock`.
  it("reads a bundle, and an out-of-stock pack, off Tatuaje Pork Tenderloin", () => {
    const variants = variantsOf("live-product-tatuaje-pork-tenderloin.html");

    expect(variants.map((v) => [v.unit, v.priceCents, v.inStock])).toEqual([
      ["Pack of 5", 6500, false],
      ["Bundle of 25", 32500, false],
    ]);
  });

  // Availability is read from each pack's OWN `stock-availability-value-<id>`
  // span, keyed to the same `data-productid` as its price — never inherited from
  // the parent. Sobremesa's parent says `InStock`; sell one of its two packs out
  // and only that pack changes.
  it("gives each pack its own availability, not the parent's", () => {
    const html = sb("live-product-sobremesa-solita-short-churchill.html").replace(
      '<span class="value" id="stock-availability-value-23480">In stock</span>',
      '<span class="value" id="stock-availability-value-23480">Out of stock</span>',
    );
    const { product } = extractProductMarkup(html, smallBatchCigar);

    expect(JSON.stringify(product!.offers)).toContain("InStock");
    expect(extractVariantPrices(html, smallBatchCigar.variantPrices).map((v) => v.inStock)).toEqual([true, false]);
  });

  // The shop entity-encodes the apostrophe in `Chef's`; the label has to come out
  // of the same decoder the product name goes through.
  it("decodes the entity-encoded label on Viaje Chef's Cut Short", () => {
    const variants = variantsOf("live-product-viaje-chefs-cut-short.html");

    expect(variants.map((v) => v.label)).toEqual([
      "Viaje Chef's Cut Short - Pack of 5",
      "Viaje Chef's Cut Short - Box of 25",
    ]);
    expect(variants.map((v) => v.priceCents)).toEqual([5764, 28818]);
  });

  // THE NEGATIVE CONTROL. A SIMPLE nopCommerce product has no variant list and a
  // real JSON-LD price, and the extractor must find nothing at all on it.
  it("finds nothing on a simple product, whose structured price is real", () => {
    expect(variantsOf("live-product-arturo-fuente-2026-sampler.html")).toEqual([]);
  });

  // And nothing anywhere for a vendor that declares no source — the extractor is
  // reached only through `adapter.variantPrices`, never by sniffing.
  it("is inert for an adapter that declares no source", () => {
    expect(foxCigar.variantPrices).toBeUndefined();
    expect(extractVariantPrices(sb("live-product-sobremesa-solita-short-churchill.html"), undefined)).toEqual([]);
  });

  // `variant-overview` appears fourteen times on a two-variant page because each
  // line carries inline CSS naming the class. Anchoring on it would have found
  // twelve phantom variants; `product-variant-line` + `data-productid` is why it
  // finds two.
  it("is not fooled by the class name appearing inside the page's own CSS", () => {
    const html = sb("live-product-sobremesa-solita-short-churchill.html");
    expect((html.match(/variant-overview/g) ?? []).length).toBeGreaterThan(4);
    expect(variantsOf("live-product-sobremesa-solita-short-churchill.html")).toHaveLength(2);
  });
});

describe("priceTextToCents", () => {
  it("reads the shop's spelling, spaces and separators included", () => {
    expect(priceTextToCents(" $71.00 ")).toBe(7100);
    expect(priceTextToCents("$1,234.50")).toBe(123450);
    expect(priceTextToCents("$57.64")).toBe(5764);
    expect(priceTextToCents("€18.00")).toBe(1800);
  });

  it("reads no digits as no price, never as free", () => {
    expect(priceTextToCents("")).toBeNull();
    expect(priceTextToCents("Call for price")).toBeNull();
  });
});

describe("a grouped listing, normalized", () => {
  it("carries the packs as offers and stops calling the parent zero a placeholder", () => {
    const listing = listingOf("live-product-sobremesa-solita-short-churchill.html");

    // The parent still states no price of its own — it has none — but the PAGE
    // states two, so the placeholder refusal does not fire.
    expect(listing.priceCents).toBeNull();
    expect(listing.priceIsPlaceholder).toBe(false);
    expect(listing.variants.map((v) => [v.packaging, v.sticksPerPackage, v.priceCents])).toEqual([
      ["5-pack", 5, 7100],
      ["box", 14, 19800],
    ]);
    // And it is still a cigar: brand-first taxonomy, `cigarCategoryPattern: /./`.
    expect(listing.categoryPath).toEqual(["SHOP BY BRAND", "Dunbarton Tobacco & Trust"]);
    expect(isCigarListing(listing, smallBatchCigar)).toBe(true);
  });

  it("leaves a simple product's structured price exactly where it was", () => {
    const listing = listingOf("live-product-arturo-fuente-2026-sampler.html");

    expect(listing.variants).toEqual([]);
    expect(listing.priceCents).toBe(20300);
    expect(listing.priceIsPlaceholder).toBe(false);
    expect(listing.inStock).toBe(false);
    // A sampler is not one catalog cigar, whatever its price says.
    expect(isCigarListing(listing, smallBatchCigar)).toBe(false);
  });

  // THE PACKAGING PARSE READS THE UNIT, NOT THE WHOLE LABEL, and this is why: the
  // shop prefixes every label with the product's own name, so a cigar whose name
  // ends in a container word would otherwise hand the shared vocabulary a
  // container off its IDENTITY rather than off its unit.
  it("parses packaging off the label's tail, so a product name cannot supply it", () => {
    const html = sb("live-product-sobremesa-solita-short-churchill.html").replace(
      "Sobremesa Solita Short Churchill - Pack of 5",
      "Sobremesa Tubos - Pack of 5",
    );
    const markup = extractProductMarkup(html, smallBatchCigar);
    const listing = normalizeListing(
      markup.product!,
      markup.category,
      markup.categorySource,
      markup.productMarkup,
      smallBatchCigar.impliedPackaging,
      markup.variants,
    )!;

    expect(listing.variants[0]!.packaging).toBe("5-pack");
    expect(listing.variants[0]!.sticksPerPackage).toBe(5);
  });
});
