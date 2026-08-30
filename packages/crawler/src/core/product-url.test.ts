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
  const accepts = [
    "https://www.smallbatchcigar.com/tatuaje-brown-label-noella/",
    "https://www.smallbatchcigar.com/xikar-xi3-cutter",
  ];
  // Product slugs whose FIRST hyphen-delimited word is a reserved path word. A
  // `\b` after the word matches at the hyphen too, so these were all dropped —
  // silently, with no note, error or stat, leaving a short catalog that reads as
  // a healthy run.
  const reservedWordSlugs = [
    "https://www.smallbatchcigar.com/feed-the-monster-toro/",
    "https://www.smallbatchcigar.com/cart-blanche-robusto/",
    "https://www.smallbatchcigar.com/search-and-destroy-toro/",
    "https://www.smallbatchcigar.com/register-edition-2020/",
    "https://www.smallbatchcigar.com/compare-cigars-sampler/",
    "https://www.smallbatchcigar.com/login-torpedo/",
    "https://www.smallbatchcigar.com/logout-lancero/",
    "https://www.smallbatchcigar.com/checkout-line-lancero/",
    "https://www.smallbatchcigar.com/wishlist-edition/",
    "https://www.smallbatchcigar.com/sitemap-cigar/",
    "https://www.smallbatchcigar.com/rss-limited-2019/",
  ];
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
    // The reserved words themselves, as whole segments, still go.
    "https://www.smallbatchcigar.com/cart/",
    "https://www.smallbatchcigar.com/checkout",
    "https://www.smallbatchcigar.com/feed/",
  ];

  it("accepts root-level product slugs", () => {
    for (const url of accepts) expect(isProductUrl(url, smallBatchCigar)).toBe(true);
  });

  it("rejects non-product paths and anything deeper than one segment", () => {
    for (const url of rejects) expect(isProductUrl(url, smallBatchCigar)).toBe(false);
  });

  it("accepts a product slug that merely STARTS with a reserved path word", () => {
    for (const url of reservedWordSlugs) expect(isProductUrl(url, smallBatchCigar), url).toBe(true);
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

// Split a regex source on TOP-LEVEL alternation, stepping over `|` inside
// groups, character classes and escapes. `source.startsWith("^")` says nothing
// about the branches after the first `|`, and an unanchored branch matches
// mid-path — which is how a gate silently drops products.
function topLevelAlternatives(source: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") {
      current += ch + (source[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      current += ch;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

describe("topLevelAlternatives", () => {
  it("splits only on alternation outside groups, classes and escapes", () => {
    expect(topLevelAlternatives("^/cart|checkout")).toEqual(["^/cart", "checkout"]);
    expect(topLevelAlternatives("^/(?:cart|checkout)/")).toEqual(["^/(?:cart|checkout)/"]);
    expect(topLevelAlternatives("^/[a|b]x")).toEqual(["^/[a|b]x"]);
    expect(topLevelAlternatives("^/a\\|b")).toEqual(["^/a\\|b"]);
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
        const pattern = adapter.nonProductPathPattern!;
        // EVERY top-level branch anchored, not just the first — an unanchored
        // branch matches mid-path and silently drops products (a slug containing
        // "checkout" is not the checkout page).
        for (const alternative of topLevelAlternatives(pattern.source)) {
          expect(alternative.startsWith("^"), `${slug}: unanchored branch ${alternative}`).toBe(true);
        }
        // `g`/`y` make RegExp.test stateful via lastIndex, so consecutive
        // matching URLs would alternate accept/reject inside filterProductUrls.
        expect(pattern.global, slug).toBe(false);
        expect(pattern.sticky, slug).toBe(false);
      }
    }
  });
});
