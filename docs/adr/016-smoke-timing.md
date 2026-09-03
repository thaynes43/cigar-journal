# ADR-016: Smoke timing — startedAt, endedAt, and a derived duration

- **Status:** accepted
- **Date:** 2026-09-03

## Context

A smoke has a length, and the journal does not record it. The 2026-09-02
Padrón 1926 session produced the two lifecycle events that bound it without the
user tracking anything: the photo drop was opened at 01:04Z, when the first
photo appeared in the conversation (ADR-014), and the 94/100 was saved at the
nub at 02:20Z. That is a 1h 16m smoke the system observed and threw away.

`smokedAt` cannot carry this. It is one instant with provenance (ADR-002), and
on a live save the server stamps it with the finalize time — the *end* of the
smoke, labelled as when it happened. A stored duration is the wrong shape too:
a corrected start time would leave a stale duration beside it, and two numbers
that should agree eventually will not.

## Decision

**Two provenance-aware instants on the smoke; duration is derived on read and
never stored.**

- `smokes.started_at` / `started_at_source` (`user` | `photo-drop`) and
  `smokes.ended_at` / `ended_at_source` (`user` | `system-finalized`). All
  nullable; a source is present exactly when its instant is. Unknown stays
  null — nothing is synthesized to fill a gap (ADR-002).
- **`durationMinutes`** is computed wherever a smoke is read: `floor((ended −
  started) / 60s)` when both instants exist, the difference is positive, and it
  is at most twelve hours (`MAX_SMOKE_DURATION_HOURS`). Otherwise null. Rendered
  as `1h 16m`, `45m`, `2h` — never `0m`, never a raw minute count.
- **Stated beats observed.** `save_smoke` and `update_smoke` accept
  `startedAt` / `endedAt` (`{ value }`, source `user`) only when the user
  stated them; the web record and edit forms expose *Started* and *Ended*
  beside *Smoked at*. A user value is never overwritten by an observation.
- **The photo drop establishes the start.** A drop records its **session
  start**: `photo_drops.session_started_at`, set when the drop is created and
  reset when the drop is re-opened more than four hours after its last opening
  (`photo_drops.last_opened_at`; `DROP_SESSION_GAP_HOURS = 4`). One open drop
  per user (ADR-014) means a drop is routinely re-used across evenings — the
  drop tonight's save claimed was 23 hours old when the 01:04Z open began the
  session — so the drop's creation time is not the start; its most recent
  opening run is. A save that names a `photoDropId` and states no `startedAt`
  takes that drop's `session_started_at`, source `photo-drop`. The read happens
  inside the save transaction (a read cannot fail the save; a missing or
  foreign drop derives nothing — the claim itself stays post-commit as ADR-014
  rules). A late claim through `add_smoke_photo { photoDropId }` sets it in the
  claim's transaction with `COALESCE`, so it never overwrites. An observation
  that would put the start more than twelve hours before the end is not
  applied.
- **Finalizing establishes the end.** `endedAt = now`, source
  `system-finalized`, exactly when the server stamps `smokedAt` (a live save
  with `smokedAt` unstated). A save carrying a stated `smokedAt` is a user
  logging after the fact and gets no end.
- **`smokedAt` amendment (ADR-002).** When the server stamps `smokedAt` and a
  start was established on the same save, `smokedAt` takes the start's value:
  the journal date is when the cigar was lit, not when it was written up. A
  smoke lit before midnight and saved after it files under the evening it
  belongs to. `system-finalized` now means *the server's best observation of
  when the smoke happened*, not literally the finalize instant. A user-stated
  `startedAt` with `smokedAt` unstated makes `smokedAt` that value, source
  `user`, precision `minute`.
- **Edits are field-scoped** (`changes.startedAt`, `changes.endedAt`; explicit
  null clears, and clears the source with it). An end before its start is a
  `validation_error`; anything else is stored as given and the derivation says
  null when it cannot vouch for the pair.

## Consequences

- Every live smoke with a photo gets a duration for free, and one without a
  photo gets one the moment the user says when they lit it.
- `photo_drops` gains `session_started_at` and `last_opened_at`, backfilled
  from `created_at`; `open_photo_drop` maintains them on every open.
- `SmokeView`, `PublicSmokeView`, and the MCP smoke shapes gain `startedAt`,
  `endedAt`, and `durationMinutes`; the detail header renders the duration
  after the date. The legacy importer never sets timing.
- A retried save (same `clientRequestId`) is a replay and re-derives nothing.
- Follow-up: the model could establish the start from a spoken cue ("just lit
  it") by stating `startedAt` itself; it has no clock, so that stays a
  user-stated value and is not inferred here.

## Alternatives considered

- Store `duration_minutes` — diverges from the instants on the first
  correction; rejected on the owner's rule.
- Redefine `smokedAt` as the start and add only `endedAt` — changes the
  meaning of every existing row and of imports that carry a date only.
- Start from the drop's *creation* time — wrong on the first real sample (a
  re-used, day-old drop); the opening run is the observation that tracks the
  session.
- Start from the first *uploaded* photo rather than the drop's opening — later
  than the real start whenever the user uploads after the fact, and the
  opening is the observation ADR-014 already makes.
- A `start_smoke` tool — a lifecycle state ADR-014 already rejected for media;
  the drop is the start signal that exists.
