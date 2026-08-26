# AGENTS.md

Agent guide for the cigar journal — a markdown ledger being rebuilt into a web
application (journal + cigar lookup database + OIDC/local-user login + MCP
server, with agents as the primary journal writers). `CLAUDE.md` symlinks here.

## Ground rules

- Branch per task (`agent/<slug>`), PR for every change, never push `main`.
- Docs first: product and architecture work lands as PRDs/ADRs/flows in
  [`docs/`](docs/README.md) before code. Follow the conventions in
  [`.agents/reference/related-services.md`](.agents/reference/related-services.md)
  unless an ADR decides otherwise.
- Writing style, everywhere (docs, UI, commit messages): concise and
  professional. The UI must be self-explanatory — no helper blurbs describing
  buttons, no filler strings.
- The legacy ledger in [`archive/`](archive/README.md) stays publishable until
  the new site replaces it; its format is specced in
  [`.agents/reference/archive-format.md`](.agents/reference/archive-format.md).
  Do not edit archived reviews except to add new entries.

## Map

- `archive/` — legacy MkDocs journal (live site + future seed data).
- `docs/` — PRDs, ADRs, DDD flows.
- `.agents/` — agent rules and reference.
