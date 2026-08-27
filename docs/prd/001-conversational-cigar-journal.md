# PRD-001: Conversational Cigar Journal

- **Status:** draft
- **Date:** 2026-08-26

## Problem

Tasting notes today are typed into ChatGPT mid-smoke, then manually copied into
a static MkDocs ledger. The ledger can't answer questions ("did I find this
sweeter last time?"), can't distinguish repeat smokes cleanly, and every entry
costs manual formatting work. The conversation and the journal are disconnected.

## Vision

A person casually discusses a cigar with an LLM while smoking it. When they say
they're done, the conversation becomes a durable, structured smoking record with
no journaling mechanics. The website is the durable journal: browse, search,
edit, compare, and analyze smoking history — plus a cigar catalog with market
prices from the shops the owner actually buys from.

## Personas

- **Primary — the smoker:** discusses cigars conversationally with ChatGPT (or
  another LLM client); refuses to interrupt the smoke for data entry.
- **The curator:** the same person later at a desk — fixes catalog data, merges
  duplicates, edits entries, reviews prices.
- **Agents:** LLM clients acting for a user via MCP; the primary journal
  writers.

## Core workflow

1. User mentions a cigar in conversation; the LLM resolves it against the
   catalog (`search_cigars`) and may pull the user's history for context.
2. Ordinary tasting talk stays in the chat — **no backend writes per message**.
   The LLM client owns the conversational context.
3. On "that's it for this one," the LLM synthesizes the whole conversation into
   one `save_smoke` call: progression, construction, context, assessment, and a
   narrative journal entry preserving the user's own language.
4. The backend resolves or creates the catalog cigar, validates, persists the
   Smoke, and returns the canonical record.
5. The website shows the entry immediately; corrections happen on the site or
   via a follow-up conversational edit.

## Functional requirements

R1 (must) — Smokes: each smoking experience is a separate record referencing a
catalog Cigar; repeat smokes never overwrite each other.
R2 (must) — Catalog invariant: a Smoke can never exist without a backing
catalog Cigar. Unknown cigars are created (flagged `unverified`) during save.
R3 (must) — Progression: temporal tasting stages with free-form stage labels,
optional 0–1 position, normalized descriptors, and verbatim user language.
Progression is optional — sparse Smokes (overall descriptors only) are valid,
and timestamps carry provenance (user-stated / system-finalized / legacy).
R4 (must) — Ratings: 100-point scale, optional; never fabricated.
R5 (must) — MCP surface, client-neutral: search/resolve cigars, fetch cigar
detail, query own history, fetch one full smoke, save a finalized smoke,
update a smoke. Every mutation idempotent via the envelope; identical
behavior for ChatGPT, Claude Code, Codex, or any MCP client.
R6 (must) — Identity: local accounts (invite-gated at launch) + Authentik OIDC
sign-in, linked to one user. The app is the OAuth authorization server for MCP
clients; ownership always derives from the authenticated principal.
R7 (must) — Visibility: journals private by default; a per-user flag makes a
journal publicly readable (anonymous read pages).
R8 (must) — Web app: login, smoke list/detail/edit, cigar pages with per-user
history and derived personal profile, search, purchase log.
R9 (must) — Archive import: legacy reviews become Smokes (provenance
`imported`, original markdown preserved verbatim); purchase table imports;
missing data stays null.
R10 (must) — Market: crawl registry vendors to seed and enrich the catalog;
periodic re-crawls record per-vendor offers (price, stock); the site offers
price comparison per cigar. Vendor SKU → catalog matching includes a manual
confirmation queue. The vendor registry is admin-managed (add/remove,
per-vendor crawl and display toggles); the Cuban approved list syncs against
the r/cubancigars online-stores wiki with credit, via admin-reviewed diffs,
and unapproved crawl sources are labeled (ADR-006).
R11 (later) — Aggregated third-party tasting notes/review data from crawled
sites (stored as derived descriptors/statistics, not verbatim copies).
R12 (later) — In-progress durable sessions (draft Smokes) for crash recovery
and read-only-client handoff; see fallback in the MCP contract.
R13 (later) — Inventory (owner, 2026-08-27): per-user holdings built on
Purchases — what's in the humidor now. The owner's spreadsheet ledger
(Purchases tab headers, supplied 2026-08-27: Cigar, Brand, Packaging, QTY,
Vitola, Type, Size, Purchase Date, Humidor Data, Box Date, Retailer, PPS,
Aging) maps 1:1 onto the imported `purchases` schema except **Aging**,
which derives from box/humidor dates rather than being stored. Cuban
entries additionally need box codes and authenticity fields at design time.
Recording a smoke can start from an inventory pick (pre-resolves the cigar,
minimal typing), and inventory views show the user's own ratings to guide
what to grab next. Supersedes the earlier "no stock counting" non-goal.

## Non-functional requirements

