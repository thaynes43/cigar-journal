# Cigar Journal

A cigar journal being rebuilt from a static markdown ledger into a web
application: journal entries with tasting notes, a maintained cigar lookup
database, SSO and local-user login, and an MCP server so agents can turn
smoking-session musings into structured entries. Part of the haynesnetwork
family of apps; will live at cigars.haynesnetwork.com.

## Repository

- [`apps/`](apps/) — deployables. `web` is the Next.js site (App Router,
  standalone).
- [`packages/`](packages/) — internal packages exporting raw TS: `config`
  (shared tsconfig/eslint), `domain` (`@cj/domain`), `db` (`@cj/db`).
- [`archive/`](archive/README.md) — the original markdown ledger, still
  published at [hayneslab.net/cigar-journal](https://hayneslab.net/cigar-journal/)
  and slated for import as seed data.
- [`docs/`](docs/README.md) — PRDs, ADRs, and domain flows.
- [`.agents/`](.agents/README.md) — rules and reference for agents working here.

## Status

Phase 1 application complete — domain, Postgres schema, local auth, and the
journal/catalog UI — deploying to cigars.haynesnetwork.com. Next: archive
import and the MCP server.
