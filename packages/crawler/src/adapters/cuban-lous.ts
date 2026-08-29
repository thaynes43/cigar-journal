import type { VendorAdapter } from "./types.js";

// Cuban Lou's (cubanlous.com) — a WooCommerce store like Fox (ADR-006 /
// vendor-sources.md), crawled for CC inventory depth. Owner ruling 2026-08-29:
// its offers feed price-at-a-glance/history and its images feed product photos,
// but it is OFF the r/cubancigars approved list, so it is NEVER presented as a
// place to buy — `purchaseLinkout: false` + `approvalStatus: 'unapproved'`, and
// the detail page renders its rows as plain, unapproved-labeled text (no
// link-out). Also carries the US-embargo exposure flag on surfacing Habanos
// price data (vendor-sources.md) — an admin/registry decision, not this lane's.
//
// robots/ToS NOT yet live-verified — coordinator runs the in-cluster probe before
// the registry enables crawling (ADR-006 rule; the dev pod cannot reach this
// domain). `crawlEnabled: false` until it passes.
//
// Probe MUST confirm, and the coordinator correct the adapter where wrong:
//   1. robots.txt allows our UA on the product path (WooCommerce default disallows
//      only /wp-admin/ — read it; installs vary).
//   2. sitemapUrl exists (WooCommerce SEO plugins usually emit /sitemap.xml, often
//      a sitemapindex — verify the root path and shape).
//   3. productPathPrefix: WooCommerce ships `/product/` by default, but Fox uses a
//      custom `/shop/` base — confirm Cuban Lou's real prefix from one product URL.
//   4. Product pages embed a schema.org Product in JSON-LD (WooCommerce norm).
export const cubanLous: VendorAdapter = {
  slug: "cuban-lous",
  name: "Cuban Lou's",
  url: "https://www.cubanlous.com",
  sitemapUrl: "https://www.cubanlous.com/sitemap_index.xml",
  focus: "CC",
  crawlEnabled: false,
  approvalStatus: "unapproved",
  // Display is allowed (offers/photos are ingested and shown)…
  displayEnabled: true,
  // …but never as a purchase destination (owner ruling 2026-08-29).
  purchaseLinkout: false,
  productPathPrefix: "/product/",
  cigarCategoryPattern: /cigar|habano/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
};
