# Cigar Journal

A cigar journal and catalog web application: tasting-note journal entries, a
unified cigar catalog with a humidor (inventory) overlay, want and favorite
marks, market prices, anonymous-readable public journal pages, and an MCP
server so agents can turn smoking-session conversation into structured entries.
Part of the haynesnetwork family of apps; lives at cigars.haynesnetwork.com.

## What it does

- **Journal** — tasting entries written by agents (over MCP) or the web form,
  newest-first with infinite scroll; each smoke links to its cigar.
- **Catalog** — one surface, three views (Brands · All · Ledger) with an
  ownership facet (Have · Want · Don't have) and a type facet, all held in the
  URL. A cigar detail page composes photo, vitals and blend, market prices, the
  humidor panel, and personal history.
- **Inventory** — purchase lots, explicit consumption, and remaining counts,
  folded into the catalog as the Ledger view.
- **Want and favorites** — independent per-cigar marks.
- **Prices** — per-vendor offers with as-of dates and a per-stick history.
- **Public pages** — a public journal reads anonymously at `/journal`; each
  public smoke has a stripped detail view.
- **Auth** — OIDC SSO and local-user login.
- **MCP server** — 17 tools over the same domain, so an agent can search,
  browse, price, record smokes with consumption, and manage inventory.

## Repository

- [`apps/`](apps/) — deployables. `web` is the Next.js site (App Router,
  standalone).
- [`packages/`](packages/) — internal packages exporting raw TS: `domain`
  (business logic), `db` (schema and migrations), `auth`, `oauth`, `mcp`,
  `photos`, `crawler` (catalog and price ingestion), `importer` (archive
  import), and `config` (shared tsconfig/eslint).
- [`archive/`](archive/README.md) — the original markdown ledger, imported as
  seed data and still published at
  [hayneslab.net/cigar-journal](https://hayneslab.net/cigar-journal/) until the
  new site replaces it.
- [`docs/`](docs/README.md) — PRDs, ADRs, design docs, and domain flows.
- [`.agents/`](.agents/README.md) — rules and reference for agents working here.

## Status

Go-live: the application is complete and deploying to
cigars.haynesnetwork.com — journal, unified catalog with the humidor overlay,
want and favorites, prices, public journal pages, and the 17-tool MCP server,
seeded from the imported archive.