- Multi-tenant discipline from day one: every query scoped by owner; authz
  tests cover cross-user access and both visibility states.
- Public-SaaS-grade hygiene at invite scale: rate limiting, no secrets or
  journal prose in logs, stored-XSS-safe rendering of journal text.
- LLM-tolerant API: nullable unknowns, structured recoverable errors,
  idempotent retries. Unknown must be representable; hallucination must not be
  required to satisfy a schema.
- House standards apply (testing, supply chain, deploy) per ADR-001.

## MVP scope

Phases 0–6 of the roadmap (compatibility spike, domain + web CRUD, catalog +
archive import, auth, MCP read + write, market crawl + price compare). Two
tracks: journal core ships first internally; market work never blocks it.
MCP client capability is proven empirically (Phase 0) before integration
investment; the owner uses Claude Code or Codex for full write capability
whenever ChatGPT Web cannot provide it.

## Non-goals

Social features, likes/comments, marketplace/ordering, humidor sensors, stock
counting, recommendation engine, embedded first-party chat UI, mobile app,
event sourcing, message brokers, vector search, global flavor ontology.
Extension points are noted in ADRs where these would attach.

## Success criteria

- A full smoke journaled conversationally through MCP with zero manual
  formatting and at most one clarifying question (cigar ambiguity) — from
  ChatGPT Web when its capabilities allow, otherwise from Claude Code or
  Codex against the identical server.
- Every archive review visible in the new journal with original prose intact.
- "What did I think of this last time?" answered correctly in-conversation.
- A duplicate `save_smoke` retry produces exactly one Smoke.
- Price comparison shows current offers from ≥2 crawled vendors for a cigar.

## Risks

- **Market scope in MVP** (owner's call, 2026-08-26): roughly doubles v1;
  cross-vendor product matching is the hardest data problem in the system.
  Mitigated by track separation and the manual match queue.
- **LLM client capability drift:** connector capabilities (ChatGPT
  especially) are external product surface that changes independently of
  this app; mitigated by the Phase 0 spike, the standards-only server design
  (ADR-005), interim full-capability clients (Claude Code/Codex), and the
  payload fallback. No vendor owns the architecture.
- **Crawl fragility/ToS:** vendor sites change and may prohibit scraping;
  per-vendor adapters kept small; live robots/ToS verification precedes each
  adapter (research summary: `.agents/reference/vendor-sources.md` — Cigars
  International assessed avoid; Cuban Lou's carries a US-embargo exposure
  flag for surfacing Habanos price data, left as an admin registry decision).
- **Verbatim third-party review text** has IP exposure — R11 stores derived
  data only.

## Identity

**Cigar Journal**, part of the haynesnetwork family of apps, at
**cigars.haynesnetwork.com** (owner, 2026-08-26). The OAuth issuer and MCP
endpoint live on that origin.

## Open questions

```yaml
- question: Live robots/ToS verification per vendor (blocked from the dev
    pod's egress) and Cigar API license/coverage check
  whyItMatters: confirms each adapter's legal/etiquette posture and whether
    Cigar API can seed the catalog
  recommendedDefault: verify from the crawler's environment at the start of
    the market phase; research summary in .agents/reference/vendor-sources.md
  decisionNeededBefore: market phase

- question: Real client behavior (writes, refresh, late-conversation tool
    availability) for ChatGPT Web, Claude Code, Codex
  whyItMatters: decides which client delivers full capability first and
    whether the connector needs per-turn referencing
  recommendedDefault: run the Phase 0 spike; fill docs/mcp/client-compatibility.md
  decisionNeededBefore: implementation (Phase 0 is first)
```

## Roadmap

| Phase | Goal | Validation |
|---|---|---|
| 0 | MCP compatibility spike: throwaway authenticated server (one read + one write tool) exercised from ChatGPT Web, Claude Code, Codex | compatibility matrix filled with `verified` rows; OAuth + protocol choices confirmed |
| 1 | Monorepo scaffold, domain + Postgres + migrations, basic web CRUD behind local auth, deployed | create/edit/browse a Smoke on the cluster |
| 2 | Catalog: canonical naming, fuzzy resolution, lazy-create, blend metadata; archive import (reviews, purchases) | ambiguity + no-match flows work; all legacy entries render, spot-checked vs mkdocs |
| 3 | Full identity: Authentik SSO, invites, visibility flag + public pages | second user invited; public journal readable anonymously |
| 4 | MCP read (4 tools) + OAuth AS, linked from a Phase 0-verified client | history questions answered in-conversation |
| 5 | MCP write: `save_smoke` (+ lazy create, idempotency), `update_smoke` | end-to-end smoke journaled conversationally; replay produces no duplicate |
| 6 | Market: crawler seed + offers + price-compare UI (parallel from Phase 2) | prices from ≥2 vendors on cigar pages |
| 7 | Analytics: personal profiles, trends, comparisons; R11 aggregation | profile view over ≥3 smokes of one cigar |
