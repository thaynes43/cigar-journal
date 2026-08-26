# ADR-003: Postgres persistence and retrieval

- **Status:** accepted
- **Date:** 2026-08-26

## Context

Postgres 16 on CloudNativePG is fixed infrastructure. The contested choices
are shape (normalized vs JSONB), search strategy, idempotency storage, and
whether history questions need vector search.

## Decision

- **Drizzle ORM**, one schema file per table; numbered raw-SQL migrations run
  by an advisory-locked init container (house pattern). Postgres owns UUIDs
  (`gen_random_uuid()`; Better Auth `generateId: false`).
- **Normalized core:** `users`, `identities` (Better Auth tables), `cigars`,
  `smokes`, `smoke_progression` (one row per Progression Entry, `descriptors
  text[]` GIN-indexed, verbatim text alongside), `purchases`, `vendors`,
  `offers` (append-only), `listing_matches`, `audit_log`. JSONB only for
  `smokes.context` and crawler raw payloads — optional, shapeless data no
  query filters on. Progression is relational because analytics filter on it
  ("cigars I called bready").
- **Retrieval = Postgres, no vectors:** `pg_trgm` for fuzzy cigar resolution
  (misspellings like "Alma Fuego"); FTS (`tsvector` over narrative +
  verbatim observations) plus descriptor-array and structured filters for
  history questions. Every history query in the PRD resolves to SQL over
  these. Revisit vectors only if synonym-style semantic queries ("bready" ≈
  "toasty") demonstrably fail — record that as a new ADR with the failing
  queries.
- **Idempotency:** `idempotency_keys` (user_id, client_request_id UNIQUE,
  smoke_id, response_hash) written in the save transaction; a replay returns
  the stored Smoke with `replayed: true`. Keys owned by the client per save
  intent; timestamps are never identity.
- **Timestamps:** `timestamptz` everywhere; `smoked_at` stores the user's
  stated time with offset, nullable for imports; `smoked_date` (date) kept
  for imports that only know a day.
- **Concurrency:** `smokes.version` int; web edits send expected version
  (`stale_version` on mismatch); MCP field-scoped patches skip the check
  (ADR-002 rationale). All mutations audit in-transaction.

## Consequences

Everything is queryable/joinable with ordinary SQL and indexes; the importer
writes plain rows. Cost: descriptor vocabulary lives in arrays, so synonym
normalization is a curation-time UPDATE, and FTS quality depends on
descriptor discipline in the MCP contract.

## Alternatives considered

- Smoke-as-JSONB-document — simple writes, but cripples descriptor/analytics
  queries and invites schema drift from LLM payloads.
- Vector/pgvector now — no failing requirement; complexity before need.
- Event sourcing — audit rows already preserve history; no replay consumer.
