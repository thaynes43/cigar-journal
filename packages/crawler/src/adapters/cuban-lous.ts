import type { PrefixVendorAdapter } from "./types.js";

// Cuban Lou's (cubanlous.com) — a WooCommerce store like Fox (ADR-006 /
// vendor-sources.md), crawled for the Habanos depth Fox does not carry (see
// `focus` below: the shop itself trades in both markets). Owner ruling 2026-08-29:
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
export const cubanLous: PrefixVendorAdapter = {
  slug: "cuban-lous",
  name: "Cuban Lou's",
  url: "https://www.cubanlous.com",
  sitemapUrl: "https://www.cubanlous.com/product-sitemap.xml",  // live-probed: Yoast product-only child (985 locs)
  kind: "vendor",
  // NOT 'CC', despite the name. Measured against the live catalogue 2026-08-31:
  // of the 57 untyped cigars this shop is the sole stockist of, the clear
  // majority are not Cuban — Perdomo, Gurkha, CAO, Rocky Patel, Quorum, Bahia,
  // Graycliff, Camacho, Drew Estate, Alec Bradley, Dominican and Nicaraguan
  // bundles, one listing literally named "Cohiba & Montecristo DOMINICAN Bundle",
  // and a Xikar punch that is not a cigar at all. Genuine Habanos sit alongside
  // them. So it trades in both markets, and 'CC' was a factual error about the
  // shop, not a modelling choice. Recording it as `both` is what makes the
  // evidenced market (ADR-006) honest: a both-market vendor contributes no
  // market evidence, so this shop's listings stop asserting `CC` about cigars
  // that are not. Migration 0025 corrects the existing registry row; this value
  // only seeds a fresh one (`resolveVendor` is insert-if-absent).
  focus: "both",
  crawlEnabled: false,
  approvalStatus: "unapproved",
  // Tier 2 (ADR-015): off the r/cubancigars approved list, so it is not the price
  // authority. Its offers are still RECORDED — a promotion is then a flag flip
  // rather than a re-crawl — and are meant not to be SHOWN: `display_enabled` is
  // seeded from the tier (false here), and this row already exists in prod, so the
  // run reports the disagreement rather than writing it. Note the gate is only
  // half-wired: nothing in the offers read paths consults `display_enabled` yet
  // (see .agents/reference/vendor-sources.md). Its photos, meanwhile, fill only
  // the slots tier 1 could not, and a tier-1 capture supersedes them.
  tier: 2,
  // Never a purchase destination either (owner ruling 2026-08-29).
  purchaseLinkout: false,
  productPathPrefix: "/",  // permalinks are /<category>/<slug>/ with no shared prefix; the sitemap above is already product-only
  cigarCategoryPattern: /cigar|habano/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
};
