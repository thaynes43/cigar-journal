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
- **Crawler:** per-vendor adapters (small, disposable) run as CronJobs via
  the image's `crawl` role. Crawl #1 is the catalog seed; subsequent runs
  append `offers` rows (price, stock, seenAt) — an append-only time series.
  Raw payloads land in JSONB for reprocessing; adapters are rate-limited and
  honor robots.txt. Vendor shortlist + ToS review is a research deliverable
  before the market phase (PRD open question), with gray-market CC vendors
  assessed separately.
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
