import { describe, it, expect } from "vitest";
import { extractJsonLd } from "./jsonld.js";
import { normalizeListing, isCigarCategory, isCigarListing, decodeEntities, parsePackaging } from "./normalize.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { smallBatchCigar } from "../adapters/small-batch-cigar.js";
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

  // #270, live 2026-09-02: Small Batch is nopCommerce and every cigar page is a
  // GROUPED product — the parent node carries `"0.00"` and the real per-pack
  // prices exist only in HTML. Writing that through would have put ~8,000 $0.00
  // observations in `offers`, which is worse than no price: it is a false one.
  it("reads a zero JSON-LD price as UNKNOWN, not as $0, and flags it", () => {
    const listing = normalizeListing(
      {
        name: "Eastern Standard Sungrown Toro Extra",
        sku: "CALD-ES-SG-TE",
        offers: [{ price: "0.00", priceCurrency: "USD", availability: "https://schema.org/InStock" }],
      },
      ["SHOP BY BRAND", "Caldwell", "Signature", "Eastern Standard Sungrown Toro Extra"],
    )!;

    expect(listing.priceCents).toBeNull();
    expect(listing.priceIsPlaceholder).toBe(true);
    // The REST of the listing is good and is carried: stock, sku, taxonomy.
    expect(listing.inStock).toBe(true);
    expect(listing.sku).toBe("CALD-ES-SG-TE");
    expect(listing.categoryPath).toEqual(["SHOP BY BRAND", "Caldwell", "Signature"]);
  });

  it("leaves a real price untouched and unflagged", () => {
    const listing = normalize("product-padron.html")!;
    expect(listing.priceCents).toBe(2450);
    expect(listing.priceIsPlaceholder).toBe(false);
  });

  // A vendor that states no price at all is a different thing from one that
  // states a placeholder, and only the second is a vendor-level defect.
  it("does not flag a listing that states no price at all", () => {
    const listing = normalizeListing({ name: "Padron 1964 Torpedo", offers: [{ availability: "InStock" }] }, [])!;
    expect(listing.priceCents).toBeNull();
    expect(listing.priceIsPlaceholder).toBe(false);
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

  // Small Batch's taxonomy is brand-first and never says "cigars" (#270, live
  // 2026-09-02), so its category pattern is `/./` and the exclusion carries the
  // load. The empty case is the one that keeps that safe.
  it("accepts a brand-first path with no cigar word, and still refuses an empty taxonomy", () => {
    expect(isCigarCategory(["SHOP BY BRAND", "Caldwell", "Signature"], smallBatchCigar)).toBe(true);
    expect(isCigarCategory(["Amendola Signature Series"], smallBatchCigar)).toBe(true);
    expect(isCigarCategory(["Accessories", "Cutters"], smallBatchCigar)).toBe(false);
    expect(isCigarCategory(["Gift Cards"], smallBatchCigar)).toBe(false);
    expect(isCigarCategory([], smallBatchCigar)).toBe(false);
  });
});

describe("decodeEntities", () => {
  it("decodes double-encoded WooCommerce names until stable", () => {
    expect(decodeEntities("Figurado &amp;amp; House Collection")).toBe("Figurado & House Collection");
    expect(decodeEntities("Guy Fieri&#039;s Knuckle Sandwich")).toBe("Guy Fieri's Knuckle Sandwich");
  });
});

describe("isCigarListing", () => {
  const listing = (name: string) => ({
    name,
    priceCents: null,
    currency: null,
    priceIsPlaceholder: false,
    inStock: null,
    imageUrl: null,
    sku: null,
    categoryPath: ["Home", "Shop", "Cigars"],
    packaging: null,
    sticksPerPackage: null,
  });

  it("rejects sets, kits, and mixed cases living under cigar categories", () => {
    expect(isCigarListing(listing("Fuente OpusX 25th Aniversario Humidor Set"), foxCigar)).toBe(false);
    expect(isCigarListing(listing("Montecristo 90th Case / Duo Kit"), foxCigar)).toBe(false);
    expect(isCigarListing(listing("Taste of Oliva Sampler"), foxCigar)).toBe(false);
  });

  it("keeps a plain cigar listing", () => {
    expect(isCigarListing(listing("Arturo Fuente Don Carlos Double Robusto"), foxCigar)).toBe(true);
  });
});

describe("parsePackaging", () => {
  it("reads a box-of-N marker", () => {
    expect(parsePackaging("Padron 1964 Anniversary Maduro Torpedo Box of 20")).toEqual({
      packaging: "box",
      sticksPerPackage: 20,
    });
  });

  it("reads pack-of-N and N-pack markers", () => {
    expect(parsePackaging("Oliva Serie V Melanio Pack of 5")).toEqual({ packaging: "5-pack", sticksPerPackage: 5 });
    expect(parsePackaging("Oliva Serie V 5-Pack")).toEqual({ packaging: "5-pack", sticksPerPackage: 5 });
    expect(parsePackaging("Oliva Serie V 5 Pack")).toEqual({ packaging: "5-pack", sticksPerPackage: 5 });
  });

  it("reads a single marker as one stick", () => {
    expect(parsePackaging("Padron 1964 Anniversary Torpedo Single")).toEqual({
      packaging: "single",
      sticksPerPackage: 1,
    });
  });

  it("leaves an unmarked name unknown — never guessed", () => {
    expect(parsePackaging("Padron 1964 Anniversary Maduro Torpedo")).toEqual({
      packaging: null,
      sticksPerPackage: null,
    });
  });
});
