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
  products sharing a brand/line prefix (Liga Privada No. 9 vs T52), so a
  curator can also record a **dismissal** ("not duplicates") — a persisted,
  id-ordered pair verdict (`duplicate_dismissals`) the queue excludes from
  then on; rows cascade away when either cigar is merged or deleted.
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
