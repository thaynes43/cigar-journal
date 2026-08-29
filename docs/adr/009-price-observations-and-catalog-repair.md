# ADR-009: Price observations extend offers; chat repairs the catalog it finds

- **Status:** accepted
- **Date:** 2026-08-29

## Context

The owner requires price data that is timestamped and source-attributed,
collected from multiple sources on the same day and again later — price
comparison AND price history — with background crawlers doing the brunt and
conversational agents conforming to the same model when they find prices
while filling catalog gaps. A connector-relayed feature request (2026-08-28)
asks for an enrichment path for EXISTING sparse cigars (add_cigar covers only
missing ones), per-stick price normalization, non-registry price sources, and
enrichment/pricing hints on get_cigar. The `offers` table (ADR-006) is
already an append-only, timestamped, vendor-attributed price series — the
requested "priceObservations" store exists; it is incomplete, not absent.

## Decision

- **`offers` IS the price-observation store.** No parallel table. It gains
  (migration): `packaging` (text: single/5-pack/box/…), `sticks_per_package`
  (int), `price_per_stick_cents` (int, computed when derivable — stored, not
  a view, so sorting and history read cheap), `price_type`
  (`retail` | `msrp` | `sale`, default retail), `source_name` + `source_url`
  (text, for observations whose source is not a registry vendor), and
  `vendor_id` becomes nullable. Every observation carries `seen_at` + a
  source: a registry vendor OR a named ad-hoc source — never neither. The
  registry stays admin-curated (ADR-006); ad-hoc sources do not mint vendor
  rows.
- **Append-only with a dedupe window:** an observation identical to the
  latest one for the same (cigar, source, packaging) — same price, currency,
  availability — within 24h is skipped, not inserted. Price changes always
  insert. History is never rewritten.
- **`request_cigar_enrichment` MCP tool:** operates on an existing cigarId
  only; reuses the `enrichment_requests` queue and its dedupe (pending/
  fulfilled gating, from the gap-fill flow); response reports
  `queued | already_queued | recently_enriched | not_needed`, the missing
  fields, and verification state. It never creates cigars and never touches
  the journal.
- **`update_cigar` MCP tool (fill-nulls-only):** conversational repair of
  factual catalog fields — a field is writable only while it is null;
  non-null and curator-verified values are never overwritten by chat
  (trust order, ADR-006). Audited per field. Verification remains
  curator-only (#45).
- **`record_price` MCP tool:** chat submits a price observation in the
  offers model (source name/url required when no vendor matches, observedAt
  defaulting to now, packaging/sticksPerPackage when stated; per-stick
  computed). Same dedupe window as the crawler. Crawler adapters adopt the
  new columns (packaging parse where the listing exposes it).
- **`get_cigar` gains additive hints:** an `enrichment` block (recommended,
  missingFields, verification) and a compact `pricing` summary (lowest
  current per-stick or price, currency, observedAt, sourceCount,
  observationCount, refreshRecommended by staleness window). Full history
  stays out of get_cigar; a `get_cigar_prices` query tool is future work the
  storage now supports.

## Consequences

- One price model for crawler, chat, and future alerts/charts; per-stick
  economics become first-class; DESIGN-002's price-honesty rules gain the
  columns they assumed.
- Nullable `vendor_id` weakens one FK guarantee in exchange for honest
  ad-hoc sourcing; the source-presence rule is enforced in the domain
  (CHECK constraint: vendor_id or source_name).
- Chat can now repair the catalog it reads — bounded by fill-nulls-only, so
  curation keeps authority over corrections and verification.

## Alternatives considered

- New `price_observations` table — duplicates offers' semantics; every
  reader would need to union two stores.
- JSONB price history on cigars — unbounded row growth, unqueryable
  history; rejected by the request itself.
- Chat-writable corrections of non-null fields — collides with curation
  authority; deferred until provenance/confidence modeling exists.
- Auto-minting registry vendors from chat sources — erodes the
  admin-curated registry (ADR-006).
