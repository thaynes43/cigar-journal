import { describe, it, expect } from "vitest";
import { extractProductMarkup, markupLabel } from "./markup.js";
import { isCigarListing, normalizeListing } from "./normalize.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import { loadFixture } from "../testing/fixtures.js";
import type { VendorAdapter } from "../adapters/types.js";

// The three lines both ingest walks and the probe run, over the adapter that
// declares each shape (ADR-006 amendment 2026-09-02): extract, normalize, gate.
// Fox is the JSON-LD/breadcrumbs default and must be untouched by any of this;
// 2 Guys is the OpenGraph/keywords vendor the amendment exists for.
function listingFor(html: string, adapter: VendorAdapter) {
  const { product, category, categorySource } = extractProductMarkup(html, adapter);
  return product ? normalizeListing(product, category, categorySource) : null;
}

const twoGuys = (name: string) => loadFixture(name, "two-guys");

describe("extractProductMarkup — the extractor is the adapter's declaration", () => {
  it("keeps a JSON-LD vendor on the breadcrumb trail, product crumb dropped", () => {
    const { product, category, categorySource } = extractProductMarkup(loadFixture("product-padron.html"), foxCigar);

    expect(categorySource).toBe("breadcrumbs");
    expect(product?.name).toBe("Padron 1964 Anniversary Maduro Torpedo");
    expect(category).toEqual(["Home", "Shop", "Cigars", "Padron", "Padron 1964 Anniversary Maduro Torpedo"]);
    expect(listingFor(loadFixture("product-padron.html"), foxCigar)!.categoryPath).toEqual([
      "Home",
      "Shop",
      "Cigars",
      "Padron",
    ]);
  });

  // The declaration cuts both ways: reading 2 Guys with the JSON-LD extractor is
  // what `sampled=3 parsed=0` was, and reading Fox with the OG one finds nothing
  // either. Neither is sniffed; the adapter says which.
  it("finds nothing when a page's markup is not the declared one", () => {
    const asJsonLd: VendorAdapter = { ...twoGuysCigars, productMarkup: "json-ld" };
    expect(extractProductMarkup(twoGuys("live-product-perdomo-30th-robusto-sg-s-165681.html"), asJsonLd).product)
      .toBeNull();

    const asOpenGraph: VendorAdapter = { ...foxCigar, productMarkup: "opengraph" };
    expect(extractProductMarkup(loadFixture("product-padron.html"), asOpenGraph).product).toBeNull();
  });

  it("names the declared markup in the label a probe note uses", () => {
    expect(markupLabel(foxCigar)).toBe("schema.org Product JSON-LD");
    expect(markupLabel(twoGuysCigars)).toBe("OpenGraph/microdata product markup");
  });
});

describe("2 Guys — an OG product page through to the cigar gate", () => {
  it("normalizes an in-stock cigar and admits it", () => {
    const listing = listingFor(twoGuys("live-product-perdomo-30th-robusto-sg-s-165681.html"), twoGuysCigars)!;

    expect(listing.name).toBe("Perdomo 30th Robusto SG S");
    expect(listing.priceCents).toBe(1379);
    expect(listing.currency).toBe("USD");
    expect(listing.inStock).toBe(true);
    expect(listing.sku).toBe("165681");
    expect(listing.imageUrl).toBe(
      "https://cdn.powered-by-nitrosell.com/product_images/14/3384/perdomo%2030th%20robusto%20sg%20single.png",
    );
    // The tag list is taxonomy end to end — nothing is dropped off it, unlike a
    // breadcrumb trail that ends with the product.
    expect(listing.categoryPath).toEqual(["30 nick anniversary nicaragua", "Cigars", "Perdomo 30th Sun Grown"]);
    expect(isCigarListing(listing, twoGuysCigars)).toBe(true);
    // The brand rides the product node (og:brand); NormalizedListing carries none.
    const { product } = extractProductMarkup(twoGuys("live-product-perdomo-30th-robusto-sg-s-165681.html"), twoGuysCigars);
    expect(product?.brand).toEqual({ "@type": "Brand", name: "Perdomo 30th Sun Grown" });
  });

  it("carries out-of-stock through as false, never as unknown", () => {
    const listing = listingFor(twoGuys("live-product-romacraft-steel-porcupine-184527.html"), twoGuysCigars)!;

    expect(listing.name).toBe("RoMaCraft Steel Porcupine");
    expect(listing.priceCents).toBe(10799);
    expect(listing.inStock).toBe(false);
    expect(listing.categoryPath).toEqual(["Cigars", "RomaCraft Craft"]);
    expect(isCigarListing(listing, twoGuysCigars)).toBe(true);
  });

  // The vendor sells soda, jerky, mints and candles under the same slug shape, so
  // the gate is the only thing between them and the catalog.
  it("parses the candle and refuses it on its own tags", () => {
    const listing = listingFor(twoGuys("live-product-smoke-exterm-candle-orange-734366037362.html"), twoGuysCigars)!;

    expect(listing.name).toBe("Smoke Exterm Candle Orange");
    expect(listing.priceCents).toBe(999);
    expect(listing.categoryPath).toEqual(["Air Freshening", "Air Freshening Accessories"]);
    expect(isCigarListing(listing, twoGuysCigars)).toBe(false);
  });

  it("produces no listing at all for a landing page or a 404", () => {
    expect(listingFor(twoGuys("live-landing-cigars-perdomo-30th-maduro.html"), twoGuysCigars)).toBeNull();
    expect(listingFor(twoGuys("live-404-zino-nicaragua-cigars.html"), twoGuysCigars)).toBeNull();
  });

  // The ruling, at its sharpest: no tags is no category, and no category is a
  // refusal. Synthetic because no captured page has this shape — the point is the
  // rule, not a claim about the vendor.
  it("refuses a product page that carries no keywords tag", () => {
    const html =
      '<html><head><meta property="og:type" content="product"/>' +
      '<meta property="og:title" content="Mystery Robusto"/>' +
      '<meta property="product:price:amount" content="9.99"/></head><body></body></html>';
    const listing = listingFor(html, twoGuysCigars)!;

    expect(listing.name).toBe("Mystery Robusto");
    expect(listing.categoryPath).toEqual([]);
    expect(isCigarListing(listing, twoGuysCigars)).toBe(false);
  });
});
