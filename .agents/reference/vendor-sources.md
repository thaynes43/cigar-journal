# Vendor Sources — Crawl Posture and Catalog Databases

Research summary, 2026-08-26. Caveat: the research pod's egress allowlist
blocked direct fetches of every vendor site, so robots.txt/ToS rows are
inferred from indexed sources and platform defaults — **verify live from the
crawler's own environment before building any adapter.**

## Crawl posture per vendor

| Vendor | Platform | Structured path | Verdict |
|---|---|---|---|
| Fox Cigar | WooCommerce | sitemap + JSON-LD Product | caution — softest target, crawl gently |
| 2 Guys Cigars | WebSell/NitroSell | likely sitemap | caution — niche platform, verify |
| Cigars International | custom (STG) + reCAPTCHA/Cloudflare | sitemap likely | **avoid** — active bot defenses; sister STG sites' ToS explicitly ban scraping |
| Small Batch Cigar | unknown (~20k URLs) | sitemap near-certain | caution — verify platform + ToS live |
| Holt's | Magento-style | sitemap + JSON-LD common | caution→avoid — large retailer, read ToS first |
| Cuban Lou's | WooCommerce | sitemap + JSON-LD | technically soft; **flag: US-embargo exposure** for surfacing Habanos price data — admin decision via the registry toggle, risk noted in PRD |

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
2. **Wikidata** — CC-licensed brand-level skeleton via SPARQL; shallow but
   legitimately free.
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
