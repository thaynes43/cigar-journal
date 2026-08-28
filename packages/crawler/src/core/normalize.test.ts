import { describe, it, expect } from "vitest";
import { extractJsonLd } from "./jsonld.js";
import { normalizeListing, isCigarCategory } from "./normalize.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { loadFixture } from "../testing/fixtures.js";

function normalize(fixture: string) {
  const { product, breadcrumbs } = extractJsonLd(loadFixture(fixture));
  return normalizeListing(product!, breadcrumbs);
}

describe("normalizeListing", () => {
  it("reads price (cents) from the first priceSpecification and InStock availability", () => {
    const listing = normalize("product-padron.html")!;
    expect(listing.name).toBe("Padron 1964 Anniversary Maduro Torpedo");
    expect(listing.priceCents).toBe(2450);
    expect(listing.currency).toBe("USD");
    expect(listing.inStock).toBe(true);
    expect(listing.imageUrl).toBe("https://foxcigar.com/wp-content/uploads/padron-1964-torpedo.jpg");
    expect(listing.sku).toBe("PAD-1964-TORP");
    // The trailing (product) breadcrumb is dropped; the taxonomy remains.
    expect(listing.categoryPath).toEqual(["Home", "Shop", "Cigars", "Padron"]);
  });

  it("maps OutOfStock availability to false", () => {
    const listing = normalize("product-oliva.html")!;
    expect(listing.inStock).toBe(false);
    expect(listing.priceCents).toBe(1375);
  });

  it("falls back to the offer's own price when there is no priceSpecification", () => {
    const listing = normalize("product-broken-jsonld.html")!;
    expect(listing.priceCents).toBe(920);
    expect(listing.currency).toBe("USD");
    expect(listing.inStock).toBe(true);
  });

  it("returns null for a product with no name", () => {
    expect(normalizeListing({ name: "  " }, [])).toBeNull();
  });
});

describe("isCigarCategory", () => {
  it("accepts a cigar breadcrumb path", () => {
    expect(isCigarCategory(["Home", "Shop", "Cigars", "Padron"], foxCigar)).toBe(true);
  });

  it("rejects an accessory path", () => {
    expect(isCigarCategory(["Home", "Shop", "Accessories", "Lighters"], foxCigar)).toBe(false);
  });

  it("rejects a sampler even though it sits under Cigars", () => {
    expect(isCigarCategory(["Home", "Shop", "Cigars", "Samplers"], foxCigar)).toBe(false);
  });
});
