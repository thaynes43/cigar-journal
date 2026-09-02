# Vendor Sources — Crawl Posture and Catalog Databases

Research summary, 2026-08-26; vendor rows updated from the in-cluster probes of
2026-08-29. Caveat: the research pod's egress allowlist blocks direct fetches of
every vendor site, so anything not marked "live-probed" is inferred from indexed
sources and platform defaults — **verify live from the crawler's own environment
before building or enabling any adapter.**

## Crawl posture per vendor

**Tier** is `vendors.tier` (ADR-015, migration 0034; 1 is the highest authority).
It orders three things and nothing else: whose offers are **displayed** (tier 1
only — every crawled vendor's prices are still *recorded*, so a promotion is a
flag flip rather than a re-crawl), whom the enrich drain asks **first** (a lower
tier takes an ask only once every covering higher-tier vendor has looked and
missed), and who may **replace** the one catalogue-photo slot. Catalog structure
has no tier: any enabled vendor feeds brands, lines and leaves. The column is
admin data — an adapter only seeds a NEW row, and a disagreement is reported by
the run, never written over it.

**Open, as of 2026-09-02:** `display_enabled` is written (by the crawler's
`resolveVendor`, by `--import-approved`, by the importer) and read by NOBODY. The
offers read paths — `reads.ts` `latestSeries` and `catalog-browse.ts`'s
`OFFER_JOIN` — gate on `listing_matches.status IN ('auto','confirmed')` alone, so
every crawled vendor's prices render today whatever its tier. Seeding the column
from the tier is therefore only half of "displayed from tier 1"; wiring the two
read paths to it is the other half and is not in this change.

| Vendor | Tier | Platform | Structured path | Verdict |
|---|---|---|---|---|
| Fox Cigar | 1 | WooCommerce | sitemap + JSON-LD Product | caution — softest target, crawl gently. Owner's linkout NC shop and today the only vendor with an offers walk, so it is the price authority in practice as well as by tier |
| 2 Guys Cigars | 1 | WebSell/NitroSell | sitemap (products are ROOT-LEVEL slugs ending in the NitroSell product code) | live-read 2026-09-01 (#217), the fullest one yet: sitemap = 1 root + 4,888 one-segment slugs + 1,467 `/store/go/registry/<n>/`, nothing else. 3,841 of the slugs end in `-<digits>` (= `og:upc`) and are products; the other 1,047 are landing pages or 404s. Gate is Mode B — 1 segment, minus `/store/` and minus anything without a product code. robots: two `*` groups, `Crawl-delay: 5` (honored via `minIntervalMs`), only `/store/filtered/` disallowed. **Blocker is now the PARSER, not the gate: this vendor serves no `application/ld+json` anywhere** — product data lives in OpenGraph (`og:type=product`, `product:price:amount`, `og:upc`, `og:brand`) plus a bare `itemtype="schema.org/Product"`, and product pages carry no category breadcrumb. `crawl_enabled=false` until an OG/microdata extractor exists and an ADR rules it acceptable. Tier 1 is a posture, not a promise the lane runs |
| Cigars International | — | custom (STG) + reCAPTCHA/Cloudflare | sitemap likely | **avoid** — active bot defenses; sister STG sites' ToS explicitly ban scraping |
| Small Batch Cigar | 1 | unknown (~20k URLs) | sitemapindex | live-probed 2026-08-29: products are ROOT-LEVEL slugs with no shared prefix — adapter uses the exclusion gate (negative path pattern + 1-segment depth bound), written against an UNCONFIRMED platform; `crawl_enabled=false` until a re-probe confirms the pattern (a product-only child sitemap, if one exists, would be sharper) |
| Holt's | — | Magento-style | sitemap + JSON-LD common | caution→avoid — large retailer, read ToS first |
| Cuban Lou's | 2 | WooCommerce | Yoast product-only sitemap (985 locs) + JSON-LD | live-probed 2026-08-29 and ENABLED; **flag: US-embargo exposure** for surfacing Habanos price data — admin decision via the registry toggle, risk noted in PRD. Post-seed audit: most of its catalog is bundle/quantity SKUs the shared `excludeNamePattern` does not cover (#127). Off the r/cubancigars approved list, so tier 2: its offers are recorded and not displayed, and its photos fill only what tier 1 could not |
| r/cubancigars approved stores | 1 (on onboarding) | — | — | The Habanos price authority per ADR-015, `approval_status = 'approved'`. None is adapted or probed yet; the approved-list import mints a registry row at the default tier 2, and promoting one to tier 1 is an admin act after its adapter and in-cluster probe exist |

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
