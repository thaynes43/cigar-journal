import type { VendorAdapter } from "./types.js";

// 2 Guys Cigars (2guyscigars.com) — a WebSell/NitroSell store (ADR-006 /
// vendor-sources.md), a niche platform whose sitemap + product-URL shapes we
// could NOT read from the dev pod. The values below are DEFENSIVE ASSUMPTIONS.
//
// robots/ToS NOT yet live-verified — coordinator runs the in-cluster probe before
// the registry enables crawling (ADR-006 rule; the dev pod cannot reach this
// domain). `crawlEnabled: false` until it passes.
//
// Probe MUST confirm, and the coordinator correct the adapter where wrong:
//   1. robots.txt allows our UA on the product path (NitroSell defaults permit
//      `/`, but WebSell installs vary — read it).
//   2. sitemapUrl exists and its SHAPE: WebSell/NitroSell may ship a sitemapindex,
//      a non-standard sitemap path, or none at all (verify defensively — if there
//      is no sitemap, this adapter needs a different enumeration strategy).
//   3. productPathPrefix: NitroSell product URLs are NOT the WooCommerce `/shop/`
//      shape; `/product/` is a guess. Confirm the real prefix from one product URL.
//   4. Product pages embed a schema.org Product in JSON-LD (NitroSell templates
//      vary — if absent, JSON-LD parsing yields nothing and the shape must change).
export const twoGuysCigars: VendorAdapter = {
  slug: "two-guys-cigars",
  name: "2 Guys Cigars",
  url: "https://www.2guyscigars.com",
  sitemapUrl: "https://www.2guyscigars.com/sitemap.xml",
  focus: "NC",
  crawlEnabled: false,
  approvalStatus: "owner-added",
  displayEnabled: true,
  purchaseLinkout: true,
  productPathPrefix: "/store/",  // live-probed 2026-08-29: 1,462 product locs under /store/
  cigarCategoryPattern: /cigar/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
};
