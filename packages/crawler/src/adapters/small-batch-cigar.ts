import type { VendorAdapter } from "./types.js";

// Small Batch Cigar (smallbatchcigar.com) — platform unknown, ~20k URLs
// (ADR-006 / vendor-sources.md). Large catalog: crawl SLOWER than the floor and
// CAP pages so a misconfigured run cannot walk the whole store. The sitemap +
// product-URL shapes below are DEFENSIVE ASSUMPTIONS.
//
// robots/ToS NOT yet live-verified — coordinator runs the in-cluster probe before
// the registry enables crawling (ADR-006 rule; the dev pod cannot reach this
// domain). `crawlEnabled: false` until it passes.
//
// Probe MUST confirm, and the coordinator correct the adapter where wrong:
//   1. robots.txt allows our UA on the product path AND note any Crawl-delay (we
//      honor rate via minIntervalMs — raise it if robots asks for more).
//   2. sitemapUrl SHAPE: at ~20k URLs a sitemapINDEX (child sitemaps) is likely —
//      collectSitemapUrls recurses one level, but verify the root path and that
//      the index enumerates product URLs (not just category/blog pages).
//   3. productPathPrefix: `/products/` is a guess (unknown platform). Confirm the
//      real prefix from one product URL.
//   4. Product pages embed a schema.org Product in JSON-LD.
//   5. maxPages (below) is a SAFETY cap for the probe/dry-run era, well under the
//      ~20k catalog — raise deliberately for a full seed once the shape is known.
export const smallBatchCigar: VendorAdapter = {
  slug: "small-batch-cigar",
  name: "Small Batch Cigar",
  url: "https://www.smallbatchcigar.com",
  sitemapUrl: "https://www.smallbatchcigar.com/sitemap.xml",
  focus: "NC",
  crawlEnabled: false,
  approvalStatus: "owner-added",
  displayEnabled: true,
  purchaseLinkout: true,
  productPathPrefix: "/products/",
  cigarCategoryPattern: /cigar/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
  // Conservative: ~4s between requests (well above the 2s floor) and a page cap
  // that keeps early runs bounded against a 20k-URL catalog.
  minIntervalMs: 4000,
  maxPages: 500,
};
