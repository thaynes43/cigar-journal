import { describe, it, expect } from "vitest";
import {
  filterProductUrls,
  isProductUrl,
  pathOf,
  productGateLabel,
  robotsGatePath,
  segmentCount,
} from "./product-url.js";
import { adapters } from "../adapters/index.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import { smallBatchCigar } from "../adapters/small-batch-cigar.js";
import { parseSitemap } from "./sitemap.js";
import { loadFixture } from "../testing/fixtures.js";

describe("pathOf / segmentCount", () => {
  it("takes the pathname and drops the query", () => {
    expect(pathOf("https://foxcigar.com/shop/padron/?variant=2")).toBe("/shop/padron/");
    // Not a URL — the raw value is the best available key.
    expect(pathOf("/shop/padron/")).toBe("/shop/padron/");
  });

  it("counts non-empty segments", () => {
    expect(segmentCount("/")).toBe(0);
    expect(segmentCount("/padron/")).toBe(1);
    expect(segmentCount("/a/b/")).toBe(2);
    expect(segmentCount("/cart.php")).toBe(1);
  });
});

describe("prefix gate (mode A)", () => {
  it("filters the recorded Fox sitemap exactly as the inline startsWith filter did", () => {
    const locs = parseSitemap(loadFixture("sitemap.xml")).locs;
    const inline = locs.filter((url) => pathOf(url).startsWith("/shop/"));
    expect(filterProductUrls(locs, foxCigar)).toEqual(inline);
    expect(filterProductUrls(locs, foxCigar)).toEqual([
      "https://foxcigar.com/shop/",
      "https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo/",
      "https://foxcigar.com/shop/xikar-hp3-lighter/",
      "https://foxcigar.com/shop/fox-5-cigar-sampler/",
    ]);
  });

  it("admits every loc for Cuban Lou's product-only sitemap", () => {
    const locs = parseSitemap(loadFixture("sitemap.xml", "cuban-lous")).locs;
    expect(filterProductUrls(locs, cubanLous)).toEqual(locs);
  });
});

describe("exclusion gate (mode B)", () => {
  const accepts = ["https://www.smallbatchcigar.com/tatuaje-brown-label-noella/", "https://www.smallbatchcigar.com/xikar-xi3-cutter"];
  const rejects = [
    "https://www.smallbatchcigar.com/",
    "https://www.smallbatchcigar.com/pages/about/",
    "https://www.smallbatchcigar.com/blogs/news/post/",
    "https://www.smallbatchcigar.com/collections/tatuaje/",
    "https://www.smallbatchcigar.com/cart.php",
    "https://www.smallbatchcigar.com/account/orders/",
    "https://www.smallbatchcigar.com/policies/refund/",
    "https://www.smallbatchcigar.com/search",
    "https://www.smallbatchcigar.com/sitemap.xml",
    "https://www.smallbatchcigar.com/a/b/",
  ];

  it("accepts root-level product slugs", () => {
    for (const url of accepts) expect(isProductUrl(url, smallBatchCigar)).toBe(true);
  });

  it("rejects non-product paths and anything deeper than one segment", () => {
    for (const url of rejects) expect(isProductUrl(url, smallBatchCigar)).toBe(false);
  });
});

describe("gate metadata", () => {
  it("names the robots gate path per mode", () => {
    expect(robotsGatePath(foxCigar)).toBe("/shop/");
    expect(robotsGatePath(cubanLous)).toBe("/");
    // Mode B has no prefix — robotsProbePath, else the site root.
    expect(robotsGatePath(smallBatchCigar)).toBe("/");
    expect(robotsGatePath({ ...smallBatchCigar, robotsProbePath: "/catalog/" })).toBe("/catalog/");
  });

  it("renders a label for both modes", () => {
    expect(productGateLabel(foxCigar)).toBe("prefix /shop/");
    expect(productGateLabel(smallBatchCigar)).toMatch(/^not \/.*\/i segments 1\.\.1$/);
  });
});

describe("registry invariant", () => {
  // The types make the two gate modes mutually exclusive; this is the runtime
  // guard behind that, so a `as VendorAdapter` cast in a future adapter cannot
  // ship an ambiguous (or gate-less) vendor.
  it("every registered adapter declares exactly one gate mode", () => {
    for (const [slug, adapter] of Object.entries(adapters)) {
      const modeA = adapter.productPathPrefix !== undefined;
      const modeB = adapter.nonProductPathPattern !== undefined;
      expect(modeA !== modeB, `${slug} must declare exactly one product gate mode`).toBe(true);
      if (modeA) {
        expect(adapter.productPathSegments, slug).toBeUndefined();
        expect(adapter.robotsProbePath, slug).toBeUndefined();
      } else {
        // Anchored at the start, or it matches mid-path and silently drops
        // products (a slug containing "cart" is not the cart page).
        expect(adapter.nonProductPathPattern!.source.startsWith("^"), slug).toBe(true);
      }
    }
  });
});
