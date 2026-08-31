import type { PrefixVendorAdapter } from "./types.js";

// 2 Guys Cigars (2guyscigars.com) — a WebSell/NitroSell store (ADR-006 /
// vendor-sources.md). Live-probed twice from the cluster; the values below are
// what those probes established, plus the assumptions they have not yet reached.
//
// robots/ToS: allowed (`status=200 agent=* allows=true`, 2026-08-29 and
// 2026-08-30). `crawlEnabled: false` still, because no probe has yet PARSED a
// real product page here — see the re-probe bar in the ADR-006 amendment.
//
// 2026-08-30 probe, the one that mattered:
//   sitemap: 6,356 locs, 6,351 enumerated, 1,462 passing `/store/`
//   products: sampled=3 parsed=0 — all three picks were
//     `/store/go/registry/{1059,4401,8079}/`, gift-registry pages with no
//     schema.org Product JSON-LD.
// The verdict (`needs-attention`) was TRUE but misattributed: it read as "this
// vendor has no JSON-LD" when the real fault was the GATE. `/store/` also matches
// `/store/go/...`, a non-catalog dispatcher subtree, so the enumeration handed the
// sampler ~1,400 customers' registry pages. A seed crawl would have fetched them
// all at >=2.5s each — a courtesy problem, not just a wasted-budget one. Hence the
// subtraction below.
//
// The 2026-08-29 sitemap CONTENT VARIANCE (1,462 `/store/` locs on one fetch,
// 6,356 with none on the next) did NOT reproduce on 2026-08-30: four samples all
// returned 6,356 locs, `new=6351/0/0/0`, `varied=no`. One clean observation does
// not disprove an intermittent behaviour and the 2026-08-29 reading was real, so
// `sitemapSampling` stays. Bar for reducing it: two consecutive `varied=no`
// probes AFTER the vendor is enabled, as its own change.
//
// Probe MUST still confirm, and the coordinator correct the adapter where wrong:
//   1. That a real product URL exists under `/store/` outside `/store/go/`, and
//      that it embeds a schema.org Product in JSON-LD (NitroSell templates vary).
//      If `product-locs` drops to 0, this sitemap does not enumerate products
//      under `/store/` at all and the next move is a different prefix or a
//      different enumeration source — read the `paths: out ...` census line.
//   2. The breadcrumb shape `isCigarListing` gates on. The fixture's breadcrumbs
//      are hand-written; no live product page has been parsed yet.
export const twoGuysCigars: PrefixVendorAdapter = {
  slug: "two-guys-cigars",
  name: "2 Guys Cigars",
  url: "https://www.2guyscigars.com",
  sitemapUrl: "https://www.2guyscigars.com/sitemap.xml",
  kind: "vendor",
  focus: "NC",
  crawlEnabled: false,
  approvalStatus: "owner-added",
  displayEnabled: true,
  purchaseLinkout: true,
  productPathPrefix: "/store/",  // live-probed 2026-08-29: 1,462 locs under /store/
  // …minus the `/store/go/` dispatcher subtree. Excludes the WHOLE family, not
  // just `registry`, because siblings we have not sampled (`cart`, `wishlist`,
  // `account`) are the same kind of page. `go` followed by a numeric id is a
  // router shape, not a product slug.
  //
  // `(?:\/|$)` is a full SEGMENT boundary and NOT `\b`: `\b` fires at a hyphen
  // too, which is how Small Batch's `^\/cart\b` silently ate
  // `/cart-blanche-robusto/`. As written, `/store/go-big-or-go-home-robusto/`
  // and `/store/gold-label-toro/` are kept; only a literal `go` segment goes.
  //
  // The `i` flag is belt-and-braces only: `startsWith("/store/")` is
  // case-SENSITIVE, so `/Store/Go/` never reaches this pattern at all. Do not
  // "harmonize" the two sides without deciding which way — dropping `i` narrows
  // the exclusion, and case-folding the prefix widens the gate.
  nonProductPathPattern: /^\/store\/go(?:\/|$)/i,
  // Four fetches, kept from 2026-08-29 (see the variance note above). Cost is
  // four fetches (~12s) against a multi-hundred-page walk at >=2.5s — noise. No
  // intervalMs: the fetcher's global limiter already spaces them, and we have no
  // measurement of this vendor's cache TTL to pick a better number from.
  sitemapSampling: { samples: 4 },
  cigarCategoryPattern: /cigar/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
};
