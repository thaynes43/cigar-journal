import type { ExclusionVendorAdapter } from "./types.js";

// Small Batch Cigar (smallbatchcigar.com) — nopCommerce behind Cloudflare,
// LIVE-PROBED in-cluster 2026-09-02 (#270). This header used to carry six
// defensive assumptions; the probe settled every one of them, so what follows is
// findings, not guesses:
//
//   robots.txt  a single `User-agent: *` group, ~90 stock nopCommerce disallows
//               (`/checkout`, `/cart$`, `/wishlist`, `/compareproducts`,
//               `/boards/*`, `/customer/*`, `/search?` …) and NO Crawl-delay.
//               None of them touches a root product slug, so `minIntervalMs`
//               below is OUR choice of politeness, not the vendor's ask.
//   sitemap     a FLAT `urlset` at /sitemap.xml — 11,288 locs, identical
//               changefreq/lastmod on every entry, no sitemapindex. There is
//               therefore no product-only child to point `sitemapUrl` at (the
//               Cuban Lou's sharpening does not exist for this vendor).
//   no API      `/products.json` 404s — nopCommerce, not Shopify. Sitemap
//               enumeration + JSON-LD is the only structured path.
//   JSON-LD     product pages carry BreadcrumbList + Product; landing pages carry
//               only BreadcrumbList. `sku`, `availability` and `image`
//               (images.smallbatchcigar.com) are trustworthy. `offers.price` is
//               "0.00" on 20/20 cigar products — a nopCommerce GROUPED product
//               publishes the parent at zero and keeps the real prices in HTML
//               `variant-overview` blocks, one per pack size. normalizeListing
//               reads a zero as UNKNOWN, never as $0 (normalize.ts); a real
//               price extractor is ADR-015 work, not this adapter's.
//   taxonomy    breadcrumbs are `SHOP BY BRAND / <brand> / [<line>]`, or a
//               house-line root (`Modern Tobacconist`, `Amendola Signature
//               Series`, `Connecticut Valley Reserve`). The word "cigars" appears
//               NOWHERE in it, which is why the old `/cigar/i` category gate
//               passed 4 of 20 real cigars.
//
// Catalogue depth for the asks this unblocks: Caldwell 89 locs, Tatuaje 120.
//
// `crawlEnabled` stays false in code — flipping it is the operator's registry
// decision after an in-cluster probe, never an adapter edit (ADR-006).
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
  // single path segment. Measured against all 11,288 live locs: 10,955 accepted,
  // 333 rejected. The depth bound rejects the entire blog (331 `/blog/<slug>`)
  // on shape alone, and the pattern takes the root plus the six non-product ROOT
  // slugs the live sitemap actually carries — `/contactus`, `/blog`, `/boards`,
  // `/shop-by-brand`, `/accessories`, `/gift-card`. Each was leaking before: the
  // directory branch requires a trailing `/`, so a bare `/blog` walked straight
  // through it.
  //
  // What no pattern can fix: brand pages (`/caldwell`), line pages
  // (`/tatuaje-black-label`) and products (`/eastern-standard-sungrown-toro-extra`)
  // are ALL one-segment slugs, so ~23% of what this gate accepts carries no
  // Product at all. Those are found by FETCHING them — normalizeListing returns
  // null and ingest drops them — and that cost is priced into maxPages below.
  //
  // Every reserved word ends at `(?:\/|$)`, a full SEGMENT boundary, not `\b`:
  // `\b` also fires at a hyphen, so `^\/cart\b` matched `/cart-blanche-robusto/`
  // and the gate dropped real products silently. Both alternatives are anchored
  // at `^` for the same reason — an unanchored branch matches mid-path.
  nonProductPathPattern:
    /^\/(?:$|(?:pages|blogs?|collections?|categories|brands|policies|customer|account)\/|(?:search|cart|checkout|login|logout|register|wishlist|compare|sitemap|feed|rss|blog|boards|contactus|shop-by-brand|accessories|gift-card)(?:\/|$))|^\/.*\.(?:php|xml|json|txt)$/i,
  productPathSegments: { min: 1, max: 1 },
  // Any non-empty breadcrumb taxonomy is a cigar taxonomy here, because this
  // store's does not name a "cigars" category anywhere — it is brand-first
  // (`SHOP BY BRAND / Caldwell / Signature`). `/cigar/i` passed 4 of 20 real
  // cigars live, silently discarding the rest. `excludePattern` carries the whole
  // load instead, which it can: `Accessories` is the only non-cigar bucket the
  // live taxonomy has, and every accessory's path contains it. An empty
  // breadcrumb trail still fails `/./`, so a page with no taxonomy is never
  // claimed as a cigar.
  cigarCategoryPattern: /./,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?|gift.?card/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
  // 3s between requests. The live robots.txt asks for no Crawl-delay at all, so
  // this is discretionary politeness above the 2.5s fetcher default, not a
  // vendor requirement — sized for an 11k-URL store we have no relationship with.
  minIntervalMs: 3000,
  // A SAFETY cap, and it is well under a full pass: the gate accepts 10,955 URLs,
  // so a seed is ~11k fetches ≈ 9h at the interval above. The fetcher THROWS
  // (MaxPagesExceededError) at the cap rather than stopping cleanly, so a full
  // seed is not "let it run" — it needs a deliberately raised cap AND a deadline
  // long enough to finish, or the run dies mid-catalogue with nothing to resume
  // from. Resume/chunking so a capped run is restartable is tracked under #270.
  maxPages: 500,
};
