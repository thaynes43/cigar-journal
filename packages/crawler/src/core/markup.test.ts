import { describe, it, expect } from "vitest";
import { extractProductMarkup, markupLabel } from "./markup.js";
import { isCigarListing, normalizeListing } from "./normalize.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import { montefortuna } from "../adapters/montefortuna.js";
import { egmCigars } from "../adapters/egm-cigars.js";
import { cigarworldDe } from "../adapters/cigarworld-de.js";
import { jjFox } from "../adapters/jj-fox.js";
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

// --- the photo (ADR-006 amendment 2026-09-02, #270) -------------------------
// `photoSource`/`photoUrlRewrite` decide ONE thing: the URL `capturePhoto`
// fetches. The listing's own `imageUrl` and the offer's raw payload are what the
// markup published, and these tests assert both halves of that on every case.
describe("extractProductMarkup — the URL the photo is fetched from", () => {
  it("defaults to the JSON-LD image, byte-identical to what it fetched before", () => {
    const html = loadFixture("product-padron.html");
    const { product, photoUrl } = extractProductMarkup(html, foxCigar);

    expect(foxCigar.photoSource).toBeUndefined();
    expect(foxCigar.photoUrlRewrite).toBeUndefined();
    expect(photoUrl).toBe(product?.image);
    expect(photoUrl).toBe(listingFor(html, foxCigar)!.imageUrl);
  });

  it("rewrites Cigarworld's 300x51 thumbnail to the /big/ asset", () => {
    const html = loadFixture("product.html", "cigarworld-de");
    const { photoUrl } = extractProductMarkup(html, cigarworldDe);

    expect(photoUrl).toBe("https://www.cigarworld.de/bilder/detail/big/2390.jpg");
    // …and the listing still carries the URL the markup published.
    expect(listingFor(html, cigarworldDe)!.imageUrl).toBe("https://www.cigarworld.de/bilder/detail/2390.jpg");
  });

  it("leaves a Cigarworld URL that already names the big asset alone", () => {
    const html = loadFixture("product.html", "cigarworld-de").replace(
      "/bilder/detail/2390.jpg",
      "/bilder/detail/big/2390.jpg",
    );
    expect(extractProductMarkup(html, cigarworldDe).photoUrl).toBe(
      "https://www.cigarworld.de/bilder/detail/big/2390.jpg",
    );
  });

  it("strips J.J. Fox's 265px resize query down to the full-size path", () => {
    const html = loadFixture("product.html", "jj-fox");
    const { photoUrl } = extractProductMarkup(html, jjFox);

    expect(photoUrl).toBe("https://www.jjfox.co.uk/media/catalog/product/P/a/Partagas_Shorts_box_of_25.jpg");
    // The og:image is entity-encoded on the page; the listing carries it decoded
    // and whole, query included — the rewrite touches only the fetch.
    expect(listingFor(html, jjFox)!.imageUrl).toBe(
      "https://www.jjfox.co.uk/media/catalog/product/P/a/Partagas_Shorts_box_of_25.jpg" +
        "?width=265&height=265&store=default&image-type=image",
    );
  });

  it("takes EGM's photo from og:image:secure_url, which its ProductGroup does not name", () => {
    const html = loadFixture("product.html", "egm-cigars");
    const { product, photoUrl } = extractProductMarkup(html, egmCigars);

    expect(product?.image).toBeUndefined();
    expect(photoUrl).toBe(
      "https://egmcigars.com/cdn/shop/files/Cohiba_Siglo_VI_Cigar_Box_of_25_Cigars_EGM_Cigars.jpg?v=1693381836",
    );
  });

  // The finding that keeps Montefortuna on the JSON-LD default: its og:image is
  // sometimes the site logo, and a catalogue full of logos is worse than one with
  // empty photo slots.
  it("keeps Montefortuna on the JSON-LD image, not the og:image site logo", () => {
    const html = loadFixture("product-partagas-shorts-single.html", "montefortuna");
    const { photoUrl } = extractProductMarkup(html, montefortuna);

    expect(photoUrl).toBe(
      "https://www.montefortunacigars.com/wp-content/uploads/2019/01/Partagas-Shorts-Cabinet-50-.jpg",
    );
    expect(photoUrl).not.toMatch(/Logo/);
  });

  it("is null when the page names no image at all", () => {
    const html = loadFixture("product-padron.html").replace(/"image":\s*"[^"]*",?/, "");
    expect(extractProductMarkup(html, foxCigar).photoUrl).toBeNull();
  });
});

// --- categorySource: "json-ld-category" (ADR-006 amendment 2026-09-02) -------
describe("extractProductMarkup — the JSON-LD category string", () => {
  it("reads EGM's `category: \"Cigars\"` and passes the cigar gate on it", () => {
    const html = loadFixture("product.html", "egm-cigars");
    const { category, categorySource } = extractProductMarkup(html, egmCigars);

    expect(categorySource).toBe("json-ld-category");
    expect(category).toEqual(["Cigars"]);
    const listing = listingFor(html, egmCigars)!;
    // Taxonomy end to end: a one-term category survives whole, where a breadcrumb
    // trail would have had its last crumb dropped and left nothing.
    expect(listing.categoryPath).toEqual(["Cigars"]);
    expect(listing.name).toBe("Cohiba Siglo VI Cigar");
    expect(listing.priceCents).toBe(10694);
    expect(listing.currency).toBe("CHF");
    expect(listing.inStock).toBe(true);
    expect(isCigarListing(listing, egmCigars)).toBe(true);
  });

  it("refuses the same vendor's accessory on its own category", () => {
    const listing = listingFor(loadFixture("product-cutter.html", "egm-cigars"), egmCigars)!;

    expect(listing.categoryPath).toEqual(["Cutters"]);
    expect(isCigarListing(listing, egmCigars)).toBe(false);
  });

  it("splits a category path on `>` or `/`", () => {
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"ProductGroup","name":"X","category":"Cigars > Cuban > Robusto"}' +
      "</script></head></html>";
    expect(extractProductMarkup(html, egmCigars).category).toEqual(["Cigars", "Cuban", "Robusto"]);
  });

  // The ruling this shares with keywords-meta: no stated category is a REFUSAL,
  // never a guess.
  it("yields an empty path and refuses a product node with no category", () => {
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"ProductGroup","name":"Mystery Robusto",' +
      '"hasVariant":[{"@type":"Product","offers":{"price":"9.99","priceCurrency":"CHF"}}]}' +
      "</script></head></html>";
    const listing = listingFor(html, egmCigars)!;

    expect(listing.name).toBe("Mystery Robusto");
    expect(listing.categoryPath).toEqual([]);
    expect(isCigarListing(listing, egmCigars)).toBe(false);
  });
});
