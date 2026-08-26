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
R4 (must) — Ratings: 100-point scale, optional; never fabricated.
R5 (must) — MCP surface: search/resolve cigars, fetch cigar detail, query own
smoking history, save a finalized smoke, update a smoke. Idempotent writes.
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
R10 (must) — Market: crawl the owner's vendor sites to seed and enrich the
catalog; periodic re-crawls record per-vendor offers (price, stock); the site
offers price comparison per cigar. Vendor SKU → catalog matching includes a
manual confirmation queue.
R11 (later) — Aggregated third-party tasting notes/review data from crawled
sites (stored as derived descriptors/statistics, not verbatim copies).
R12 (later) — In-progress durable sessions (draft Smokes) for crash recovery
and read-only-client handoff; see fallback in the MCP contract.

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

Phases 1–6 of the roadmap (ADR-listed stack, domain + web CRUD, archive
import, auth, MCP read + write, market crawl + price compare). Two tracks:
journal core ships first internally; market work never blocks it.

## Non-goals

Social features, likes/comments, marketplace/ordering, humidor sensors, stock
counting, recommendation engine, embedded first-party chat UI, mobile app,
event sourcing, message brokers, vector search, global flavor ontology.
Extension points are noted in ADRs where these would attach.

## Success criteria

- A full smoke journaled from ChatGPT Web with zero manual formatting and at
  most one clarifying question (cigar ambiguity).
- Every archive review visible in the new journal with original prose intact.
- "What did I think of this last time?" answered correctly in-conversation.
- A duplicate `save_smoke` retry produces exactly one Smoke.
- Price comparison shows current offers from ≥2 crawled vendors for a cigar.

## Risks

- **Market scope in MVP** (owner's call, 2026-08-26): roughly doubles v1;
  cross-vendor product matching is the hardest data problem in the system.
  Mitigated by track separation and the manual match queue.
- **ChatGPT platform drift:** connector/Developer Mode capabilities are
  external and plan-dependent; mitigated by the read-only fallback flow and
  standards-only server design (ADR-005).
- **Crawl fragility/ToS:** vendor sites change and may prohibit scraping;
  per-vendor adapters kept small; ToS review is part of source research.
  Gray-market CC vendors are a sensitivity to assess there.
- **Verbatim third-party review text** has IP exposure — R11 stores derived
  data only.

## Open questions

```yaml
- question: Product name and subdomain
  whyItMatters: binds branding, OAuth issuer, MCP connector URL
  recommendedDefault: cigars.haynesnetwork.com
  decisionNeededBefore: implementation

- question: Which vendor sites to crawl first (CI, Fox, 2 Guys, Mr. Cigar, ...)
  whyItMatters: coverage, adapter effort, ToS posture per site
  recommendedDefault: research pass proposes a shortlist with ToS assessment
  decisionNeededBefore: market phase

- question: ChatGPT plan capabilities at integration time
  whyItMatters: write-tool availability and confirmation UX vary by plan
  recommendedDefault: assume Developer Mode with write tools; verify in Phase 4
  decisionNeededBefore: MCP write phase
```

## Roadmap

| Phase | Goal | Validation |
|---|---|---|
| 1 | Monorepo scaffold, domain + Postgres + migrations, basic authed web CRUD, deployed | create/edit/browse a Smoke on the cluster |
| 2 | Archive import (reviews, purchases) | all legacy entries render; spot-check vs mkdocs |
| 3 | Full identity: Authentik SSO, invites, visibility flag + public pages | second user invited; public journal readable anonymously |
| 4 | MCP read + OAuth AS, ChatGPT connector linked | history questions answered in ChatGPT |
| 5 | MCP write: `save_smoke` (+ lazy create, idempotency), `update_smoke` | end-to-end smoke journaled from ChatGPT |
| 6 | Market: crawler seed + offers + price-compare UI (parallel from Phase 3) | prices from ≥2 vendors on cigar pages |
| 7 | Analytics: personal profiles, trends, comparisons; R11 aggregation | profile view over ≥3 smokes of one cigar |
