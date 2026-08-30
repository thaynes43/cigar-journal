import type { PrefixVendorAdapter } from "./types.js";

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
//   2. Whether sampling is enough. Live 2026-08-29: the SAME sitemap URL served
//      1,462 `/store/` product locs on one fetch and 6,356 locs with ZERO
//      `/store/` entries on the next — the content varies per request, so a
//      single-fetch crawl is a coin flip. `sitemapSampling` below unions four
//      root fetches; the probe prints the per-sample loc counts so the count (and
//      an explicit `intervalMs`) can be tuned from real numbers rather than the
//      two observations we have. A stable product-only sitemap variant, if one
//      exists, would beat sampling outright.
//   3. Product pages embed a schema.org Product in JSON-LD (NitroSell templates
//      vary — if absent, JSON-LD parsing yields nothing and the shape must change).
export const twoGuysCigars: PrefixVendorAdapter = {
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
  // Four fetches: at the ~p=0.5 the two live observations suggest, that is a ~94%
  // chance of at least one product-bearing response, and the union also improves
  // coverage if the variance is partial rather than all-or-nothing. Cost is four
  // fetches (~12s) against a 1,462-page walk at ≥2.5s — noise. No intervalMs: the
  // fetcher's global limiter already spaces them, and we have no measurement of
  // this vendor's cache TTL to pick a better number from.
  sitemapSampling: { samples: 4 },
  cigarCategoryPattern: /cigar/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
};
