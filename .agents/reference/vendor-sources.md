# Vendor Sources — Crawl Posture and Catalog Databases

Research summary, 2026-08-26; vendor rows updated from the in-cluster probes of
2026-08-29. Caveat: the research pod's egress allowlist blocks direct fetches of
every vendor site, so anything not marked "live-probed" is inferred from indexed
sources and platform defaults — **verify live from the crawler's own environment
before building or enabling any adapter.**

## Crawl posture per vendor

| Vendor | Platform | Structured path | Verdict |
|---|---|---|---|
| Fox Cigar | WooCommerce | sitemap + JSON-LD Product | caution — softest target, crawl gently |
| 2 Guys Cigars | WebSell/NitroSell | sitemap (products are ROOT-LEVEL slugs ending in the NitroSell product code) | live-read 2026-09-01 (#217), the fullest one yet: sitemap = 1 root + 4,888 one-segment slugs + 1,467 `/store/go/registry/<n>/`, nothing else. 3,841 of the slugs end in `-<digits>` (= `og:upc`) and are products; the other 1,047 are landing pages or 404s. Gate is Mode B — 1 segment, minus `/store/` and minus anything without a product code. robots: two `*` groups, `Crawl-delay: 5` (honored via `minIntervalMs`), only `/store/filtered/` disallowed. This vendor serves no `application/ld+json` anywhere — product data lives in OpenGraph (`og:type=product`, `product:price:amount`, `og:availability`, `og:upc`, `og:brand`) plus a bare `itemtype="schema.org/Product"`, and product pages carry no category breadcrumb. **Parser blocker RESOLVED 2026-09-02 (#252)**: the adapter declares `productMarkup: "opengraph"` + `categorySource: "keywords-meta"` (the `<meta name="keywords">` list carries a literal `Cigars` token; a page with no tags is refused), and the live fixtures parse. `crawl_enabled=false` until an in-cluster probe passes the #179 bar on that build (`product-locs` 3,841, `parsed>=2`, `cigars>=1`) |
| Cigars International | custom (STG) + reCAPTCHA/Cloudflare | sitemap likely | **avoid** — active bot defenses; sister STG sites' ToS explicitly ban scraping |
| Small Batch Cigar | unknown (~20k URLs) | sitemapindex | live-probed 2026-08-29: products are ROOT-LEVEL slugs with no shared prefix — adapter uses the exclusion gate (negative path pattern + 1-segment depth bound), written against an UNCONFIRMED platform; `crawl_enabled=false` until a re-probe confirms the pattern (a product-only child sitemap, if one exists, would be sharper) |
| Holt's | Magento-style | sitemap + JSON-LD common | caution→avoid — large retailer, read ToS first |
| Cuban Lou's | WooCommerce | Yoast product-only sitemap (985 locs) + JSON-LD | live-probed 2026-08-29 and ENABLED; **flag: US-embargo exposure** for surfacing Habanos price data — admin decision via the registry toggle, risk noted in PRD. Post-seed audit: most of its catalog is bundle/quantity SKUs the shared `excludeNamePattern` does not cover (#127) |

Cross-cutting: **none is Shopify**, so no `/products.json` anywhere — build
the crawler on sitemap enumeration + structured product markup (JSON-LD where a
vendor serves it, OpenGraph/microdata where it does not — ADR-006 amendment
2026-09-02, declared per adapter), low rate, cached, with an identifying
User-Agent.

## r/cubancigars online-stores wiki

Use the **official Reddit Data API** (OAuth, registered app — approval
required under the Responsible Builder Policy; 100 QPM limit is far above
our admin-triggered cadence). Never the anonymous `.json` scrape path, never
bulk republication: the wiki is a pointer list our admin re-verifies, shown
with attribution and a link back to r/cubancigars.

## Catalog database candidates (data, not prices)

1. **Cigar API** (cigarapi.com / RapidAPI) — clean brands+cigars JSON, free
   tier. The seed candidate, pending license + coverage/freshness check.
2. **Wikidata** — CC-licensed brand-level skeleton; shallow but legitimately
   free. **IN USE for brand imagery only** (issue #127, ADR-006 amendment
   2026-08-29): the official Action API, not SPARQL —
   `www.wikidata.org/w/api.php` (`wbsearchentities`, `wbgetentities`) plus
   `commons.wikimedia.org/w/api.php` (`imageinfo`), with the bytes coming from
   `upload.wikimedia.org`. Those three hostnames must be on the crawl pod's
   egress allowlist; `query.wikidata.org` is deliberately NOT requested. Runs
   as `crawl --brand-images` under the identifying crawler UA, attributed
   wherever shown. No catalog *facts* are taken from Wikidata — imagery only.
3. **Elite Cigar Library** — 56k+ cigars, no API yet ("under
   consideration") — watch, or email them.
4. Not viable for bulk: Cigar Aficionado, halfwheel (copyright — link out
   instead), Cigar Sense (proprietary), CigarGeeks (no API), Kaggle (none).

## Bottom line

Seed structure from Cigar API (pending license check) + Wikidata brand
skeleton; prices from the WooCommerce indies first after a live ToS read;
skip CI; Holt's only after its ToS; Cuban Lou's is an admin/registry
decision with the embargo flag attached; Reddit wiki via the official API,
admin-triggered, attributed.
