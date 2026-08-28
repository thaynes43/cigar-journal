# ADR-008: Explicit consumption — a smoke deducts from the humidor by link, not heuristic

- **Status:** accepted
- **Date:** 2026-08-28

## Context

R13 shipped holdings with a documented heuristic: `remaining = max(0,
totalAcquired − smokes since first purchase)`, null-dated smokes counting
(`packages/domain/src/inventory.ts`, `get_my_inventory` contract). The owner's
direction (2026-08-28) is explicit: "Reviews deduct from Inventory." The
heuristic cannot express that: a lounge smoke or gifted stick of a cigar the
user also owns silently deducts a stick he never touched; a stick from the
humidor smoked before its purchase row was entered deducts nothing; and no
smoke can ever say *which lot* it came from — which Cuban box codes and
box-date aging (R13 design-time fields) will require. The category evidence
agrees: Vivino is the only surveyed collection app that decrements stock, and
it does so only on an explicit per-event confirmation, never by inference.

## Decision

**Consumption is an explicit link from a Smoke to the humidor, stored in the
Inventory context — one row in `smoke_consumptions`:**

- `smoke_id` (unique, FK smokes, cascade on delete), `purchase_id` (nullable
  FK — lot attribution when the user stated or picked one), `source`
  (`user` | `heuristic-backfill`), `created_at`. User and cigar derive
  through the smoke; no denormalized copies to drift.
- One row means: this smoke consumed one stick from the caller's holdings.
  No row means the stick came from elsewhere (lounge, gift, sample) — or
  predates this model. A Smoke is one physical cigar (ADR-002), so quantity
  is structural, never a column.
- `remaining = totalAcquired − count(consumptions)` per cigar (and per lot
  where attributed). Displays still floor at zero; the ledger view surfaces
  the discrepancy instead of hiding it — an over-consumed holding means a
  missing acquisition row, fixed the established way (a correcting
  `record_purchase` row, ADR-006/tool contract), never an edit.
- **Capture at save time.** Web: the record form shows a "from my humidor"
  control when the resolved cigar has holdings, on by default when
  `remaining > 0`; an optional lot picker appears only when lots are
  distinguishable (box date / box code). MCP: `save_smoke` gains an optional
  `consumption` block; server instructions direct the client to ask once at
  finish ("from your humidor?") when the resolved cigar shows holdings.
  **Omitted means unknown, and unknown deducts nothing** — the schema never
  forces the model to invent a provenance (contract principle 2).
- **Editable like any smoke fact:** `update_smoke` and the web edit form get
  a consumption change block (set / clear / re-attribute lot), audited in
  the same transaction. Re-pointing a smoke to a different cigar clears a
  now-foreign `purchase_id` (kept in the audit row).
- **One-time backfill migration** seeds rows for existing smokes using the
  dying heuristic's own rule (smokes on/after the cigar's first purchase,
  null-dated included), `source: heuristic-backfill` so curation can review.
  After it runs, the heuristic code path is deleted — `get_my_inventory`,
  `record_purchase.holdingAfter`, and the inventory pages all read the
  explicit count. History is reconciled once, visibly, not silently forever.

This supersedes the derivation heuristic documented in the MCP tool contract
(`get_my_inventory`, `record_purchase`) and PRD-001 R13, and amends the DDD
"deliberately not modeled" list: humidor stock is now modeled — as a
consumption link, still never as a mutable counter.

## Consequences

- "Reviews deduct from Inventory" becomes literally true, per-smoke
  auditable, and lot-attributable — the substrate Cuban box codes need.
- Both ledgers stay append-only and symmetric: purchases acquire,
  consumptions consume, corrections are new rows.
- Cost: one more question at save time when holdings exist (one tap on the
  web, one conversational beat via MCP). Accepted — it is the only honest
  source for the fact.
- Backfilled history inherits the heuristic's known blindness (pre-purchase
  and off-humidor smokes); rows are flagged for curation rather than
  presented as user truth.

## Alternatives considered

- **Keep the heuristic** — cannot represent off-humidor smokes of owned
  cigars or lot attribution; contradicts the owner's stated model.
- **Boolean on `smokes`** — same cardinality, but no lot attribution, no
  provenance, and it welds Inventory-context stock movement into the Journal
  aggregate ADR-002 deliberately kept clean.
- **Unified inventory-event ledger** (acquisitions + consumptions +
  adjustments in one table) — purchases already are the acquisition ledger;
  a parallel copy would fork the source of truth for no query it enables.
- **Decrement a stored counter** — mutable stock state contradicts the
  append-only/derived pattern every holding number already follows.
