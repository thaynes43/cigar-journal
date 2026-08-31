# AGENTS.md

Agent guide for the cigar journal — a launched web application at
cigars.haynesnetwork.com (public journal + cigar catalog + OIDC/local-user
login + MCP server, with agents as the primary journal writers), rebuilt from
the markdown ledger now kept in `archive/`. `CLAUDE.md` symlinks here.

## Backlog

Unimplemented work lives as GitHub issues on this repo, label `backlog`
(area labels: market/mcp/web/inventory/ops). Each issue is written for a
cold-start agent with pointers into `docs/`. Pick up from there; close via
the PR that implements it.

## Ground rules

- Branch per task (`agent/<slug>`), PR for every change, never push `main`.
- Docs first: product and architecture work lands as PRDs/ADRs/flows in
  [`docs/`](docs/README.md) before code. Follow the conventions in
  [`.agents/reference/related-services.md`](.agents/reference/related-services.md)
  unless an ADR decides otherwise.
- Writing style, everywhere (docs, UI, commit messages): concise and
  professional. The UI must be self-explanatory — no helper blurbs describing
  buttons, no filler strings.
- The legacy ledger in [`archive/`](archive/README.md) has been replaced by the
  live site and banners the move, but stays publishable until the owner retires
  it — do not break its build. Its format is specced in
  [`.agents/reference/archive-format.md`](.agents/reference/archive-format.md).
  Do not edit archived reviews except to add new entries.

## Map

- `archive/` — legacy MkDocs journal (still published; imported as seed data).
- `docs/` — PRDs, ADRs, DDD flows.
- `.agents/` — agent rules and reference.
