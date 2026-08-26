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
- **Progression** is a list of entries with free-form stage labels plus
  optional numeric position (0–1) — not hard-coded thirds. Position enables
  analysis; the label preserves how the user actually spoke.
- **Vocabulary:** normalized kebab-case Descriptors for search/analytics,
  always stored alongside verbatim text. No enum, no ontology; synonym
  mapping is a later curation feature over observed tags.
- **Rating:** 0–100 (archive-compatible, industry convention), nullable.
  Unknown stays null everywhere — schemas must never force invention.
- **Personal Profile** (per user per cigar) is computed on read from Smokes;
  nothing materialized until query cost proves otherwise.
- **Editing:** field-scoped patches; audit row in the same transaction (house
  pattern). Optimistic version check on web forms; MCP patches are
  last-write-wins on the targeted fields — a lone user correcting their own
  smoke doesn't race, and the audit trail preserves truth if it ever does.

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
