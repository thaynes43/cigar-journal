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
| 2 Guys Cigars | WebSell/NitroSell | sitemap | live-probed 2026-08-29 and 2026-08-30: robots/ToS fine both times. The 2026-08-29 content variance (1,462 `/store/` locs on one fetch, 6,356 with none on the next) did NOT reproduce — 4 samples, identical 6,356 locs, `varied=no`; the 4-sample union stays until two clean probes post-enablement. The real blocker was the GATE: `/store/` also matches `/store/go/registry/<n>/` gift-registry pages, so all three product picks parsed nothing and the probe read as "no JSON-LD". Gate narrowed to `/store/` minus `/store/go/`; still `crawl_enabled=false` pending a re-probe that parses a real product page |
| Cigars International | custom (STG) + reCAPTCHA/Cloudflare | sitemap likely | **avoid** — active bot defenses; sister STG sites' ToS explicitly ban scraping |
| Small Batch Cigar | unknown (~20k URLs) | sitemapindex | live-probed 2026-08-29: products are ROOT-LEVEL slugs with no shared prefix — adapter uses the exclusion gate (negative path pattern + 1-segment depth bound), written against an UNCONFIRMED platform; `crawl_enabled=false` until a re-probe confirms the pattern (a product-only child sitemap, if one exists, would be sharper) |
| Holt's | Magento-style | sitemap + JSON-LD common | caution→avoid — large retailer, read ToS first |
| Cuban Lou's | WooCommerce | Yoast product-only sitemap (985 locs) + JSON-LD | live-probed 2026-08-29 and ENABLED; **flag: US-embargo exposure** for surfacing Habanos price data — admin decision via the registry toggle, risk noted in PRD. Post-seed audit: most of its catalog is bundle/quantity SKUs the shared `excludeNamePattern` does not cover (#127) |

Cross-cutting: **none is Shopify**, so no `/products.json` anywhere — build
the crawler on sitemap enumeration + JSON-LD Product parsing, low rate,
cached, with an identifying User-Agent.

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
