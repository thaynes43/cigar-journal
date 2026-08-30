# ADR-006: Catalog seeding and the market subsystem

- **Status:** accepted
- **Date:** 2026-08-26

## Context

No clean open cigar dataset exists. Owner decisions (2026-08-26): seed and
enrich the catalog by crawling the vendor sites he buys from; market features
(periodic price/inventory crawls, price comparison, aggregated review data)
are MVP scope; and no Smoke may exist without a backing catalog Cigar, so
conversational lazy-create is mandatory regardless of crawl coverage.

## Decision

- **Catalog sources, in trust order:** curation (admin UI) > crawl ingestion
  > conversational lazy-create. Lazy-created cigars are `unverified` and
  enter the curation queue; verification and duplicate-merge are
  curator-only, and merges re-point Smokes, Purchases, and Listing Matches.
  The queue's trigram candidate generator inevitably surfaces sibling
  products sharing a brand/line prefix, so two guards keep the backlog
  honest: number-distinct pairs (the resolver's number-token guard — "No. 9"
  vs "T52", "1964" vs "1926") are suppressed automatically, and for wordy
  siblings (Natural vs Maduro) a curator records a **dismissal** ("not
  duplicates") — a persisted, id-ordered pair verdict
  (`duplicate_dismissals`) the queue excludes from then on; rows cascade
  away when either cigar is merged or deleted.
- **Vendor registry is admin-managed data, not config** (owner, 2026-08-26):
  admins add, remove, and per-vendor enable crawling and price display from
  the UI. For Cuban vendors the registry tracks an **approved** status
  synced against the r/cubancigars online-stores wiki — credited on the
  site wherever the approved list appears — via an admin-reviewed diff, not
  a blind auto-sync (the wiki is an input; admins decide). Crawl sources
  need not be approved vendors (Cuban Lou's is crawled for inventory depth
  while off the approved list); data from unapproved sources is labeled as
  such wherever shown.
- **Initial vendors** (owner, 2026-08-26): NC — Fox Cigar, 2 Guys Cigars,
  Cigars International, Small Batch Cigar, Holt's. CC — the r/cubancigars
  approved list plus Cuban Lou's (inventory depth, unapproved). Research
  posture per site, the Reddit-API sync method, and catalog-DB candidates
  (Cigar API + Wikidata) are in
  [`.agents/reference/vendor-sources.md`](../../.agents/reference/vendor-sources.md);
  each adapter still requires a live robots/ToS read from the crawler's own
  environment before it is built. Crawlers work from sitemap enumeration +
  JSON-LD Product parsing (no vendor exposes a structured product API).
- **Crawler:** per-vendor adapters (small, disposable) run as CronJobs via
  the image's `crawl` role, only for registry vendors with crawling enabled.
  Crawl #1 is the catalog seed; subsequent runs append `offers` rows
  (price, stock, seenAt) — an append-only time series. Raw payloads land in
  JSONB for reprocessing; adapters are rate-limited and honor robots.txt.
  A third-party catalog database (product data independent of
  price/availability crawling) remains a research item — if a viable one
  exists, it slots into the trust order alongside crawl ingestion.
- **Listing matching:** vendor listing → catalog Cigar via normalized
  canonical name (plus brand/vitola where known) + trigram similarity;
  confident matches auto-link,
  the rest queue for manual confirmation. Match status (`auto`/`confirmed`/
  `unmatched`) is never silently overwritten by later crawls.
- **Price comparison (MVP):** per-cigar current offers across vendors +
  simple price history from `offers`. **Review aggregation (R11, later):**
  derived descriptors/statistics only — no verbatim third-party review text
  stored (IP exposure).
- **Track separation:** Market never blocks the journal core; it reads
  Catalog and proposes enrichment but never writes Smokes.

## Consequences

The catalog reflects what the owner can actually buy, and every journal
entry has real backing data. Costs: per-vendor adapters rot as sites change
(accepted — small and disposable); cross-vendor matching is the hardest data
problem in the system and the manual queue is the safety valve; unverified
LLM-created cigars accumulate until curated.

## Alternatives considered

- Bulk-import a community/review database — licensing murk, huge irrelevant
  tail, still needs lazy-create; rejected by owner in favor of vendor crawl.
- Manual curation only — breaks the frictionless mid-smoke flow.
- Verbatim review aggregation — IP risk without matching product value.

## Amendments

- **2026-08-29 (owner) — vendor expansion + Cuban Lou's posture.** More NC
  vendors join the initial set (2 Guys Cigars, Small Batch Cigar built as
  adapters alongside Fox). **Cuban Lou's: photos + price seeds YES, purchase
  destination NO** — its offers feed price-at-a-glance/history and its images
  feed product photos, but it is never presented as a place to buy. A new
  `vendors.purchase_linkout` flag (migration 0018, default true) carries this:
  `false` drops the listing link-out and renders the row as plain,
  unapproved-labeled text (Cuban Lou's stays `approval_status='unapproved'`).
  The r/cubancigars online-stores wiki remains the approved-list source via an
  admin-reviewed diff of a locally-supplied snapshot (no Reddit API in this
  lane; never the anonymous scrape path), attributed to the wiki. Provenance
  guard hardened: `listing_matches.decided_by` (migration 0017,
  crawler|curator|agent) makes the crawler preserve ANY non-crawler decision on
  re-crawl, not just `confirmed`.
- **2026-08-29 — adapter crawl-shape capabilities + probe verdict rule.** Live
  in-cluster probes turned up two vendor shapes the single `productPathPrefix`
  field could not express, so the adapter contract gains two generic
  capabilities (the core still branches on FIELD SHAPE, never on a vendor slug):
  - **Product gate, two modes.** Mode A is the prefix that already existed (Fox
    `/shop/`, Cuban Lou's `/` over a product-only sitemap). Mode B is an
    exclusion gate — `nonProductPathPattern` plus `productPathSegments` depth
    bounds — for a store whose products are ROOT-LEVEL slugs with no shared
    prefix (Small Batch). The modes are mutually exclusive in the type. The
    coarse path the robots gate is asked about is now its own concern
    (`robotsProbePath`, default `/`), since Mode B has no prefix to reuse.
  - **Sitemap sampling.** `sitemapSampling: { samples, intervalMs? }` unions N
    root fetches for a vendor whose sitemap CONTENT varies per request (2 Guys:
    1,462 `/store/` locs on one fetch, 6,356 locs with none on the next).
    Opt-in, clamped to 8. For a sampling vendor an empty union FAILS the run
    (`SitemapEnumerationEmptyError`) rather than recording a "succeeded, 0
    listings" row that reads as healthy; a non-sampling vendor still
    succeeds-with-zero.
  - **Probe verdict.** `--probe` now samples up to three index children and
    three product URLs, and passes only when robots allows the gate, the
    enumeration yields product URLs, and at least `min(2, sampled)` product
    pages parse. One parse proves the JSON-LD extractor works but not that the
    enumeration selects products; two prove both, and requiring all three would
    re-import the false negative. The fetcher's page cap for a probe is derived
    from those bounds, not fixed.
  - **The two samples pick differently, on purpose.** PRODUCT URLs are picked by
    a midpoint spread that never returns index 0: the observed false negatives
    were both position-0 index/redirect rows, and sitemaps park those at the
    front. A sitemapINDEX's CHILDREN have no such convention and are picked in
    three ranks. First, catalog-shaped names — `product`/`shop`/`store`/`catalog`
    in the child's FILE NAME, minus the Woo taxonomy names (`product_cat`,
    `product_tag`, `product_brand`) that match the same words while enumerating
    term archives, and which would otherwise fill the budget and crowd out the
    one child holding products. That rank is capped at `budget - 2`. Second, the
    FIRST and LAST child, which a midpoint pick cannot reach past 6 and 7
    children. Third, the interior. The cap is what makes the endpoint guarantee
    real: at a budget of three or more both ends are always fetched, so the name
    hint can only add to the positional pick, never displace a child it would
    have found. A bounded probe still cannot cover a large index: it reports the
    index size (for a sampling vendor, the distinct children the root served
    across samples), the children it sampled, and any child that answered
    non-200, so a `needs-attention` says which it was.
