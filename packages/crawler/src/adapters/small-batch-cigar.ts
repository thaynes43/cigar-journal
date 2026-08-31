import type { ExclusionVendorAdapter } from "./types.js";

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
//   3. The exclusion gate below. Live 2026-08-29 established only that products
//      are ROOT-LEVEL slugs (`/tatuaje-brown-label-noella/`) — there is no prefix
//      to match, so the gate is negative. The path list is written against an
//      UNCONFIRMED platform: under-matching only wastes fetch budget (normalize +
//      isCigarListing still gate the writes), over-matching silently drops
//      products. Re-probe and correct the pattern before enabling.
//   4. Whether the sitemapindex has a product-only child. If it does, pointing
//      sitemapUrl at that child (the Cuban Lou's fix) is sharper than any pattern.
//   5. Product pages embed a schema.org Product in JSON-LD.
//   6. maxPages (below) is a SAFETY cap for the probe/dry-run era, well under the
//      ~20k catalog — raise deliberately for a full seed once the shape is known.
export const smallBatchCigar: ExclusionVendorAdapter = {
  slug: "small-batch-cigar",
  name: "Small Batch Cigar",
  url: "https://www.smallbatchcigar.com",
  sitemapUrl: "https://www.smallbatchcigar.com/sitemap.xml",
  kind: "vendor",
  focus: "NC",
  crawlEnabled: false,
  approvalStatus: "owner-added",
  displayEnabled: true,
  purchaseLinkout: true,
  // Exclusion gate (Mode B): reject the known non-product paths, then require a
  // single path segment. The depth bound carries most of the load — `/blogs/news/x`
  // is out on shape alone — and the pattern catches root-level non-products
  // (`/`, `/cart.php`, `/search`).
  //
  // Every reserved word ends at `(?:\/|$)`, a full SEGMENT boundary, not `\b`:
  // `\b` also fires at a hyphen, so `^\/cart\b` matched `/cart-blanche-robusto/`
  // and the gate dropped real products silently. Both alternatives are anchored
  // at `^` for the same reason — an unanchored branch matches mid-path.
  nonProductPathPattern:
    /^\/(?:$|(?:pages|blogs?|collections?|categories|brands|policies|customer|account)\/|(?:search|cart|checkout|login|logout|register|wishlist|compare|sitemap|feed|rss)(?:\/|$))|^\/.*\.(?:php|xml|json|txt)$/i,
  productPathSegments: { min: 1, max: 1 },
  cigarCategoryPattern: /cigar/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
  // Conservative: ~4s between requests (well above the 2s floor) and a page cap
  // that keeps early runs bounded against a 20k-URL catalog.
  minIntervalMs: 4000,
  maxPages: 500,
};
