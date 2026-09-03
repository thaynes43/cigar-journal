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
// Live-verified in-cluster and enabled in the registry; the 2026-09-03 fleet
// drain walked 75 pages and parsed 73 listings here. The four points the probe
// had to settle — robots on the product path, the sitemap's root and shape, the
// real product prefix (WooCommerce ships `/product/`, this shop does not), and
// schema.org Product in the page's JSON-LD — are settled and encoded below.
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
  // Live in the registry since before ADR-015 and re-confirmed by the operator on
  // 2026-09-02 (#270). The constant FOLLOWS the row; see `adapters/index.ts` for
  // why that is the direction.
  crawlEnabled: true,
  approvalStatus: "unapproved",
  // Tier 2 (ADR-015): off the r/cubancigars approved list, so it is not the price
  // authority. Its offers are still RECORDED — a promotion is then a flag flip
  // rather than a re-crawl — and are not SHOWN: `display_enabled` is seeded from
  // the tier (false here) and every price read now requires it (@cj/domain
  // `offer-display.ts`). This row already exists in prod, so the run REPORTS a
  // disagreement rather than writing it — an admin flipping the flag is what
  // shows these prices. Its photos, meanwhile, fill only the slots tier 1 could
  // not, and a tier-1 capture supersedes them.
  tier: 2,
  // Never a purchase destination either (owner ruling 2026-08-29).
  purchaseLinkout: false,
  productPathPrefix: "/",  // permalinks are /<category>/<slug>/ with no shared prefix; the sitemap above is already product-only
  cigarCategoryPattern: /cigar|habano/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
};
