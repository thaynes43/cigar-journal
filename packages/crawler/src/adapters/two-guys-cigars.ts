import type { ExclusionVendorAdapter } from "./types.js";

// 2 Guys Cigars (2guyscigars.com) — a WebSell/NitroSell store (ADR-006 /
// vendor-sources.md). Every value below is live-read from the cluster; the dev
// pod cannot reach this domain, so nothing here is inferred from the platform.
//
// robots/ToS: allowed. Live capture 2026-09-01 (`__fixtures__/two-guys/robots.txt`
// is that response verbatim): TWO `User-agent: *` groups — one `Disallow:
// /store/filtered/`, one `Crawl-delay: 5` — plus a long list of named bots
// disallowed outright. We are not among them, `/` is allowed, and the 5s delay is
// honored by `minIntervalMs` below.
//
// `crawlEnabled: false` still: the parser blocker is fixed (#252) but no probe
// has run on this build — see the bottom of the file for what is left.
//
// --- how the gate got here (three in-cluster probes) -------------------------
// 2026-08-30 (#179): `productPathPrefix: "/store/"` admitted 1,462 locs, all of
//   them `/store/go/registry/<n>/` gift-registry pages. Narrowing to `/store/`
//   minus `/store/go/` was correct as far as it went.
// 2026-08-31 (#217): the re-probe on that build returned `product-locs=0`. The
//   `/store/` prefix is not just polluted, it is WRONG: all 1,466 `/store/` locs
//   are the registry family and the rejected census showed 4,883 one-URL-per-key
//   shallow slugs outside it — the per-product tail of a healthy catalog.
// 2026-09-01 (this change): Jobs in ns `frontend` fetched robots.txt, the sitemap
//   and 18 pages from it. The shape, exactly:
//
//     6,356 distinct locs = 1 root + 4,888 ONE-segment slugs + 1,467 four-segment
//     `/store/go/registry/<n>/`. Nothing else. No query strings, no other host,
//     no file extensions, no depth 2 or 3 anywhere.
//
//     Of the 4,888 one-segment slugs, 3,841 end in `-<digits>` and 1,047 do not.
//     That suffix is the NitroSell product code: on every product page sampled it
//     is repeated as `<meta property="og:upc">` (165681, 184527, 734366037362).
//
//     Sampled with the trailing code (5/5): all 200, all `og:type=product`, all
//     carrying `itemtype="https://schema.org/Product"`.
//     Sampled without it (13): six 404 (`zino-nicaragua-cigars`,
//     `perdomo-30th-maduro`, `worlds-strongest-cigar`, `roma-craft-gran-perfecto`,
//     `el-mago-el-cubano-toro-tubo`, `hvc-first-selection-broadleaf` — the sitemap
//     enumerates dead slugs), six category/brand/site pages (`/Cigars/`,
//     `/crowned-heads/`, `/aganorsa-leaf/`, `/cigars-mi-querida/`,
//     `/cigars-perdomo-30th-maduro/`, `/about-us/`), and one real product with a
//     NON-numeric code (`gift-certificates-25-giftcard-web25`,
//     `og:upc=GiftCard-Web25`).
//
// So the product signature is the trailing product code, not a prefix and not a
// nameable family. That is why the pattern below does not enumerate brand/promo
// families: they cannot be enumerated. ~500 of the 1,047 are arbitrary line
// landing slugs (`perdomo-30th-maduro`, `montecristo-1935-diamante`) that no
// keyword separates from a product slug — and the keywords that look promising
// are traps. `^\/cigars-` would drop nine URLs that DO carry a product code, and
// over-matching drops products silently while under-matching only costs fetches.
export const twoGuysCigars: ExclusionVendorAdapter = {
  slug: "two-guys-cigars",
  name: "2 Guys Cigars",
  url: "https://www.2guyscigars.com",
  sitemapUrl: "https://www.2guyscigars.com/sitemap.xml",
  kind: "vendor",
  focus: "NC",
  // Live in the registry since 2026-09-02 (#270) — probed in-cluster, then
  // enabled with `display_enabled` held back until DESIGN-005's packaging-aware
  // prices shipped, and now both. The constant FOLLOWS the row; see
  // `adapters/index.ts` for why that is the direction.
  crawlEnabled: true,
  approvalStatus: "owner-added",
  // Tier 1 (ADR-015): one of the owner's linkout NC shops.
  tier: 1,
  purchaseLinkout: true,
  // Exclusion gate (Mode B), two branches, both anchored:
  //
  //   `^\/store(?:\/|$)` — the whole `/store/` subtree. Live: 1,467 locs, every
  //     one a gift registry, zero products. `(?:\/|$)` is a full SEGMENT
  //     boundary and NOT `\b`, which also fires at a hyphen — the trap that let
  //     Small Batch's `^\/cart\b` eat `/cart-blanche-robusto/`. A product slug
  //     `/store-something-123/` therefore survives this branch.
  //
  //   `^\/(?![^/]*-\d+\/?$)` — reject any path whose one segment does not END in
  //     a product code. Written as a lookahead because the field is a rejection
  //     pattern and the finding is a positive one ("a product URL ends in
  //     `-<digits>`"); the two are the same statement. `[^/]*` cannot cross a
  //     separator, so this also rejects every multi-segment path, which is the
  //     same answer `productPathSegments` gives — deliberate belt and braces.
  //
  // Accepts 3,841 of the 6,356 enumerated locs. TWO KNOWN IMPRECISIONS, both
  // measured, both on the cheap side of the asymmetry:
  //   - It admits 9 category pages whose title ends in a number
  //     (`cigars-byron-1850`, `cigars-topper-1894`, …). They parse to nothing;
  //     the cost is 9 fetches.
  //   - It drops a product whose code is alphanumeric — one such loc exists
  //     today, a gift certificate. If a CIGAR ever ships an alphanumeric code we
  //     lose it silently, which is why the accepted count belongs in the probe
  //     line: 3,841 against 4,888 one-segment locs is the number to watch.
  nonProductPathPattern: /^\/store(?:\/|$)|^\/(?![^/]*-\d+\/?$)/i,
  // Products are ROOT-LEVEL slugs. Live: no loc on this site has depth 2 or 3,
  // and the only depth-4 family is the registry.
  productPathSegments: { min: 1, max: 1 },
  // No prefix to ask robots about, and products sit at the root, so the gate path
  // is `/` (the default). Stated by omission, as Small Batch does.
  //
  // --- page shape (ADR-006 amendment 2026-09-02, issue #252) -----------------
  // This vendor serves NO `application/ld+json` on any page. Its product facts
  // are OpenGraph (`og:type=product`, `product:price:amount`/`:currency`,
  // `og:availability`, `og:upc`, `og:brand`, `og:image`) over a
  // `schema.org/Product` itemscope whose only itemprop is `name`.
  //
  // `og:description` is a SPEC LINE, not a blurb — `5 X 54 - Sun Grown - Single`,
  // `4 1/2 x 56 - Ecuador Connecticut - Bundle of 10` — and it is where this
  // vendor states the unit. It has to be read, because THIS SHOP PRICES SOME
  // LISTINGS BY THE BOX under a name that says nothing about packaging: the
  // 2026-09-02 probe sampled `Rough Rider Toro Maduro` at $169.99 and `Liga
  // Privada No9 Belicoso` at $452.60, and with packaging null, price-at-a-glance
  // showed a box price as the price of one stick — on a tier-1 LINKOUT vendor,
  // which is where a wrong price is most expensive (ADR-009, #270).
  // `normalizeListing` reads it for OpenGraph vendors only, name first.
  productMarkup: "opengraph",
  // And its product breadcrumb is "Home / <brand>" by design ("ticket 126909:
  // Home and brand URL instead of Breadcrumbs on product pages"), so the category
  // comes from the vendor's own tag list instead. Live: a cigar page's keywords
  // carry a literal `Cigars` token (`30 nick anniversary nicaragua,Cigars,Perdomo
  // 30th Sun Grown`), an accessory's name its own aisle (`,Air Freshening,Air
  // Freshening Accessories`) — so the two patterns below read the tags exactly as
  // they read a breadcrumb path elsewhere, and a page with NO keywords tag yields
  // an empty path and is refused.
  categorySource: "keywords-meta",
  cigarCategoryPattern: /cigar/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
  // Four fetches, kept from 2026-08-29. The variance seen that day (1,462
  // `/store/` locs on one fetch, 6,356 with none on the next) has not reproduced
  // since — `varied=no` on 2026-08-30 and 2026-08-31, and this change's own fetch
  // returned 6,356 distinct locs, in range. #179's bar for reducing `samples` is
  // two clean probes AFTER the vendor is enabled, as its own change; the vendor
  // is not enabled, so this is not that change.
  sitemapSampling: { samples: 4 },
  // The vendor's own `Crawl-delay: 5` for `*`, honored. Our floor is 2.5s and the
  // fetcher clamps UP, never down, so this is the binding number. ADR-006 already
  // rules that robots' rate ask wins; the 2026-09-01 capture is the first time we
  // have actually read one from this vendor.
  minIntervalMs: 5000,
  // Safety cap for the probe/dry-run era, well under the 3,841 the gate accepts —
  // #179 left this open and a seed crawl is unbounded without it (`createFetcher`
  // has no default). Raise it deliberately for a full seed once the vendor parses.
  maxPages: 500,
};

// --- what the live probe settled, and what is left ---------------------------
// The parser blocker is GONE (issue #252): the OG/microdata extractor and the
// keywords category source above read this vendor's pages. The in-cluster probe
// of 2026-09-02 then passed on this build — `product-locs` 3,843, 3 of 3 parsed,
// 3 cigars — and the operator enabled the row; the first fleet drain
// (2026-09-03) walked 45 pages, parsed 40 listings and matched one.
//
// What is left is a SEED, not an enablement: `maxPages: 500` is a probe-era cap
// well under the 3,841 the gate accepts, so a full catalogue pass needs the cap
// raised deliberately and a deadline long enough to finish. See the ADR-006
// amendments of 2026-09-01 (the gate and the live shape) and 2026-09-02
// (OG/microdata as a structured source).
