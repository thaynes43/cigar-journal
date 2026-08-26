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
- **Idempotency (every mutation):** `idempotency_keys` (user_id,
  client_request_id UNIQUE, tool, request_fingerprint, smoke_id, result
  JSONB) written in the mutation's transaction. Fingerprint = hash of the
  canonicalized arguments minus envelope fields. Replay (same key + same
  fingerprint) returns the stored result with `replayed: true`; conflicting
  reuse (same key, different fingerprint) fails `idempotency_conflict`.
  Keys owned by the client per intent, retained ≥90 days; timestamps are
  never identity. This makes `update_smoke`'s `progression.append`
  retry-safe — a replayed append is recognized, not re-applied.
- **Timestamps:** `timestamptz` everywhere. `smoked_at` is stored with its
  provenance (`smoked_at`, `smoked_at_source` ∈ user | system-finalized |
  legacy-document | unknown, `smoked_at_precision` ∈ minute | approximate |
  day). Live saves without a stated time get server finalization time,
  `system-finalized` (ADR-002).
- **Concurrency:** `smokes.version` int; `version_conflict` on mismatch.
  Web edits always send expected version; MCP updates send it optionally
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
