# PRD-003: Unified catalog, Want, and explicit consumption

- **Status:** draft
- **Date:** 2026-08-28

## Problem

The site has the pieces but not the loop the owner described (2026-08-28):
Catalog and Inventory are separate nav surfaces over the same tiles; seeded
catalog detail pages are near-empty (name + chip + photo) with 1,792 crawled
offers rows shown nowhere; holdings are a documented heuristic rather than
"reviews deduct from inventory"; and there is no way to mark what he *wants*.
His direction: one tool with filters for what he has, doesn't have, and
wants — plus price match and links running both ways between catalog,
inventory, and reviews.

## Vision

One Catalog. Browsing it answers "what do I like, what do I own, what do I
want, what does it cost" in a single surface; a cigar page composes product
facts, market price, the humidor's house data, and the owner's own reviews;
recording a review consumes a stick from the humidor when the user says so;
and every capability works identically for ChatGPT agents through MCP. UX,
flows, and component guidance: [DESIGN-002](../design/002-go-live-experience.md).
Consumption decision: [ADR-008](../adr/008-explicit-consumption.md).

## Requirements

**Unified surface (area: web)**

- R-UNI-1 (must) — One Catalog nav surface with views Brands · All ·
  Ledger. The Ledger view is PRD-002 R-INV-2's table (plus a
  consumed/remaining column). **Supersedes PRD-002 R-INV-1** (separate
  Inventory nav); `/inventory` URLs redirect into the equivalent catalog
  views.
- R-UNI-2 (must) — Ownership facet `All · Have · Want · Don't have` on
  Brands and All: Have = explicit remaining > 0, Want = flagged, Don't
  have = no active holding. Facet, view, query, and sort all live in the
  URL (PRD-002 conventions); the level registry declares which levels
  answer which facets.
- R-UNI-3 (must) — Sorts on All: name, my rating, recently added, price
  (best current per-stick offer; unpriced cigars group after priced ones
  under an explicit break, never interleaved as zero).
- R-UNI-4 (should) — Root shelves above the brand wall (*In your humidor*,
  *Wanted*, *Recently added*): deterministic, truthfully labeled, absent
  when empty, each linking into the faceted All view.

**Want (area: web/mcp)**

- R-WANT-1 (must) — A single per-user want mark on a catalog cigar:
  `wants` (user, cigar unique, optional note, created_at). Independent of
  holdings and smokes — wanting what you own is valid (Discogs mechanic).
- R-WANT-2 (must) — Smoking never clears want. Acquisition *offers* the
  clear — web purchase surfaces and `record_purchase` results carry the
  flag so the clear is one tap / one conversational beat. Never silent.
- R-WANT-3 (must) — Surfaces: detail-page toggle, tile badge, ownership
  facet, shelf; MCP `set_want` plus `wanted` on catalog reads.
- R-WANT-4 (later) — Named lists. Documented migration: `wants` becomes
  the seeded system list; nothing in v1 may preclude it.

**Explicit consumption (area: inventory/mcp — ADR-008 governs)**

- R-CONS-1 (must) — A smoke deducts from holdings only via an explicit
  consumption link captured at save/edit time (web control defaulted on
  when holdings exist; MCP ask-once flow). Omitted = unknown = no
  deduction.
- R-CONS-2 (must) — One-time heuristic backfill for existing smokes,
  provenance-flagged for curation; afterward every remaining count
  (inventory views, `get_my_inventory`, `record_purchase.holdingAfter`)
  reads the explicit count and the heuristic path is deleted.
- R-CONS-3 (must) — Over-consumption is surfaced (Ledger view and humidor
  panel), corrected by append-only purchase rows, never hidden by the
  display floor.
- R-CONS-4 (should) — Optional lot attribution (`purchase_id`) when the
  user picks or states a lot; the substrate for Cuban box codes (R13).

**Cigar detail (area: web)**

- R-DET-1 (must) — Detail page composition per DESIGN-002: hero (photo,
  want toggle, record action) · vitals/blend · price · your humidor ·
  your history · your smokes; every section absent-when-empty. Delivers
  PRD-002 R-CAT-4 and the R-INV-3 record-a-smoke pre-resolution
  (`/smokes/new?cigarId=…`, from-humidor defaulted).

**Price (area: market)**

- R-PRICE-1 (must) — Current offers per vendor on the detail page: vendor,
  per-stick normalization where packaging is known, stock, as-of date on
  every figure, listing link-out, ADR-006 unapproved-source labels.
  Missing data is an explicit state; stale offers stay dated and demote
  visually. What-I-paid (PPS) stays in the humidor panel, never mixed in.
- R-PRICE-2 (must) — Price-at-a-glance on catalog tiles and price sort
  (completes PRD-002 R-CAT-3).
- R-PRICE-3 (must) — Price history per cigar from the offers time series,
  with honest degradation (chart only above the data threshold in
  DESIGN-002).
- R-PRICE-4 (must) — Re-crawl cadence: scheduled offers runs (CronJob,
  `crawl` role, registry-gated per ADR-006) so "current" and the staleness
  window mean something.

**MCP (area: mcp)**

- R-MCP-1 (must) — `browse_catalog`: paged browse with composable filters
  (`q`, `brand`, `type`, `inHumidor`, `wanted`, `smoked`, `inStock`,
  sort) returning tiles with personal overlay and price-at-a-glance.
- R-MCP-2 (must) — `get_offers` per DESIGN-002; `get_cigar` gains only a
  one-line `bestOffer`.
- R-MCP-3 (must) — `set_want`; `save_smoke`/`update_smoke` consumption
  block; holding/wanted overlays on catalog reads under `journal:read`;
  `record_purchase` result carries `wanted`; server instructions updated
  (ask-once consumption, want vocabulary).
- R-MCP-4 (must) — Contract discipline: additive-only, one deploy per
  feature's schema changes, connector-refresh + new-chat procedure noted
  in client-compatibility.md, descriptions within client token bounds.
- R-MCP-5 (later) — Suggestion surfaces: the data surface above is the
  deliverable now; any future match score is threshold-gated and cites
  its basis (DESIGN-002 research rules).

## Non-goals

Named-lists UI (R-WANT-4 later), price alerts/watch flags, a recommendation
engine or match score, community/aggregate ratings (single user — no crowd),
checkout, humidor sensors. PRD-001/002 non-goals stand.

## Dependencies and sequencing

1. Consumption (R-CONS) and Want (R-WANT) are independent substrate — either
   first, both before the facet.
2. Unified surface (R-UNI) needs both for its facet definitions.
3. Detail rebuild (R-DET) needs Want, consumption, and the price reads.
4. Price surfaces (R-PRICE-1..3) need only existing offers data; cadence
   (R-PRICE-4) is parallel ops work.
5. MCP tools land with their features (house rule: contract ships with
   implementation); `browse_catalog` last, over the finished facet
   semantics.

## Decisions for owner sign-off

Collapse-to-one-surface itself; facet labels; ledger as view (not nav);
want-clear-on-purchase as offer (not auto); MCP ask-once consumption beat;
staleness window; UI strings table in DESIGN-002.
