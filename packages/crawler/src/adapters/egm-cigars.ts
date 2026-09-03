import type { PrefixVendorAdapter } from "./types.js";

// EGM Cigars (egmcigars.com) — Balerna, Switzerland; a Shopify storefront, and
// the FIRST Shopify vendor in the fleet (vendor-sources.md's "none is Shopify"
// line is now out of date). The second of the four Habanos picture sources
// (ADR-006 amendment 2026-09-02, ADR-015, issue #270). Live-read in-cluster
// 2026-09-02; nothing below is inferred from the platform.
//
//   country     Switzerland; own Dominican production (EGM lines) alongside a
//               full Habanos catalogue, so `focus: "both"`.
//   platform    Shopify (Cloudflare in front). `/products.json` answers 200 —
//               the first vendor where it does — but we do not use it: the
//               contract is sitemap enumeration + structured product markup
//               (ADR-006), and the same facts are on the page.
//   robots      `User-agent: *` → `Allow: /`, with the stock Shopify
//               cart/checkout/account/services/sort-filter disallows and no
//               Crawl-delay. Its header asks agents to use the UCP/MCP endpoint
//               for CART AND CHECKOUT and forbids automated payment — we never
//               transact, so nothing there bears on a read of the product pages.
//               `www.` redirects to the apex, which is what `url` names.
//   sitemap     `sitemap.xml` is a sitemapindex of 21 children: the catalog is
//               `sitemap_products_1.xml` (999 locs) + `sitemap_products_2.xml`
//               (73) = 1,072 products, and the other 18 are pages/collections/
//               blogs plus a `sitemap_agentic_discovery.xml` and four localized
//               copies (`/en-cn/`, `/en-gb/`, `/en-ch/`, …). The locale copies
//               enumerate `/<locale>/products/<slug>`, which the prefix below
//               rejects — one catalogue crawled once.
//   product URL `/products/<slug>`.
//   markup      TWO JSON-LD blocks: an `Organization` and a **`ProductGroup`**
//               (Shopify's shape for a product with variants) carrying `name`,
//               `brand` ("Habanos sa"/"Habanos SA"), `category` and
//               `hasVariant`. The group states no `image` and no `offers` of its
//               own — the extractor lifts the first variant's offers onto it
//               (jsonld.ts), and the photo comes from OpenGraph. `og:type` is
//               `product` and there is no `schema.org/Product` itemscope.
//   category    `"category": "Cigars"` on the Product node, and NOTHING ELSE:
//               its visible breadcrumb is `Home / <product>`, which states no
//               taxonomy at all. Hence `categorySource: "json-ld-category"`.
//   price       its price key is **`og:price:amount`** (106.94 CHF on the Siglo
//               VI), not the `product:price:amount` the OpenGraph extractor
//               reads — so no price reaches an offer from the meta tags, only
//               whatever the lifted variant offer carries. Left as it is on
//               purpose: prices are not the point of a tier-3 source, and its
//               offers would not be displayed if they were perfect.
//   asks        8/8 of the queued Cuban asks are covered.
//   photo       `egmcigars.com/cdn/shop/{files,products}/….jpg`, measured
//               2000x2000 and 2200x2200 (the older `products/` uploads are
//               1128x878) — the largest of the four sources by a wide margin.
//               `og:image` is served over plain `http://` and
//               `og:image:secure_url` is the https spelling of the same asset,
//               which the reader prefers.
//   terms       Shopify's `/policies/terms-of-service` (read 2026-09-02): no
//               scraping, crawling, robot, automated-access or data-mining
//               clause of any kind.
export const egmCigars: PrefixVendorAdapter = {
  slug: "egm-cigars",
  name: "EGM Cigars",
  url: "https://egmcigars.com",
  sitemapUrl: "https://egmcigars.com/sitemap.xml",
  kind: "vendor",
  focus: "both",
  // Live in the registry since 2026-09-02 (#270) — probed in-cluster, and the
  // 2026-09-03 fleet drain matched an ask and wrote its photo. The constant
  // FOLLOWS the row; see `adapters/index.ts` for why that is the direction.
  crawlEnabled: true,
  approvalStatus: "unapproved",
  // Tier 3 (ADR-015): the biggest pictures in the fleet, behind Montefortuna
  // only because its catalogue is a third of the size and its Habanos brand
  // string is the distributor ("Habanos sa") rather than the marca.
  tier: 3,
  purchaseLinkout: false,
  // Every product is `/products/<slug>`; a locale copy is `/en-gb/products/…`
  // and does not start with the prefix, so no exclusion pattern is needed.
  productPathPrefix: "/products/",
  productMarkup: "json-ld",
  // The Product node's own `category` string. The page carries no BreadcrumbList
  // node at all, so `breadcrumbs` would yield an empty path and every listing
  // would be refused.
  categorySource: "json-ld-category",
  cigarCategoryPattern: /cigar/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
  excludeNamePattern: /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b/i,
  // The ProductGroup names no image, so the JSON-LD default would capture
  // nothing. `og:image:secure_url` is the 2000x2000 asset.
  photoSource: "og:image",
  // 4s between requests; the robots.txt asks for no Crawl-delay, so this is our
  // own politeness above the 2.5s floor.
  minIntervalMs: 4000,
  // Probe-era safety cap, above the 1,072 products the gate accepts but below a
  // run that would also walk the locale copies if the prefix ever widened.
  maxPages: 500,
};

// --- what the in-cluster probe must confirm before `crawlEnabled` flips -------
//   1. robots still allows `/products/` for our UA.
//   2. `kind=sitemapindex` with a descended `sitemap_products_*.xml` child and
//      `product-locs` near 1,072 — and the locale children on the REJECTED side
//      of the path census, which is how the one-catalogue claim is checked.
//   3. `parsed>=2` and `cigars>=1` with `category=Cigars`, i.e. the ProductGroup
//      support and the `json-ld-category` source both working end to end.
//   4. `photo=` naming an `https://egmcigars.com/cdn/shop/...` URL (the secure
//      spelling, not the `http://` one).
//   5. `placeholder-prices=0`. A Shopify variant offer normally carries a real
//      price; a `0.00` here would mean the lifted offer is a parent placeholder
//      like Small Batch's (#270) and the offers walk must stay off.
