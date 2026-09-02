# Vendor Sources — Crawl Posture and Catalog Databases

Research summary, 2026-08-26; vendor rows updated from the in-cluster probes of
2026-08-29, 2 Guys re-read 2026-09-01 (#217) and Small Batch 2026-09-02 (#270).
Caveat: the research pod's egress allowlist blocks direct fetches of
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

**Closed 2026-09-02:** `display_enabled` was written (by the crawler's
`resolveVendor`, by `--import-approved`, by the importer) and read by NOBODY, so
every crawled vendor's prices rendered whatever its tier. Every price surface now
joins `vendors` and requires it (`@cj/domain` `offer-display.ts`, used by
`reads.ts`'s four offer queries and `catalog-browse.ts`'s `OFFER_JOIN`): a tier-2
vendor's offers are recorded, counted as stocking evidence, and invisible.
Chat observations with no vendor (`offers.vendor_id IS NULL`) belong to no tier
and stay visible; admin reads (curation queue, match triage) still see everything.

| Vendor | Tier | Platform | Structured path | Verdict |
|---|---|---|---|---|
| Fox Cigar | 1 | WooCommerce | sitemap + JSON-LD Product | caution — softest target, crawl gently. Owner's linkout NC shop and today the only vendor with an offers walk, so it is the price authority in practice as well as by tier |
| 2 Guys Cigars | 1 | WebSell/NitroSell | sitemap (products are ROOT-LEVEL slugs ending in the NitroSell product code) | live-read 2026-09-01 (#217), the fullest one yet: sitemap = 1 root + 4,888 one-segment slugs + 1,467 `/store/go/registry/<n>/`, nothing else. 3,841 of the slugs end in `-<digits>` (= `og:upc`) and are products; the other 1,047 are landing pages or 404s. Gate is Mode B — 1 segment, minus `/store/` and minus anything without a product code. robots: two `*` groups, `Crawl-delay: 5` (honored via `minIntervalMs`), only `/store/filtered/` disallowed. This vendor serves no `application/ld+json` anywhere — product data lives in OpenGraph (`og:type=product`, `product:price:amount`, `og:availability`, `og:upc`, `og:brand`) plus a bare `itemtype="schema.org/Product"`, and product pages carry no category breadcrumb. **Parser blocker RESOLVED 2026-09-02 (#252)**: the adapter declares `productMarkup: "opengraph"` + `categorySource: "keywords-meta"` (the `<meta name="keywords">` list carries a literal `Cigars` token; a page with no tags is refused), and the live fixtures parse. `crawl_enabled=false` until an in-cluster probe passes the #179 bar on that build (`product-locs` 3,841, `parsed>=2`, `cigars>=1`). Tier 1 is a posture, not a promise the lane runs |
| Cigars International | — | custom (STG) + reCAPTCHA/Cloudflare | sitemap likely | **avoid** — active bot defenses; sister STG sites' ToS explicitly ban scraping |
| Small Batch Cigar | 1 | nopCommerce behind Cloudflare | FLAT sitemap `urlset` + JSON-LD Product | live-probed 2026-09-02 (#270), the second full read of this lane. **Sitemap**: one flat `urlset` of 11,288 locs — no sitemapindex, so no product-only child to sharpen `sitemapUrl` with; identical `changefreq`/`lastmod` throughout. Depth census: 10,956 one-segment root slugs, 331 `/blog/<slug>`, 1 root. No product API (`/products.json` 404s). **Gate**: Mode B, 1 segment, minus the root and six named non-product root slugs (`/contactus`, `/blog`, `/boards`, `/shop-by-brand`, `/accessories`, `/gift-card`) — 10,955 accepted / 333 rejected across all 11,288 locs. ~23% of the accepted set is a brand or line LANDING page (`/caldwell`, `/tatuaje-black-label`), which is unavoidable: they are the same URL shape as a product and are dropped only after the fetch, when the page carries no `Product`. **Taxonomy**: breadcrumbs are `SHOP BY BRAND / <brand> / [<line>]` or a house-line root (`Modern Tobacconist`, `Amendola Signature Series`, `Connecticut Valley Reserve`) and NEVER name a cigars category — `/cigar/i` passed 4 of 20 real cigars, so the category gate is now `/./` and `excludePattern` carries the load (`Accessories` is the only non-cigar bucket). **Blocker is the PRICE**: `offers.price` is `"0.00"` on 20/20 cigar products — nopCommerce grouped products keep the real per-pack figures in HTML `variant-overview` blocks only (single-SKU accessories do carry a real price). `sku`, `availability` and `image` (`images.smallbatchcigar.com`) are trustworthy. robots: one `*` group, ~90 stock disallows, **no Crawl-delay**, none touching a root slug (`minIntervalMs: 3000` is our own politeness). Catalogue depth: Caldwell 89 locs, Tatuaje 120. Runtime: a full seed is ~11k fetches ≈ 9h, over the adapter's `maxPages: 500` — and the fetcher THROWS at the cap, so a seed needs a raised cap plus a deadline that fits it (resume/chunking tracked under #270). `crawl_enabled=false`: offers are not worth writing until an ADR-015 HTML price extractor exists; the enrich drain, which links listings and needs no price, is the near-term use |
| Holt's | — | Magento-style | sitemap + JSON-LD common | caution→avoid — large retailer, read ToS first |
| Cuban Lou's | 2 | WooCommerce | Yoast product-only sitemap (985 locs) + JSON-LD | live-probed 2026-08-29 and ENABLED; **flag: US-embargo exposure** for surfacing Habanos price data — admin decision via the registry toggle, risk noted in PRD. Post-seed audit: most of its catalog is bundle/quantity SKUs the shared `excludeNamePattern` does not cover (#127). Off the r/cubancigars approved list, so tier 2: its offers are recorded and not displayed, and its photos fill only what tier 1 could not |
| r/cubancigars approved stores | 1 (on onboarding) | — | — | The Habanos price authority per ADR-015, `approval_status = 'approved'`. None is adapted or probed yet; the approved-list import mints a registry row at the default tier 2, and promoting one to tier 1 is an admin act after its adapter and in-cluster probe exist |

Cross-cutting: **none is Shopify**, so no `/products.json` anywhere — build
the crawler on sitemap enumeration + structured product markup (JSON-LD where a
vendor serves it, OpenGraph/microdata where it does not — ADR-006 amendment
2026-09-02, declared per adapter), low rate, cached, with an identifying
User-Agent.

## Vendor enablement — the bar `--probe` now holds

`crawl_enabled` is flipped by an operator in the registry after an in-cluster
`--probe`, never by an adapter edit (ADR-006). Since **2026-09-02 (#270)** that
probe's `ok` verdict requires two things beyond robots + enumeration + parses:

- **`cigars >= 1`** among the parsed samples. A vendor whose pages parse and
  whose category patterns match none of them is a vendor that would crawl its
  whole catalogue and write nothing — Small Batch's brand-first taxonomy did
  exactly that against `/cigar/i`.
- **no parsed sample whose price parsed to zero.** A `"0.00"` in a vendor's
  structured markup is a grouped-product placeholder, and `normalizeListing`
  reads it as an UNKNOWN price (never `$0`) for every vendor and every markup
  source. The probe FAILS on it rather than noting it, because the old bar
  green-lit a vendor that would have written ~8,000 priceless offer rows and
  reported a healthy run.

## Terms of service, recorded per vendor

- **Small Batch Cigar** (`/terms-and-conditions`, `/privacy-notice`, read
  2026-09-02): **no** scraping/crawling/robot/automated-access/data-mining
  clause of any kind. One copyright clause bears on us — content may be copied
  "for the sole purpose of placing an order … or for your own non-commercial
  use", and "any other use, including … reproduction, distribution, display …
  is strictly prohibited unless authorized". Recorded, not adjudicated: the
  DISPLAY posture that clause speaks to is the owner's call, the same class of
  decision as every other vendor's, and it is separate from whether we may read
  the pages at all.

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
