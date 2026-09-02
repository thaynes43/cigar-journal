# Vendor Sources — Crawl Posture and Catalog Databases

Research summary, 2026-08-26; vendor rows updated from the in-cluster probes of
2026-08-29, 2 Guys re-read 2026-09-01 (#217), Small Batch 2026-09-02 (#270), and
the **fifteen-candidate Habanos sweep of 2026-09-02** (#270, ADR-015) that added
the four picture sources below and rejected the rest. The six-adapter `--probe`
run of **2026-09-02 on the v0.39.0 image** (#270) re-read 2 Guys, EGM,
Cigarworld, Montefortuna and J.J. Fox; its results and the corrections it forced
are in the verdict tails below.
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
| 2 Guys Cigars | 1 | WebSell/NitroSell | sitemap (products are ROOT-LEVEL slugs ending in the NitroSell product code) | live-read 2026-09-01 (#217), the fullest one yet: sitemap = 1 root + 4,888 one-segment slugs + 1,467 `/store/go/registry/<n>/`, nothing else. 3,841 of the slugs end in `-<digits>` (= `og:upc`) and are products; the other 1,047 are landing pages or 404s. Gate is Mode B — 1 segment, minus `/store/` and minus anything without a product code. robots: two `*` groups, `Crawl-delay: 5` (honored via `minIntervalMs`), only `/store/filtered/` disallowed. This vendor serves no `application/ld+json` anywhere — product data lives in OpenGraph (`og:type=product`, `product:price:amount`, `og:availability`, `og:upc`, `og:brand`) plus a bare `itemtype="schema.org/Product"`, and product pages carry no category breadcrumb. **Parser blocker RESOLVED 2026-09-02 (#252)**: the adapter declares `productMarkup: "opengraph"` + `categorySource: "keywords-meta"` (the `<meta name="keywords">` list carries a literal `Cigars` token; a page with no tags is refused), and the live fixtures parse. `crawl_enabled=false` until an in-cluster probe passes the #179 bar on that build (`product-locs` 3,841, `parsed>=2`, `cigars>=1`). Tier 1 is a posture, not a promise the lane runs. **Probed 2026-09-02 on v0.39.0: `ok`** — `product-locs` 3,843, three product pages parsed, two cigars, no placeholder prices. It also exposed an ADR-009 display defect, fixed in the same pass: this shop prices some listings BY THE BOX under a name that states no packaging (`Rough Rider Toro Maduro` $169.99, `Liga Privada No9 Belicoso` $452.60), so price-at-a-glance read a box price as the price of one stick — on a tier-1 LINKOUT vendor. Its `og:description` is a spec line that states the unit (`5 X 54 - Sun Grown - Single`, `4 1/2 x 56 - Ecuador Connecticut - Bundle of 10`), so `normalizeListing` now reads packaging from it when the name is silent, for OpenGraph vendors only and only when the description yields a count |
| Cigars International | — | custom (STG) + reCAPTCHA/Cloudflare | sitemap likely | **avoid** — active bot defenses; sister STG sites' ToS explicitly ban scraping |
| Small Batch Cigar | 1 | nopCommerce behind Cloudflare | FLAT sitemap `urlset` + JSON-LD Product | live-probed 2026-09-02 (#270), the second full read of this lane. **Sitemap**: one flat `urlset` of 11,288 locs — no sitemapindex, so no product-only child to sharpen `sitemapUrl` with; identical `changefreq`/`lastmod` throughout. Depth census: 10,956 one-segment root slugs, 331 `/blog/<slug>`, 1 root. No product API (`/products.json` 404s). **Gate**: Mode B, 1 segment, minus the root and six named non-product root slugs (`/contactus`, `/blog`, `/boards`, `/shop-by-brand`, `/accessories`, `/gift-card`) — 10,955 accepted / 333 rejected across all 11,288 locs. ~23% of the accepted set is a brand or line LANDING page (`/caldwell`, `/tatuaje-black-label`), which is unavoidable: they are the same URL shape as a product and are dropped only after the fetch, when the page carries no `Product`. **Taxonomy**: breadcrumbs are `SHOP BY BRAND / <brand> / [<line>]` or a house-line root (`Modern Tobacconist`, `Amendola Signature Series`, `Connecticut Valley Reserve`) and NEVER name a cigars category — `/cigar/i` passed 4 of 20 real cigars, so the category gate is now `/./` and `excludePattern` carries the load (`Accessories` is the only non-cigar bucket). **Blocker is the PRICE**: `offers.price` is `"0.00"` on 20/20 cigar products — nopCommerce grouped products keep the real per-pack figures in HTML `variant-overview` blocks only (single-SKU accessories do carry a real price). `sku`, `availability` and `image` (`images.smallbatchcigar.com`) are trustworthy. robots: one `*` group, ~90 stock disallows, **no Crawl-delay**, none touching a root slug (`minIntervalMs: 3000` is our own politeness). Catalogue depth: Caldwell 89 locs, Tatuaje 120. Runtime: a full seed is ~11k fetches ≈ 9h, over the adapter's `maxPages: 500` — and the fetcher THROWS at the cap, so a seed needs a raised cap plus a deadline that fits it (resume/chunking tracked under #270). `crawl_enabled=false`: offers are not worth writing until an ADR-015 HTML price extractor exists; the enrich drain, which links listings and needs no price, is the near-term use |
| Holt's | — | Magento-style | sitemap + JSON-LD common | caution→avoid — large retailer, read ToS first |
| Cuban Lou's | 2 | WooCommerce | Yoast product-only sitemap (985 locs) + JSON-LD | live-probed 2026-08-29 and ENABLED; **flag: US-embargo exposure** for surfacing Habanos price data — admin decision via the registry toggle, risk noted in PRD. Post-seed audit: most of its catalog is bundle/quantity SKUs the shared `excludeNamePattern` does not cover (#127). Off the r/cubancigars approved list, so tier 2: its offers are recorded and not displayed, and its photos fill only what tier 1 could not |
| Montefortuna Cigars | 2 | WordPress/WooCommerce | sitemap_index → product-sitemap{,2,3}.xml (2,087 locs) + JSON-LD Product | live-probed 2026-09-02 (#270). **Gate**: prefix `/shop/`, minus `/shop/brands/` and `/shop/page/`. **Markup**: `@graph` with BreadcrumbList + Product carrying `name`, `sku` (`CO-S6`), `brand` (the marca) and one `image`; `og:type` is `article`, so OpenGraph is not an option. `offers` states availability and a URL and **no price** — fine for a picture source. **Category**: `Home / Shop / <marca>` — the word "cigar" appears nowhere, so the gate is `/shop/i` and `excludePattern` carries the load (their aisle is spelled "accesories", one `s`). **Names**: an unusually large multi-pack/condition vocabulary — `2 Boxes of 25 …`, `2 Cabs of …`, `Damaged … Single`, `Vintage …`, `… Sevilla Jar (19)` — hence the extended `excludeNamePattern` and its leading-number guard. **Photos**: `wp-content/uploads`, 677×902 (452×603 on older uploads), taken from the JSON-LD `image` because `og:image` is sometimes the site LOGO. **Asks**: 8/8. **robots**: `*` → `Allow: /`, no Crawl-delay, named AI bots (ClaudeBot/GPTBot/CCBot/…) disallowed — we are none of them — plus `Content-Signal: search=yes,ai-train=no,use=reference` (see Terms below). **ToS** `/terms-and-conditions/`: no scraping/automated-access clause. **Probed 2026-09-02 on v0.39.0 and CORRECTED here — re-probe pending.** Its three sampled names were a `… - Single`, a `… Combo` and a `2 Boxes of 20 …`, and `excludeNamePattern` refused all three: at this shop **"Single" means ONE STICK** (`Quintero Favoritos - Single`, under a `Home / Shop / Quintero Favoritos – Single` trail the gate admits), which is the unit the catalog models, so `\bsingles?\b` came off the pattern — `\bdamaged\b` already refuses the `Damaged Cohiba Siglo VI Single` it was written for. The combo and the leading-number guard are confirmed correct. The same run reported `product-locs=1001`, which is `product-sitemap.xml` alone: the probe's 3-child budget spent one slot on the catalog while this shop splits 2,087 products across three children, so `MAX_PROBE_CHILDREN` is now 5 |
| EGM Cigars | 3 | **Shopify** | sitemap index → sitemap_products_{1,2}.xml (1,072 locs) + JSON-LD **ProductGroup** | live-probed 2026-09-02 (#270), and the first Shopify vendor in the fleet. **Gate**: prefix `/products/`; the four localized copies (`/en-gb/products/…`) fall outside it, so the catalogue is crawled once. **Markup**: Organization + `@type: ProductGroup` with `name`, `brand` ("Habanos sa"), `category` and `hasVariant` — no `image` and no `offers` on the group, so the extractor accepts ProductGroup as a Product and lifts the first variant's offers (#270). **Category**: `"category": "Cigars"` and nothing else — no breadcrumb node — hence `categorySource: "json-ld-category"`. **Price**: its meta key is `og:price:amount`, not `product:price:amount`, and is not read; the variant offer is. **Photos**: `cdn/shop/…`, **2000×2000 and 2200×2200** — the largest in the fleet — from `og:image:secure_url` (the plain `og:image` beside it is the same asset over http). **Asks**: 8/8. **robots**: `*` → `Allow: /`, stock Shopify disallows, no Crawl-delay; its header asks agents to use UCP/MCP for cart and checkout and forbids automated payment — we never transact. **ToS** Shopify `/policies/terms-of-service`: no scraping/automated-access clause. **Probed 2026-09-02 on v0.39.0: `ok`** — `product-locs` 998 against the 1,071 the index holds, and the 73 missing are exactly `sitemap_products_2.xml`, a product child the probe's 3-child budget never fetched; the bump to `MAX_PROBE_CHILDREN = 5` is the fix, and this vendor's real gate count needs the re-probe to confirm |
| Cigarworld.de | 4 | bespoke PHP (Arnold André) | sitemap.xml index → sitemap_de.xml (21,818 locs; 6,874 under `/zigarren/`, 6,604 through the gate) + JSON-LD Product | live-probed 2026-09-02 (#270); the deepest catalogue of the four. **Gate**: prefix `/zigarren/` — a `startsWith`, which is what keeps `/zigarrenzubehoer/` out — minus `/zigarren/{sampler,marken,brands}`. **Markup**: WebPage + Product + BreadcrumbList, with `sku`, `mpn`, `brand`, `category: "Zigarren"` and **real EUR prices**, the only one of the four that publishes them. **Category**: `Shop / Zigarren / Kuba / Regulares / <marke> / …`; the exclusions are German (`zubehör/zubehoer`, `aschenbecher`, `feuerzeug`, `etui`, `pfeife`) and `excludeNamePattern` adds `etuis?`/`sortiment`. **Photos**: the JSON-LD `image` is a **300×51 thumbnail**; `/bilder/detail/big/…` (what `og:image` names) is 744×128 and the studio strips run to 3386×556 — derivable, so the adapter rewrites the fetch URL rather than re-sourcing it. **Asks**: 8/8. **robots**: one `*` group, nothing touching `/zigarren/`, **no Crawl-delay**; CCBot and BLEXBot named and disallowed, we are neither. **ToS** `/service/agb`: a "Verbot gewerblicher Weiterverkäufe" — see Terms below. **Probed 2026-09-02 on v0.39.0: `ok`** — 6,874 locs under `/zigarren/`, of which the gate accepts **6,604** after the `sampler|marken` subtraction, and the `/bilder/detail/big/` photo rewrite is confirmed working on every sample |
| J.J. Fox | 5 | Magento 2 | flat sitemap urlset (1,502 locs, 913 root-level `.html`) + **OpenGraph/microdata** | live-probed 2026-09-02 (#270); 2 Guys' page shape on a Magento store, so it needed no new extractor. **Gate**: Mode B — one path segment, minus the root, the nine category roots and their subtrees, four named landing pages and `*.php`. **Markup**: **zero** `application/ld+json` blocks; `og:type=product`, `og:title`, `og:image`, `product:price:amount`/`:currency` over a bare `schema.org/Product` itemscope. **No `og:upc`, no `og:brand`, no `og:availability`** → no sku, no brand, unknown stock. Magento escapes every space in an og:* value as a HEX character reference (`Partagas&#x20;Shorts`), which `decodeEntities` learned to read. **Category**: `<meta name="keywords">` = `"Cuban Cigar, Cigar, Habanos, <marca>"`; category pages carry no keywords, no og:type and no itemscope, so they parse to nothing. **Photos**: `media/catalog/product/…?width=265&…` — a 265×265 resize; the bare path serves 600×562, so the adapter strips the query (which also lifts it out of the robots' `Disallow: /*?`). **Price caveat**: an out-of-stock line serves `product:price:amount = "0"`, which normalize reads as unknown and the probe FAILS the vendor on — expect that on its live probe. **Asks**: 8/8. **ToS** `/terms-conditions/`: no scraping/automated-access clause. **Probed 2026-09-02 on v0.39.0: a FALSE `ok`, CORRECTED here — re-probe pending.** All three samples were admitted as cigars and none is one: `Integra Boost 69% - 8g Pack` (keywords `integra boost / cigar humidity / cigar humidification / humidity levels`) and `EMS Humidified Resealable Cigar Pouch` (`ems / humidified / cigar / pouch`) are humidification accessories whose keywords contain no "humidor" while every one carries the `cigar` token the category gate reads — so `excludePattern` now matches the stem **`humid`**, which a real listing's `Cuban Cigar, Cigar, Habanos, <marca>` never contains. `Habanos Seleccion Robusto Gift Box` (£347, a mixed selection under a real cigar's keywords) is refused by adding `\bgift box(?:es)?\b` to `excludeNamePattern`; `selecci[oó]n` was deliberately NOT added, since it would take `Selección Reserva`. Also seen and left alone: `/19-st-james-street` (the one product-shaped loc with no `.html`) is admitted by the gate and parses to nothing — one wasted fetch, and safer than a fifth literal in the pattern |
| r/cubancigars approved stores | 1 (on onboarding) | — | — | The Habanos price authority per ADR-015, `approval_status = 'approved'`. None is adapted or probed yet; the approved-list import mints a registry row at the default tier 2, and promoting one to tier 1 is an admin act after its adapter and in-cluster probe exist |

Cross-cutting: build the crawler on sitemap enumeration + structured product
markup (JSON-LD where a vendor serves it, OpenGraph/microdata where it does not —
ADR-006 amendment 2026-09-02, declared per adapter), low rate, cached, with an
identifying User-Agent. EGM Cigars is the first Shopify storefront in the fleet
and does answer `/products.json`; we still read its pages, because the contract
is the markup every reader gets and not a platform-specific API.

## Rejected Habanos candidates (in-cluster sweep, 2026-09-02)

Recorded so nobody re-probes them blind. Each was fetched from the cluster —
robots, home, sitemap, four product pages against the eight queued Cuban asks,
photo bytes and terms.

- **TopCubans** (topcubans.com) — 7,466 locs across six language subtrees, and
  **no product markup**: zero `ld+json`, `og:type=website` on a product page, no
  price meta of any kind. Its soft-404s answer **200** carrying the same
  `schema.org/Product` itemscope and the same keyword-stuffed `keywords` list
  (which names "cigars" on every page, 404s included), so nothing separates a
  product from a dead slug. No usable category, no price, no reliable product
  signal.
- **Cigar Terminal** (cigarterminal.com) — parses cleanly and is the closest
  call of the seven: JSON-LD Product, real USD prices, 1,913 product-shaped locs.
  Rejected on the two things it is wanted for. Its **BreadcrumbList is a single
  crumb — the product's own name** — so the category gate would be reading the
  product title, and its **photos are letterboxed strips**: 500×156 at the
  JSON-LD cache path, 265×265 at the `og:image` one, 928×194 at the largest
  measured. Reconsider only alongside a category source it does not have today.
- **Noblego** (noblego.de) — JSON-LD Product with `sku`, `brand`, real EUR prices
  and 650×650 photos (1181×1181 at the uncached path), and it fails anyway:
  **no category source is reachable**. There is no BreadcrumbList node (the trail
  is HTML only), no `og:*` at all, and `<meta name="keywords">` repeats the
  PRODUCT NAME ("Cohiba Siglo VI A/T") or is empty. Its products are also
  root-level slugs indistinguishable in shape from its brand and category pages.
- **C.Gars Ltd / Turmeaus** (cgarsltd.co.uk, turmeaus.co.uk) — **Cloudflare
  managed challenge**: robots.txt, the home page and the sitemap all answer 403
  with an interstitial. Turmeaus' own robots points at cgarsltd's sitemap, which
  403s too.
- **Havana House UK** (havanahouse.co.uk) — same Cloudflare 403 on robots, home
  and sitemap.
- **Havana House Canada** (havanahouse.ca) and **Pacific Cigar Co.**
  (pcc.com.hk) — no response at all from the cluster; every fetch failed.
- **cigare.com** — a parked domain ("Premium Domain Name For Sale"); robots and
  sitemap both 404.

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

- **Montefortuna Cigars** (`/terms-and-conditions/`, robots.txt, read
  2026-09-02): no scraping/crawling/automated-access clause in the terms. Its
  robots.txt carries `Content-Signal: search=yes,ai-train=no,use=reference`,
  which the file itself declares an **express reservation of rights under Art. 4
  of EU Directive 2019/790**. Read as written: `use=reference` covers a catalog
  and photo crawl shown with attribution and a link back, which is what this
  lane does; `ai-train=no` forbids training or fine-tuning a model on the
  content, which nothing here does. Recorded as a stated reservation so the
  reading is on the record and can be revisited.

- **Cigarworld.de** (`/service/agb`, read 2026-09-02): a **"Verbot gewerblicher
  Weiterverkäufe"** — "der gewerbliche Weiterverkauf unserer Produkte ist
  untersagt". A ban on commercially reselling its GOODS, not on reading or
  reusing its data; nothing in the AGB mentions scraping, crawling, robots,
  automated access or data mining. Recorded, not adjudicated.

- **EGM Cigars** (Shopify `/policies/terms-of-service`) and **J.J. Fox**
  (`/terms-conditions/`), read 2026-09-02: no scraping, crawling, robot,
  automated-access or data-mining clause of any kind. EGM's robots.txt asks
  agents to transact only through its UCP/MCP endpoint and forbids automated
  checkout and payment; we never transact.

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
