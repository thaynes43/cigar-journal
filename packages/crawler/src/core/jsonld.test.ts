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

  it("returns nulls when there is no ld+json product", () => {
    const { product, breadcrumbs } = extractJsonLd("<html><body>no structured data</body></html>");
    expect(product).toBeNull();
    expect(breadcrumbs).toEqual([]);
  });
});
