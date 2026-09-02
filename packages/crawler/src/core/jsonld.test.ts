import { describe, it, expect } from "vitest";
import { extractJsonLd } from "./jsonld.js";
import { loadFixture } from "../testing/fixtures.js";

describe("extractJsonLd", () => {
  it("pulls the Product node and the ordered breadcrumb names from an @graph", () => {
    const { product, breadcrumbs } = extractJsonLd(loadFixture("product-padron.html"));
    expect(product?.name).toBe("Padron 1964 Anniversary Maduro Torpedo");
    expect(product?.sku).toBe("PAD-1964-TORP");
    expect(breadcrumbs).toEqual([
      "Home",
      "Shop",
      "Cigars",
      "Padron",
      "Padron 1964 Anniversary Maduro Torpedo",
    ]);
  });

  it("tolerates a broken ld+json block and still parses the valid one", () => {
    const { product, breadcrumbs } = extractJsonLd(loadFixture("product-broken-jsonld.html"));
    expect(product?.name).toBe("Arturo Fuente Hemingway Short Story");
    // The offers node here is a single object, not an array — still extracted.
    expect(product?.offers).toBeDefined();
    expect(breadcrumbs[0]).toBe("Home");
  });

  // ADR-006 amendment 2026-09-02 (#270): Shopify emits `ProductGroup`, and EGM
  // Cigars serves nothing else on any page the live probe read. Refusing it read
  // a healthy 1,072-product catalogue as "no schema.org Product JSON-LD".
  it("reads a Shopify ProductGroup as the page's product", () => {
    const { product, breadcrumbs } = extractJsonLd(loadFixture("product.html", "egm-cigars"));

    expect(product?.name).toBe("Cohiba Siglo VI Cigar");
    expect(product?.brand).toEqual({ "@type": "Brand", name: "Habanos sa" });
    expect(product?.category).toBe("Cigars");
    // The group states no image of its own — the photo comes from og:image.
    expect(product?.image).toBeUndefined();
    // …and no breadcrumb node at all, which is why this vendor's category has to
    // come from `category` instead.
    expect(breadcrumbs).toEqual([]);
  });

  it("lifts the first variant's offers onto a ProductGroup that states none", () => {
    const { product } = extractJsonLd(loadFixture("product.html", "egm-cigars"));

    expect(product?.offers).toEqual({
      "@type": "Offer",
      price: "106.94",
      priceCurrency: "CHF",
      availability: "https://schema.org/InStock",
      url: "https://egmcigars.com/products/cohiba-siglo-6-slb?variant=1",
    });
    // A lift, not an override: the variants stay on the node, so the offer's raw
    // payload still holds everything the page published.
    expect(Array.isArray(product?.hasVariant)).toBe(true);
  });

  it("leaves a group's own offers alone when it states them", () => {
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"ProductGroup","name":"G","offers":{"price":"1.00"},' +
      '"hasVariant":[{"@type":"Product","offers":{"price":"9.99"}}]}' +
      "</script></head></html>";
    expect(extractJsonLd(html).product?.offers).toEqual({ price: "1.00" });
  });

  it("returns nulls when there is no ld+json product", () => {
    const { product, breadcrumbs } = extractJsonLd("<html><body>no structured data</body></html>");
    expect(product).toBeNull();
    expect(breadcrumbs).toEqual([]);
  });
});
