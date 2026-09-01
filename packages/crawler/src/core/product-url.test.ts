import { describe, it, expect } from "vitest";
import {
  filterProductUrls,
  isProductUrl,
  pathOf,
  pathShapeCensus,
  PATH_CENSUS_TOP,
  productGateLabel,
  robotsGatePath,
  segmentCount,
} from "./product-url.js";
import { adapters } from "../adapters/index.js";
import type { VendorAdapter } from "../adapters/types.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import { smallBatchCigar } from "../adapters/small-batch-cigar.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
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

// Mode A + pattern (#179). No REGISTERED adapter uses it any more — 2 Guys moved
// to Mode B on the 2026-09-01 live read — so it is exercised through a synthetic
// adapter rather than dropped: the capability is still in `isProductUrl`, and an
// untested branch is how `^\/cart\b` shipped.
const modeAWithExclusion: VendorAdapter = {
  ...foxCigar,
  productPathPrefix: "/store/",
  nonProductPathPattern: /^\/store\/go(?:\/|$)/i,
};

describe("prefix gate with exclusion (mode A + pattern)", () => {
  const accepts = [
    "https://vendor.example/store/padron-1926-serie-no-9-maduro/",
    "https://vendor.example/store/gold-label-toro/",
    // The hyphen trap, re-armed for Mode A: a `\b` anchor after `go` would match
    // at the hyphen and drop this product silently — the Small Batch
    // `/cart-blanche-robusto/` bug. `(?:\/|$)` is a full segment boundary.
    "https://vendor.example/store/go-big-or-go-home-robusto/",
  ];
  const rejects = [
    // The three URLs the 2026-08-30 live probe sampled, by path.
    "https://vendor.example/store/go/registry/1059/",
    "https://vendor.example/store/go/registry/4401/",
    "https://vendor.example/store/go/registry/8079/",
    // The segment itself, with and without the trailing slash.
    "https://vendor.example/store/go/",
    "https://vendor.example/store/go",
    // Siblings we have not sampled: the gate excludes the FAMILY, not one member.
    "https://vendor.example/store/go/wishlist/",
    "https://vendor.example/store/go/anything-we-have-not-seen/",
    // Still outside the prefix — the prefix does this work, not the pattern.
    "https://vendor.example/about-us/",
    "https://vendor.example/",
  ];

  it("accepts products under the prefix, including slugs that merely start with `go`", () => {
    for (const url of accepts) expect(isProductUrl(url, modeAWithExclusion), url).toBe(true);
  });

  it("rejects the whole /store/go/ family and everything outside the prefix", () => {
    for (const url of rejects) expect(isProductUrl(url, modeAWithExclusion), url).toBe(false);
  });

  it("changes nothing for a prefix adapter that sets no pattern", () => {
    const locs = parseSitemap(loadFixture("sitemap.xml")).locs;
    expect(foxCigar.nonProductPathPattern).toBeUndefined();
    expect(filterProductUrls(locs, foxCigar)).toEqual([
      "https://foxcigar.com/shop/",
      "https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo/",
      "https://foxcigar.com/shop/xikar-hp3-lighter/",
      "https://foxcigar.com/shop/fox-5-cigar-sampler/",
    ]);
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

// 2 Guys, re-derived on the 2026-09-01 live read (#217): the sitemap is 1 root +
// 4,888 one-segment slugs + 1,467 `/store/go/registry/<n>/`, and a product slug
// is the one that ends in a NitroSell product code. Every URL below is a real loc
// from that fetch.
describe("exclusion gate (mode B) — 2 Guys product-code slugs", () => {
  const two = (path: string): string => `https://www.2guyscigars.com${path}`;

  const accepts = [
    // Products, live-fetched: 200, og:type=product, itemtype schema.org/Product.
    two("/perdomo-30th-robusto-sg-s-165681/"),
    two("/romacraft-steel-porcupine-184527/"),
    two("/smoke-exterm-candle-orange-734366037362/"),
    two("/la-galera-hab-chaveta-s-127401/"),
    // The hyphen trap in its live form: a real product whose slug starts with the
    // letters of a path word. Nothing in the pattern may anchor on `\b`.
    two("/gold-star-gordo-072817/"),
    // A non-cigar product. The gate's job is "is this a product page", not "is
    // this a cigar" — `isCigarListing` answers the second one.
    two("/2-guys-birch-beer-710009/"),
    // A product whose slug merely CONTAINS `store`: the /store/ branch must end
    // at a segment boundary.
    two("/store-brand-robusto-123456/"),
    // Both forms the enumeration and a link can produce.
    two("/zino-nicaragua-toro-260256"),
  ];

  const rejects = [
    // The registry family: 1,467 locs, the whole reason #179 existed.
    two("/store/go/registry/1059/"),
    two("/store/go/registry/8079/"),
    two("/store/filtered/"), // the one path this vendor's robots.txt disallows
    two("/store/"),
    two("/store"),
    // Category and brand landing pages — live 200s with no product markup.
    two("/cigars-perdomo-30th-maduro/"),
    two("/crowned-heads/"),
    two("/aganorsa-leaf/"),
    two("/Cigars/"),
    // Site pages.
    two("/about-us/"),
    two("/privacy-policy/"),
    two("/"),
    // A sitemap loc that 404s — six of the eleven non-code slugs sampled did.
    two("/zino-nicaragua-cigars/"),
    // Depth: nothing on this site is two or three segments deep, and if that
    // changes the depth bound answers before the pattern does.
    two("/cigars/padron-1926-123456/"),
  ];

  it("accepts a one-segment slug ending in a product code", () => {
    for (const url of accepts) expect(isProductUrl(url, twoGuysCigars), url).toBe(true);
  });

  it("rejects the /store/ subtree, landing pages, site pages and deeper paths", () => {
    for (const url of rejects) expect(isProductUrl(url, twoGuysCigars), url).toBe(false);
  });

  // Both imprecisions are measured and deliberate; they are recorded here so a
  // future change that alters either one has to say so.
  it("knowingly admits the nine category pages whose title ends in a number", () => {
    for (const url of [two("/cigars-byron-1850/"), two("/cigars-topper-1894/")]) {
      expect(isProductUrl(url, twoGuysCigars), url).toBe(true);
    }
  });

  it("knowingly drops a product whose code is not numeric", () => {
    // og:upc=GiftCard-Web25 — a real product, and the only one of its shape in
    // the live enumeration. A cigar with an alphanumeric code would be lost the
    // same way, silently, which is why the accepted count is worth watching.
    expect(isProductUrl(two("/gift-certificates-25-giftcard-web25/"), twoGuysCigars)).toBe(false);
  });

  it("filters the recorded live sitemap down to the product-code slugs", () => {
    const locs = parseSitemap(loadFixture("sitemap.xml", "two-guys")).locs;
    expect(locs).toHaveLength(21);
    const kept = filterProductUrls(locs, twoGuysCigars);
    expect(kept.map((url) => pathOf(url))).toEqual([
      "/gold-star-gordo-072817/",
      "/perdomo-30th-robusto-sg-s-165681/",
      "/2-guys-birch-beer-710009/",
      "/cigars-byron-1850/",
      "/romacraft-steel-porcupine-184527/",
      "/20-acre-farm-robusto-017902/",
      "/zino-nicaragua-toro-260256/",
      "/smoke-exterm-candle-orange-734366037362/",
      "/la-galera-hab-chaveta-s-127401/",
    ]);
  });
});

describe("gate metadata", () => {
  it("names the robots gate path per mode", () => {
    expect(robotsGatePath(foxCigar)).toBe("/shop/");
    expect(robotsGatePath(cubanLous)).toBe("/");
    // Mode B has no prefix — robotsProbePath, else the site root.
    expect(robotsGatePath(smallBatchCigar)).toBe("/");
    expect(robotsGatePath({ ...smallBatchCigar, robotsProbePath: "/catalog/" })).toBe("/catalog/");
    // 2 Guys asks about `/` since 2026-09-01: its products are root-level slugs,
    // so `/store/` — the path it used to ask about — is now a subtree it never
    // fetches. The live robots.txt allows `/` and disallows only /store/filtered/.
    expect(robotsGatePath(twoGuysCigars)).toBe("/");
  });

  it("renders a label for both modes", () => {
    expect(productGateLabel(foxCigar)).toBe("prefix /shop/");
    expect(productGateLabel(smallBatchCigar)).toMatch(/^not \/.*\/i segments 1\.\.1$/);
    // The gate line is how the coordinator tells a rebuilt probe image from a
    // cached one, so it prints the pattern verbatim — and this string is what the
    // next in-cluster probe must echo back.
    expect(productGateLabel(twoGuysCigars)).toBe(
      "not /^\\/store(?:\\/|$)|^\\/(?![^/]*-\\d+\\/?$)/i segments 1..1",
    );
  });

  it("does not let a Mode-A exclusion narrow the ROBOTS gate path", () => {
    // robots is asked about the coarse prefix; subtracting a subtree from the URL
    // filter must not change which path we check permission for.
    expect(robotsGatePath(modeAWithExclusion)).toBe("/store/");
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

// The census answers what the gate cannot: not "did anything pass?" but "what
// KINDS of URL are on each side?". It is what would have named `/store/go` on
// the first 2 Guys probe instead of a second in-cluster Job.
describe("pathShapeCensus", () => {
  it("keys on the first two path segments and ranks by count", () => {
    const census = pathShapeCensus([
      "https://x.test/store/go/registry/1/",
      "https://x.test/store/go/registry/2/",
      "https://x.test/store/go/wishlist/9/",
      "https://x.test/store/padron-robusto/",
      // Depth stops at two segments, so deeper paths collapse onto the same key.
      "https://x.test/blog/2026/08/a-post/",
    ]);
    expect(census.top).toEqual([
      { key: "/store/go", count: 3 },
      { key: "/blog/2026", count: 1 },
      { key: "/store/padron-robusto", count: 1 },
    ]);
    expect(census.total).toBe(5);
    expect(census.otherKeys).toBe(0);
    expect(census.otherUrls).toBe(0);
  });

  it("keys a one-segment path and the site root", () => {
    const census = pathShapeCensus(["https://x.test/about-us/", "https://x.test/"]);
    // Ties break on the key, so an unchanged site prints an identical line twice.
    expect(census.top).toEqual([
      { key: "/", count: 1 },
      { key: "/about-us", count: 1 },
    ]);
  });

  it("caps the top list and counts what it hid, both ways", () => {
    const urls = [
      ...Array.from({ length: 8 }, (_, i) => `https://x.test/a/${i}/`),
      ...Array.from({ length: 7 }, (_, i) => `https://x.test/b/${i}/`),
      ...Array.from({ length: 6 }, (_, i) => `https://x.test/c/${i}/`),
      ...Array.from({ length: 5 }, (_, i) => `https://x.test/d/${i}/`),
      ...Array.from({ length: 4 }, (_, i) => `https://x.test/e/${i}/`),
      // Two hidden keys behind three URLs.
      "https://x.test/f/1/",
      "https://x.test/f/2/",
      "https://x.test/g/1/",
    ];
    const census = pathShapeCensus(urls, 1);
    expect(census.top).toHaveLength(PATH_CENSUS_TOP);
    expect(census.top.map((e) => e.key)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
    expect(census.otherKeys).toBe(2);
    expect(census.otherUrls).toBe(3);
    expect(census.total).toBe(33);
  });

  it("is empty for an empty enumeration", () => {
    expect(pathShapeCensus([])).toEqual({ top: [], otherKeys: 0, otherUrls: 0, total: 0 });
  });
});

describe("registry invariant", () => {
  // The runtime guard behind the type union, so an `as VendorAdapter` cast in a
  // future adapter cannot ship an ambiguous or gate-less vendor.
  //
  // The mode discriminator is `productPathPrefix !== undefined`, NOT "carries a
  // pattern": since the 2026-08-30 amendment `nonProductPathPattern` is legal in
  // both modes (required in B, optional in A), so it no longer separates them.
  it("every registered adapter declares exactly one gate mode", () => {
    for (const [slug, adapter] of Object.entries(adapters)) {
      const modeA = adapter.productPathPrefix !== undefined;
      const modeB = adapter.nonProductPathPattern !== undefined;
      // Never gate-less: a prefix, a pattern, or both — but something.
      expect(modeA || modeB, `${slug} must declare a product gate`).toBe(true);
      if (modeA) {
        // Mode-B-only knobs stay Mode-B-only. A depth bound on a prefix adapter
        // would be an unbacked guess at the vendor's product depth.
        expect(adapter.productPathSegments, slug).toBeUndefined();
        expect(adapter.robotsProbePath, slug).toBeUndefined();
      } else {
        // Mode B without a pattern would be no gate at all.
        expect(adapter.nonProductPathPattern, `${slug} has no prefix and no pattern`).toBeInstanceOf(RegExp);
      }
    }
  });

  // These run on ANY adapter carrying a pattern, in EITHER mode. Scoping them to
  // Mode B is what would let a Mode-A pattern ship unguarded — precisely the gap
  // that let `^\/cart\b` eat `/cart-blanche-robusto/`. Every REGISTERED pattern
  // is Mode B today (2 Guys left Mode A on 2026-09-01), so the synthetic Mode-A
  // adapter is guarded alongside them rather than the guard losing that mode.
  it("guards every non-product pattern, whichever mode declares it", () => {
    const withPattern = [
      ...Object.entries(adapters).filter(([, a]) => a.nonProductPathPattern !== undefined),
      ["synthetic-mode-a", modeAWithExclusion] as [string, VendorAdapter],
    ];
    // If this ever reads 1 the guard has quietly stopped covering a mode.
    expect(withPattern.length).toBeGreaterThanOrEqual(2);
    expect(withPattern.some(([, a]) => a.productPathPrefix !== undefined)).toBe(true);
    expect(withPattern.some(([, a]) => a.productPathPrefix === undefined)).toBe(true);
    for (const [slug, adapter] of withPattern) {
      const pattern = adapter.nonProductPathPattern!;
      // EVERY top-level branch anchored, not just the first — an unanchored
      // branch matches mid-path and silently drops products (a slug containing
      // "checkout" is not the checkout page).
      for (const alternative of topLevelAlternatives(pattern.source)) {
        expect(alternative.startsWith("^"), `${slug}: unanchored branch ${alternative}`).toBe(true);
      }
      // `\b` after a reserved word also fires at a hyphen, so `^\/cart\b` matched
      // `/cart-blanche-robusto/`. Word boundaries are banned; use `(?:\/|$)`.
      expect(pattern.source.includes("\\b"), `${slug}: \\b is a hyphen trap — use (?:\\/|$)`).toBe(false);
      // `g`/`y` make RegExp.test stateful via lastIndex, so consecutive
      // matching URLs would alternate accept/reject inside filterProductUrls.
      expect(pattern.global, slug).toBe(false);
      expect(pattern.sticky, slug).toBe(false);
    }
  });

  // THE SOURCE KIND (ADR-013 §4, migration 0028). Every adapter here is a shop,
  // and every one says so — the seed path passes `kind` straight into the
  // `vendors` row, so a missing one would be a silent default rather than a
  // statement.
  it("every registered adapter declares itself a vendor, with a market", () => {
    for (const [slug, adapter] of Object.entries(adapters)) {
      expect(adapter.kind, slug).toBe("vendor");
      // A shop's `focus` is required, and it is the claim `evidencedMarketSql`
      // reads to infer a cigar's market.
      expect(["NC", "CC", "both"], slug).toContain(adapter.focus);
    }
  });

  // A TYPE-LEVEL TEST, and it runs under `pnpm typecheck` rather than at runtime.
  //
  // `vendors_non_vendor_source_chk` refuses a non-shop source that carries a
  // market focus — but a CHECK only fires on a row some code was able to build,
  // and by then the failure is a crawl aborting in the cluster. The adapter type
  // is a union discriminated on `kind`, so the same mistake cannot be written
  // down. Each `@ts-expect-error` below asserts that: if the union ever stops
  // refusing these shapes, the suppression becomes unused and typecheck fails on
  // this line — which is the whole mechanism.
  it("refuses a reviewer that claims a market, at the type level", () => {
    const reviewerBase = {
      slug: "halfwheel",
      name: "halfwheel",
      url: "https://halfwheel.example",
      sitemapUrl: "https://halfwheel.example/sitemap.xml",
      crawlEnabled: false,
      approvalStatus: "owner-added",
      displayEnabled: false,
      cigarCategoryPattern: /^$/,
      excludePattern: /^$/,
      productPathPrefix: "/review/",
    } as const;

    // A reviewer stocks nothing, so a focus on it is a stocking claim from a site
    // with no inventory.
    // @ts-expect-error `focus` is forbidden on a non-vendor source kind.
    const withFocus: VendorAdapter = { ...reviewerBase, kind: "reviewer", purchaseLinkout: false, focus: "NC" };

    // And it is never a purchase destination — `false`, not merely defaulted,
    // because the COLUMN defaults to true.
    // @ts-expect-error `purchaseLinkout` narrows to `false` on a non-vendor kind.
    const asDestination: VendorAdapter = { ...reviewerBase, kind: "reviewer", purchaseLinkout: true };

    // A shop, conversely, must state its market.
    // @ts-expect-error `focus` is required on the vendor kind.
    const marketless: VendorAdapter = { ...reviewerBase, kind: "vendor", purchaseLinkout: true };

    // The legal shape, for contrast — no suppression needed.
    const halfwheel: VendorAdapter = { ...reviewerBase, kind: "reviewer", purchaseLinkout: false };
    expect(halfwheel.kind).toBe("reviewer");
    expect(halfwheel.focus).toBeUndefined();
    // Referenced so the bindings above are not dead code the linter strips.
    expect([withFocus, asDestination, marketless]).toHaveLength(3);
  });
});
