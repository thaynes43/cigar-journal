# PRD-002: Catalog and Inventory browse — the poster library

- **Status:** draft
- **Date:** 2026-08-28

## Problem

The catalog page is an alphabetical grid of ~100 rows, mostly cigars created as
a side effect of journaling, and the site has no Inventory surface at all —
the owner's intent was lost between issues. His direction (2026-08-28): a
massive crawled catalog organized the way a cigar store is — by brand — and
navigated the way the haynesnetwork media library is: poster-centric, sliceable,
sortable, filterable. From that catalog, a distinct Inventory view of what he
actually owns, when it was acquired, and how it is aging.

## Vision

Browsing cigars should feel like browsing the haynesnetwork TV library. The
owner's mapping, verbatim intent:

| haynesnetwork | catalog | example |
|---|---|---|
| Series | Brand | Arturo Fuente — or Opus X, however the data lands |
| Season | Line | OpusX Lost City, with its own picture |
| Episode | Cigar at the vitola | Lost City Robusto, with a product photo |
| Collections | Curated shelves | later phase |

Every slice has a poster. Navigation descends the hierarchy; sort and filter
work at every level; the whole thing is loaded with data about what cigars
exist (crawl-seeded, ADR-006) and what they cost (offers → price watch).
Inventory pulls from the same catalog but answers a different question — what
is in the humidor, since when — per PRD-001 R13's ledger mapping.

## Requirements

**Catalog — the library (area: web/market)**

- R-CAT-1 — Library root: poster grid of brands, with sliceable shelf rows
  (NC / CC, country, recently added). A brand tile shows its poster (curated or
  crawler-captured; falls back to the BandTile treatment) and stick count.
- R-CAT-2 — Brand page: a hero (brand poster, stick/line counts), then the
  brand's lines as collapsible poster sections — the haynesnetwork season
  pattern: a 2:3 line poster on the section summary, vitola rows lazy-loaded
  on expand. Where a brand has no line data the level collapses honestly —
  no fabricated tiers (house rule: facts are never invented to satisfy
  taxonomy).
- R-CAT-3 — Vitola-level cigars are "episodes": 16:9 still tiles (the
  haynesnetwork episode-still shape — right for a horizontal stick photo),
  each with its ADR-007 ProductPhoto, dimensions, and price-at-a-glance from
  latest offers. Brand and line tiles are 2:3 posters.
- R-CAT-4 — Cigar detail keeps today's page (vitals, personal profile,
  offers slot) and gains the photo + price history.
- R-CAT-5 — Search, sort, filter at every level. Filters: type, country,
  strength, ring gauge, length, price range, verified, in-my-humidor,
  smoked-by-me. Sorts: name, price, my rating, recently added. State lives in
  the URL (shareable, back-button safe).
- R-CAT-6 — Scale: the browse must handle a crawler-seeded catalog of
  thousands (server pagination/infinite scroll; today's 100-row cap dies).
- R-CAT-7 — Price watch: per-cigar current offers across vendors + history
  (`offers` time series, ADR-006); a watch flag per user with alerts as a
  later phase.
- R-CAT-8 — Poster tiers extend ADR-007's product binding upward: brand and
  line imagery rows alongside the per-vitola ProductPhoto. Rights posture per
  vendor applies before public display; BandTile remains the no-photo
  fallback at every tier.

**Inventory (area: inventory)**

- R-INV-1 — An Inventory surface in the primary nav, distinct from the
  catalog: current holdings per PRD-001 R13 (purchases ledger; Aging derived
  from box/humidor dates; seed CSV `archive/ledger/purchases-2026-08-27.csv`).
- R-INV-2 — Two views of the same holdings: a poster grid (catalog-consistent,
  tiles badged with quantity and aging) and a data-dense table with the
  ledger's columns (Packaging, QTY, Vitola, Size, Purchase Date, Humidor
  Date, Box Date, Retailer, PPS, Aging), sortable per column. Default view:
  owner decision, below.
- R-INV-3 — Inventory rows link both ways: into the catalog cigar (facts,
  offers) and into record-a-smoke (inventory pick pre-resolves the cigar, R13).
- R-INV-4 — Own ratings surface on inventory tiles/rows — "what to grab next."

**Cross-cutting**

- R-X-1 — Mobile-first: poster grids at 2–3 columns, shelf rows swipe with
  scroll-snap, filters collapse into a sheet, the inventory table degrades to
  cards or horizontal scroll — no pinch-zooming.
- R-X-2 — MCP parity for ChatGPT: catalog browse/search already exists
  (search_cigars, get_cigar); add paged catalog browse, offers/price lookup,
  and inventory tools (get_my_inventory, record_purchase, adjust_holding) to
  the tool contract as the surfaces land. Contract changes follow docs/mcp
  conventions.

## Design conventions ported from haynesnetwork

Surveyed 2026-08-28 (paths in the haynesnetwork repo); adopt unless a design
doc decides otherwise:

- **Level registry** — a per-level declaration of exactly which sorts and
  facets each browse level answers (`lib/library-view-registry.ts`), so brand
  pages don't offer vitola-only filters and vice versa.
- **URL-state browsing** — every filter/sort/view lives in URL params;
  precedence: explicit URL > stored per-user preference > default. Filter
  edits `router.replace` (shareable), level/view switches `push`
  (`library-client.tsx`).
- **Poster tile discipline** — fixed aspect-ratio boxes (2:3 poster, 16:9
  still) that reserve space before load: lazy `<img>`, fade-in on load, and a
  designed fallback (our BandTile) instead of a broken image
  (`components/cards/media-poster.tsx`). One-line ellipsized title, optional
  one-line subtitle, one badge row capped at three.
- **Scale mechanics** — infinite scroll via IntersectionObserver sentinel with
  a manual load-more fallback, skeleton grid on first load, in-place dimming
  on refetch, and an A–Z letter jump rail once a grid exceeds ~48 items.
- **Grid responsiveness** — `auto-fill minmax(~132px, 1fr)` grids, fixed 3-up
  at ≤480px; toolbars are single fixed-height rows that pan horizontally.
- **Image proxy caching** — the authed poster proxy serves with ETag/304 and
  `private, max-age, stale-while-revalidate` (`app/api/posters/[id]/route.ts`);
  the ADR-007 photo route adopts the same headers.

## Non-goals (this PRD)

Checkout or any storefront function; social features; collections and price
alerts (later phases); review aggregation (R11 constraints apply).

## Phasing

1. **Inventory MVP** — purchases import from the seed CSV, holdings view
   (both views), nav entry, get_my_inventory MCP tool. No crawler dependency.
2. **Library IA** — brand/line/cigar poster navigation, URL-state search/
   sort/filter, pagination over the existing catalog + photo substrate.
3. **Mass catalog + price watch** — crawler seed (#43, ADR-006), offers
   surfaces, watch flag; posters at scale via store-at-crawl.
4. **Collections, price alerts, Cuban authenticity fields** (specced with
   owner at design time, R13).

## Open decisions

- Inventory default view: poster grid (consistent, mobile-strong) vs table
  (ledger-dense). Recommendation: poster grid default with a persistent
  table toggle; the table is the desktop management view.
- Brand-tier grouping when a line outgrows its brand (Opus X under Arturo
  Fuente): default to the `brand` column, curators re-tier via the curation
  queue (#45) — "however the data lands," per the owner.
