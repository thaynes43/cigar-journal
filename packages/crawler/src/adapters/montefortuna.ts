import type { PrefixVendorAdapter } from "./types.js";

// Montefortuna Cigars (montefortunacigars.com) — Geneva/Madrid, WooCommerce.
// The FIRST of the four Habanos picture sources (ADR-006 amendment 2026-09-02,
// ADR-015, issue #270) and the highest-tier of them, so it is the first the
// enrich drain falls back to once the tier-1 lanes have looked and missed.
// Every value below is from the in-cluster probe of 2026-09-02; the dev pod
// cannot reach this domain, so nothing here is inferred from the platform.
//
//   country     Switzerland/Spain, ships worldwide. CC and NC side by side —
//               Cuban marcas plus Davidoff, Joya de Nicaragua, Arturo Fuente —
//               hence `focus: "both"`, which contributes no market evidence.
//   platform    WordPress/WooCommerce (Elementor theme).
//   robots      `User-agent: *` → `Allow: /`, plus a second `*` group disallowing
//               only the wp-admin/wp-includes/plugins/themes/cgi-bin family. The
//               Cloudflare managed block names Amazonbot, Applebot-Extended,
//               Bytespider, CCBot, ClaudeBot, CloudflareBrowserRenderingCrawler,
//               Google-Extended, GPTBot and meta-externalagent, none of which we
//               are. It also carries
//               `Content-Signal: search=yes,ai-train=no,use=reference` — an
//               express Art. 4 DSM reservation. A catalog + photo crawl shown
//               with attribution is `use=reference`, which it permits; nothing
//               here trains or fine-tunes a model, which is what it forbids.
//               No Crawl-delay: `minIntervalMs` below is our own politeness.
//   sitemap     `sitemap_index.xml`, 10 children. The catalog is
//               `product-sitemap.xml` + `product-sitemap2.xml` +
//               `product-sitemap3.xml` = 1,001 + 1,000 + 86 = 2,087 locs; the
//               rest are post/page/category/post_tag/product_brand/product_cat/
//               product_tag term archives.
//   product URL `/shop/<slug>/`, one flat level. The `/shop/` root itself is in
//               the sitemap and parses to nothing.
//   markup      JSON-LD `@graph` with WebPage/ImageObject/BreadcrumbList/WebSite/
//               Organization/Product. The Product carries `name`, `sku`
//               ("CO-S6", "HM-EN2R12-BOX"), `brand` (the marca) and one `image`.
//               Its `offers` carries `availability` and a `url` and NO PRICE —
//               fine for a tier-2 source, whose offers are recorded and never
//               displayed (ADR-015). `og:type` is `article`, so the OpenGraph
//               extractor is not an option here even as a fallback.
//   category    the BreadcrumbList: `Home / Shop / <marca> / <product>`. Nothing
//               in it says "cigar" — see `cigarCategoryPattern` below.
//   asks        8/8 of the queued Cuban asks are covered, most of them several
//               times over (Trinidad Reyes 9 hits, H. Upmann Magnum 54 8).
//   photo       `www.montefortunacigars.com/wp-content/uploads/...jpg`, measured
//               677x902 on the pages sampled (452x603 on some older uploads).
//               Taken from the JSON-LD `image`, NOT `og:image`: on
//               `/shop/partagas-shorts-single/` the og image is
//               `Montefortuna-Logo-Facebook.png`, the site logo. So `photoSource`
//               stays at its "json-ld" default, deliberately and not by omission.
//   terms       `/terms-and-conditions/` (read 2026-09-02): no scraping, crawling,
//               robot, automated-access or data-mining clause of any kind.
export const montefortuna: PrefixVendorAdapter = {
  slug: "montefortuna",
  name: "Montefortuna Cigars",
  url: "https://www.montefortunacigars.com",
  sitemapUrl: "https://www.montefortunacigars.com/sitemap_index.xml",
  kind: "vendor",
  // Cuban and non-Cuban in one catalogue, so this shop's listings assert nothing
  // about a cigar's market — the same reading Cuban Lou's got on 2026-08-31.
  focus: "both",
  // Live in the registry since 2026-09-02 (#270) — probed in-cluster, then a
  // 45-look drain that matched 30 and wrote 30 photos. The constant FOLLOWS the
  // row; see `adapters/index.ts` for why that is the direction.
  crawlEnabled: true,
  // Not on the r/cubancigars approved list, so its Habanos rows are labeled and
  // it is never offered as a place to buy.
  approvalStatus: "unapproved",
  // Tier 2 (ADR-015): the best of the four picture sources — a real catalogue
  // with sku, marca and a clean studio shot — but off the approved list, so its
  // offers are RECORDED and not shown, and its photos fill only the slots tier 1
  // could not.
  tier: 2,
  purchaseLinkout: false,
  productPathPrefix: "/shop/",
  // The two non-product families under the prefix, both anchored and both ending
  // at a full segment boundary: `/shop/brands/…` term archives and `/shop/page/2/`
  // pagination. `/shop/` itself is admitted and simply parses to nothing.
  nonProductPathPattern: /^\/shop\/(?:brands|page)(?:\/|$)/i,
  productMarkup: "json-ld",
  categorySource: "breadcrumbs",
  // THE TRAIL NEVER SAYS "CIGAR". It is `Home / Shop / <marca>`, and after
  // normalize drops the product crumb that is exactly what the gate reads — so
  // `/cigar/i` would pass nothing, the Small Batch failure of 2026-09-02 (#270)
  // repeated. `/shop/i` is the taxonomy's own cigar marker here, and
  // `excludePattern` carries the load, which it can: the accessory aisle is a
  // sibling crumb under the same `Shop` root.
  cigarCategoryPattern: /shop/i,
  // Their aisle is spelled "accesories" (one `s`) in the product_cat sitemap, so
  // the pattern accepts one or two — a shop's typo is not a reason to admit an
  // ashtray. `games?` is theirs too (a small novelty aisle).
  excludePattern: /acce[s]{1,2}or|ashtray|lighter|cutter|humidor|sampler?|games?/i,
  // The house set plus this catalogue's own multi-pack and condition vocabulary,
  // which is unusually large: `2 Boxes of 25 Montecristo No. 4`, `2 Cabs of 25
  // Hoyo de Monterrey Epicure No. 2`, `Trinidad Double Pack`, `Damaged Cohiba
  // Siglo VI Single`, `Vintage Partagas Shorts`, `… Sevilla Jar (19)`. The
  // leading-number guard is the general form of the first two: a listing whose
  // NAME starts with a count is a multi-box lot, never one catalog cigar; the
  // 2026-09-02 probe sampled `2 Boxes of 20 …` and a `… Combo` and both are
  // refused by it and by `combos?`.
  //
  // `\bsingles?\b` WAS an alternative here and is deliberately gone (probe
  // 2026-09-02, #270). At this shop "Single" means ONE STICK — the probe's
  // `Quintero Favoritos - Single`, under a `Home / Shop / Quintero Favoritos –
  // Single` trail the gate admits — which is exactly the unit the catalog models,
  // so the alternative was refusing this vendor's most catalogable listings. It
  // was written for `Damaged Cohiba Siglo VI Single`, and `\bdamaged\b` already
  // refuses that one on its own.
  excludeNamePattern:
    /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b|\bdamaged\b|\bvintage\b|\bdouble pack\b|\btriple pack\b|\bfivers?\b|\bjars?\b|\bcabs?\b|^\s*\d+\s/i,
  // 4s between requests. The robots.txt asks for no Crawl-delay, so this is our
  // own politeness above the 2.5s fetcher floor — a 2,087-product catalogue at a
  // shop we have no relationship with.
  minIntervalMs: 4000,
  // Probe-era safety cap, well under the 2,087 the gate accepts. The fetcher
  // THROWS at the cap, so a full seed needs a deliberately raised cap and a
  // deadline that fits it.
  maxPages: 500,
};

// --- what the in-cluster probe must confirm before `crawlEnabled` flips -------
// `crawlEnabled` is an operator's registry decision after a passing `--probe`,
// never an adapter edit (ADR-006). On this build the probe must show:
//   1. robots still allows `/shop/` for our UA (the Cloudflare managed block is
//      updated by Cloudflare, not by the shop — re-read it, do not assume).
//   2. `kind=sitemapindex`, and the three `product-sitemap*.xml` children
//      descended — `product-locs` should land near 2,087. The 2026-09-02 run
//      reported 1,001, which is `product-sitemap.xml` alone: the probe's child
//      budget was 3 and spent one slot on the catalog, so the other two children
//      were never fetched. Raised to 5 (probe.ts), which fits all three.
//   3. `parsed>=2` and `cigars>=1` with `category=Home / Shop / <marca>`, i.e.
//      the `/shop/i` gate reading the trail and not the product name.
//   4. `photo=` naming a `wp-content/uploads` URL rather than the site logo.
//   5. `placeholder-prices=0` — these pages publish no price at all, which is an
//      unknown price and not a placeholder; a `0.00` appearing here would mean
//      the shop changed its markup and the offer write must be re-examined.
