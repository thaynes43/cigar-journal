# ADR-002: Smoke is the aggregate; the journal entry is a view of it

- **Status:** accepted
- **Date:** 2026-08-26

## Context

The legacy ledger models "review pages" per cigar, appending numbered reviews —
repeat experiences share one document and analytics are impossible. The
product's unit of value is one experience of one cigar at one time.

## Decision

**Smoke** is the central aggregate (owner, one Cigar reference, smokedAt,
Progression Entries, Construction, Context, Assessment, Journal Entry,
provenance). The prose journal entry is a component of Smoke, not an entity.
Details in [`docs/ddd/contexts-and-aggregates.md`](../ddd/contexts-and-aggregates.md).

Supporting decisions:

- **Catalog invariant (owner, 2026-08-26):** a Smoke never exists without a
  backing catalog Cigar; unknown cigars are created `unverified` inside the
  save transaction.
- **Progression is optional.** When present: entries with free-form stage
  labels plus optional numeric position (0–1) — not hard-coded thirds.
  "Creamy, bready, excellent draw, really liked it" is a valid Smoke with
  empty progression. Minimum validity: a cigar reference plus at least one
  substantive field (progression, overall descriptors, narrative, or
  impression). Nothing is synthesized to fill the gaps.
- **Overall descriptors** capture whole-smoke impressions independent of
  stages; **`liked`** (boolean, nullable) records coarse sentiment when no
  number was given.
- **Smoked-at is provenance-aware** (`value`/`source`/`precision`): stated
  by the user → `user`; unstated on a live save → server stamps finalization
  time as `system-finalized` (system observation, not hallucination);
  imports → `legacy-document` or `unknown`.
- **Vocabulary:** normalized kebab-case Descriptors for search/analytics,
  always stored alongside verbatim text. No enum, no ontology; synonym
  mapping is a later curation feature over observed tags.
- **Rating:** 0–100 (archive-compatible, industry convention), nullable.
  Unknown stays null everywhere — schemas must never force invention.
- **Personal Profile** (per user per cigar) is computed on read from Smokes;
  nothing materialized until query cost proves otherwise.
- **Editing:** explicit field-scoped change operations (never generic
  patch); audit row in the same transaction (house pattern). Every mutation
  is idempotent via the envelope in ADR-003. Version check: mandatory on web
  forms; optional `expectedVersion` on MCP updates — checked when supplied,
  otherwise last-write-wins on the targeted fields, which a lone user
  correcting their own smoke can't race, with the audit trail preserving
  truth if it ever happens.

## Consequences

Repeat smokes compare naturally; the importer maps each legacy "Review N"
heading to its own Smoke. Free-form stages make "what did the middle taste
like" queries fuzzier than fixed thirds — position ranges cover analysis.
Unverified cigars accumulate and need the curation queue (ADR-006).

## Alternatives considered

- Journal-entry-as-aggregate (legacy model) — collapses repeat experiences;
  rejected on the product's core requirement.
- Observation event stream (each message an event) — contradicts the
  ephemeral-conversation design; the backend never sees mid-smoke messages.
- Fixed thirds progression — misrepresents how people actually narrate.
