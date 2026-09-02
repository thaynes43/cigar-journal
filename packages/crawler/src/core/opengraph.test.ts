import { describe, it, expect } from "vitest";
import { extractKeywords, extractOpenGraphProduct } from "./opengraph.js";
import { loadFixture } from "../testing/fixtures.js";

// Every fixture here is a VERBATIM live capture (2026-09-01, in-cluster Job,
// issue #217): two cigars, an accessory sharing the product-slug shape, a
// category landing page and a 404. The extractor is pure, so this is the whole
// contract — what it reads off a real page, and what it refuses.

const product = (name: string) => loadFixture(name, "two-guys");

describe("extractOpenGraphProduct", () => {
  it("reads the OG product tags of an in-stock cigar", () => {
    const og = extractOpenGraphProduct(product("live-product-perdomo-30th-robusto-sg-s-165681.html"))!;

    expect(og.name).toBe("Perdomo 30th Robusto SG S");
    expect(og.sku).toBe("165681"); // og:upc — the NitroSell product code in the slug
    expect(og.url).toBe("https://www.2guyscigars.com/perdomo-30th-robusto-sg-s-165681/");
    expect(og.description).toBe("5 X 54 - Sun Grownt - Single");
    expect(og.brand).toEqual({ "@type": "Brand", name: "Perdomo 30th Sun Grown" });
    expect(og.offers).toEqual([
      { price: "13.79", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    ]);
  });

  it("maps the bare `outofstock` token to the schema.org term", () => {
    const og = extractOpenGraphProduct(product("live-product-romacraft-steel-porcupine-184527.html"))!;

    expect(og.name).toBe("RoMaCraft Steel Porcupine");
    expect(og.offers).toEqual([
      { price: "107.99", priceCurrency: "USD", availability: "https://schema.org/OutOfStock" },
    ]);
  });

  it("reads an accessory exactly like a cigar — the category gate is what refuses it", () => {
    const og = extractOpenGraphProduct(product("live-product-smoke-exterm-candle-orange-734366037362.html"))!;

    expect(og.name).toBe("Smoke Exterm Candle Orange");
    expect(og.sku).toBe("734366037362");
    expect(og.brand).toEqual({ "@type": "Brand", name: "Accessories" });
  });

  // A NitroSell defect, live on every product page: the store origin is prefixed
  // to an already-absolute CDN URL. Left as served it is unfetchable, so every
  // 2 Guys product photo would fail — repaired here, at the one place that reads
  // the tag.
  it("repairs an og:image whose origin was prefixed to an absolute CDN URL", () => {
    const og = extractOpenGraphProduct(product("live-product-perdomo-30th-robusto-sg-s-165681.html"))!;

    expect(og.image).toBe(
      "https://cdn.powered-by-nitrosell.com/product_images/14/3384/perdomo%2030th%20robusto%20sg%20single.png",
    );
  });

  it("returns null for a category landing page and for a 404", () => {
    expect(extractOpenGraphProduct(product("live-landing-cigars-perdomo-30th-maduro.html"))).toBeNull();
    expect(extractOpenGraphProduct(product("live-404-zino-nicaragua-cigars.html"))).toBeNull();
  });

  it("falls back to the microdata itemprop when a page carries only the itemscope", () => {
    const html =
      '<html><body><div itemscope itemtype="https://schema.org/Product">' +
      "<h1 itemprop=\"name\">Padron 1926 Serie No. 9</h1></div></body></html>";
    expect(extractOpenGraphProduct(html)?.name).toBe("Padron 1926 Serie No. 9");
  });

  it("refuses a page that declares a product but names none", () => {
    expect(extractOpenGraphProduct('<html><head><meta property="og:type" content="product"/></head></html>')).toBeNull();
  });
});

describe("extractKeywords", () => {
  it("splits the vendor's tag list on commas and drops the empty tokens", () => {
    expect(extractKeywords(product("live-product-perdomo-30th-robusto-sg-s-165681.html"))).toEqual([
      "30 nick anniversary nicaragua",
      "Cigars",
      "Perdomo 30th Sun Grown",
    ]);
    // This one's list opens with an empty token, verbatim: `,Cigars,RomaCraft Craft`.
    expect(extractKeywords(product("live-product-romacraft-steel-porcupine-184527.html"))).toEqual([
      "Cigars",
      "RomaCraft Craft",
    ]);
    // The accessory names its own aisle and never says "Cigars".
    expect(extractKeywords(product("live-product-smoke-exterm-candle-orange-734366037362.html"))).toEqual([
      "Air Freshening",
      "Air Freshening Accessories",
    ]);
  });

  it("yields nothing for a page with no keywords tag", () => {
    expect(extractKeywords(product("live-landing-cigars-perdomo-30th-maduro.html"))).toEqual([]);
    expect(extractKeywords("<html><head></head></html>")).toEqual([]);
  });
});
