# Cigar Journal

A cigar journal and catalog web application, live at
[cigars.haynesnetwork.com](https://cigars.haynesnetwork.com): tasting-note
journal entries, a unified cigar catalog with a humidor overlay, want and
favorite marks, market prices, and an MCP server so agents can turn
smoking-session conversation into structured entries. Part of the haynesnetwork
family of apps.

## What it does

- **Journal** — tasting entries written by agents (over MCP) or the web form,
  newest-first; each smoke links to its cigar. The owner's journal reads
  anonymously at `/journal`, and each public smoke has its own shareable
  detail page. Private journals stay invisible, with no existence leak.
- **Catalog** — one signed-in surface. It groups and drills by brand, line,
  blend and vitola, with an ownership facet (Have · Want · Don't have), a type
  facet, sorts, and search — all held in the URL, so any view is shareable and
  Back-safe. Brand links are backfilled; line and blend are being populated
  through curation, and the catalog says `Unfiled` rather than guessing.
- **Cigar detail** — photo, vitals and blend, market prices, the humidor
  panel, and personal history, each section absent when it has no data.
- **Humidor** — purchase lots, explicit consumption, and remaining counts,
  folded into the catalog as the Ledger view.
- **Prices** — per-vendor offers carrying the date each was seen, with a
  per-stick history. Stale figures keep their date; nothing is dressed as live.
- **Auth** — local login (registration is invite-only) and Authentik OIDC SSO.
- **MCP server** — a conversational journal and catalog surface, plus an
  admin-only curation surface, over the same domain. The tool contract and its
  count live in [`docs/mcp/tool-contract.md`](docs/mcp/tool-contract.md).

## Repository

- [`apps/`](apps/) — `web`, the Next.js site (App Router, standalone).
- [`packages/`](packages/) — internal packages exporting raw TS: `domain`
  (business logic), `db` (schema and migrations), `auth`, `oauth`, `mcp`,
  `photos`, `crawler` (catalog and price ingestion), `importer` (archive
  import), and `config` (shared tsconfig/eslint). One image ships many roles
  (`web`, `mcp`, `migrate`, `import`, `crawl`, `token` — ADR-001), so the MCP
  server deploys from `packages/mcp` rather than from `apps/`.
- [`archive/`](archive/README.md) — the original markdown ledger, imported as
  seed data and kept published at
  [hayneslab.net/cigar-journal](https://hayneslab.net/cigar-journal/) as the
  original record. Every page banners the move to the new site.
- [`docs/`](docs/README.md) — PRDs, ADRs, design docs, and domain flows.
- [`.agents/`](.agents/README.md) — rules and reference for agents working here.
