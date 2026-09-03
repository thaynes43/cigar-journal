# ADR-017: Family rows and vitola specialization

- **Status:** accepted
- **Date:** 2026-09-03
- **Amends:** ADR-012 (leaf identity), flow 002 (resolution)

## Context

The catalog holds `Padron 1926 Natural`: brand linked, no line, no blend, no
vitola, two of the owner's smokes on it. The 2026-09-02 smoke was identified
during the session as the Serie 1926 No. 2 (belicoso, 5.5 × 52). The owner
deliberately did not set the row's vitola, because that would retroactively
declare every earlier smoke and lot on the row a No. 2. He was right, and the
model had no better move to offer.

ADR-012 defines the leaf as one blend in one vitola, and makes every level
nullable. A row with `vitola_name NULL` is therefore a legitimate leaf that
says *vitola not recorded* — a **family row**. What the system lacks is a way
to move *forward* from one: a stated vitola against a family row today either
links to it (a size word is vocabulary, struck before residues are compared —
`Padron 1926 Natural Belicoso` collapses onto `Padron 1926 Natural`) or, when
the vitola carries a number, mints an unrelated row that shares nothing with
its family. And a purchase lot cannot be re-pointed at all.

## Decision

**A family row is never retyped; a stated vitola specializes it into a sibling
leaf, and history moves one record at a time, explicitly.**

- **Family rows stay.** `vitola_name NULL` means unknown, holds what was
  journaled when it was unknown, and is edited into a vitola by nobody — not
  the resolver, not enrichment, not the curation ladder. Structure (brand,
  line, blend) is still assigned to it as ADR-012's worklists do.
- **Specialization in `resolveCigar`.** When the described cigar states
  `vitola.name`, and the resolver's single strong candidate is a family row
  that is otherwise link-compatible, it does not link. It mints (get-or-create)
  the **sibling**: `brand_id`, `line_id`, `blend_id` and the free-text
  `brand`/`line` copied from the family row; `vitola_name` and dimensions from
  the description; `canonical_name` the described name when it already names
  the vitola, else the family name followed by the vitola; `name_source`
  `freeform`; `unverified`; enrichment queued as for any created row. An
  existing sibling with the same parts (or folded name) links, `created:
  false`. The result carries `specializedFrom: { cigarId, canonicalName }` and
  the audit row records it. Sibling matching by parts applies only under a
  brand; an unbranded family links a sibling by folded name alone, or mints —
  null parts are not "the same parts" (the reason `split_cigar` refuses
  unbranded rows). A stated vitola that *differs* from a candidate's recorded
  one is a different product and creates as today. No stated vitola → link to
  the family row as today: unknown stays unknown.
- **The vitola is a field, not a word.** The rule keys on `described.vitola.name`;
  a size word in `canonicalName` alone remains vocabulary and links (flow 002).
  When a vitola is stated, its tokens are struck from the described name before
  the candidate search and the strong-match comparison: the name minus its
  vitola is the family claim, so `Padron 1926 Natural No. 2` resolves against
  `Padron 1926 Natural` although `2` is a number, and specializes. What the
  strike leaves is compared under the ordinary rules — a leftover word still
  asks (`… Serie …` against a family that never said it), and the sibling's
  name is still composed from the full described name.
  Server instructions and the `search_cigars`/`save_smoke`/`add_cigar`
  descriptions say it: a match whose `vitola.name` is null is a family entry;
  when the user names the vitola, put it in `vitola.name` so the smoke lands
  on that vitola's own entry; when they do not, the family entry is right.
- **Re-pointing is per record and explicit.** A smoke moves with
  `update_smoke { cigar: { resolveTo } }` (exists). A purchase lot moves with a
  new field-scoped `update_purchase { purchaseId, changes: { cigar: { resolveTo } } }`
  — owner-only, audited (`purchase.repoint`), refused with `validation_error`
  while any consumption on the lot belongs to a smoke on a different cigar
  than the destination (move the smokes first). Holdings are derived, so
  nothing else changes. Nothing bulk: a family row is never "migrated" as a
  whole, because only the owner knows which stick was which.
- **Listings** keep `split_cigar` (ADR-012 Wave 3); this ADR does not touch
  vendor matching.

## Consequences

- The conversational path becomes: identify the vitola → `add_cigar` with
  `vitola.name` (or the save's described cigar) → the sibling exists under the
  family's structure → `update_smoke` / `update_purchase` for the records the
  user vouches for. The family row keeps everything else.
- Siblings minted before a family row gains its line/blend inherit nulls and
  surface in the `unlined`/`unblended` worklists like any other row; a later
  `assign_cigar_taxonomy` on the family does not propagate.
- `add_cigar` and `save_smoke` results gain an optional `specializedFrom`; one
  new MCP tool (`update_purchase`), scope `journal:write`.
- Retro-applied to the 2026-09-02 smoke by hand: mint `Padrón 1926 Serie No. 2
  Natural` (No. 2, 5.5 × 52) and re-point smoke `e3c07c0b` there; the family
  row keeps its earlier smoke.

## Alternatives considered

- Set the family row's vitola once known — re-attributes every prior smoke and
  lot; the owner's own objection.
- A `family_match` guidance value on `search_cigars` — the match already
  carries `vitola.name: null`; a new enum for a nudge the description can give
  costs contract churn on every client.
- Treat a size word in the name as identity — reverses the vocabulary rule that
  stops `… Robusto` and `… Toro` from forking the catalog on every mention.
- Bulk "migrate this family" verb — invents attributions nobody made.
