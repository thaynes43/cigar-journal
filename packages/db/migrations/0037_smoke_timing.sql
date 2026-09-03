-- 0037_smoke_timing — a smoke has a length, and the journal did not record it
-- (ADR-016). Two provenance-aware instants bound the session; the duration is
-- DERIVED on every read and never stored, so a corrected start can never leave a
-- stale number beside it.
--
-- `started_at_source` is `user` (stated) or `photo-drop` (the drop's opening —
-- the earliest observation the system has of the session, ADR-014).
-- `ended_at_source` is `user` or `system-finalized` (the save that finalized the
-- smoke). All four columns are nullable: unknown stays null, nothing is
-- synthesized to fill a gap (ADR-002).
--
-- The paired CHECKs make an instant without its provenance — and a provenance
-- without its instant — unrepresentable, the same discipline `smoked_at` carries
-- through its NOT NULL source. No backfill: the instants are observations, and
-- no observation exists for a row written before this migration. Applied by the
-- advisory-locked migrate runner (ADR-003), never drizzle-kit push.

ALTER TABLE smokes
  ADD COLUMN started_at        timestamptz,
  ADD COLUMN started_at_source text
    CHECK (started_at_source IN ('user', 'photo-drop')),
  ADD COLUMN ended_at          timestamptz,
  ADD COLUMN ended_at_source   text
    CHECK (ended_at_source IN ('user', 'system-finalized'));

ALTER TABLE smokes
  ADD CONSTRAINT smokes_started_at_source_ck
    CHECK ((started_at IS NULL) = (started_at_source IS NULL)),
  ADD CONSTRAINT smokes_ended_at_source_ck
    CHECK ((ended_at IS NULL) = (ended_at_source IS NULL));

-- The drop's SESSION window. `photo_drops.created_at` is NOT the start of the
-- smoke that claims it: one open drop per user (ADR-014) means the same drop is
-- re-used for evenings on end — the drop the 2026-09-02 save claimed had been
-- created 23 hours earlier and was merely RE-OPENED at 01:04Z when that night's
-- first photo appeared. `session_started_at` is the beginning of the current run
-- of opens, reset by `open_photo_drop` whenever an open lands more than
-- DROP_SESSION_GAP_HOURS after the previous one; `last_opened_at` is what that
-- gap is measured from. Both NOT NULL — a drop is always in some session — and
-- backfilled from `created_at`, which is exactly what they were for a drop that
-- has only ever been opened once.
ALTER TABLE photo_drops
  ADD COLUMN session_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_opened_at     timestamptz NOT NULL DEFAULT now();

UPDATE photo_drops
   SET session_started_at = created_at,
       last_opened_at     = created_at;
