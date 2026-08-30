-- 0020_cigar_merges — per-merge bookkeeping so unmerge is real (#45).
-- The tombstone merge (0013) kept the source row but not the knowledge of WHICH
-- rows moved: after the merge a re-pointed smoke is indistinguishable from one
-- the survivor always had, and the want/favorite de-dupe deleted rows outright.
-- One ledger row per merge, written in the merge's own transaction, closes that
-- gap — it is the only thing that makes `unmergeCigars` an inverse rather than a
-- guess.
--
-- `moves` is a versioned JSONB ledger (v1):
--   { version, sourceBefore: {catalogStatus, mergedInto},
--     moved: {smokes[], purchases[], listingMatches[], offers[],
--             enrichmentRequests[], productPhotos[], wants[], favorites[]},
--     dropped: {wants: [{id,userId,note,createdAt}], favorites: [...]} }
-- JSONB rather than a member-row table because it is only ever read whole, by
-- merge id — nothing filters or joins on an individual moved id. `dropped`
-- carries FULL payloads, not ids: those rows were DELETEd, so restoring identity
-- (same id, note, created_at) needs the values back.
--
-- Single-use is enforced the way photo_upload_tokens enforces it: a conditional
-- `UPDATE … SET undone_at = now() WHERE id = $1 AND undone_at IS NULL`. That
-- claim both serializes concurrent unmerges and backstops idempotency, so there
-- is deliberately NO `(undone_at IS NULL) = (undo_audit_id IS NULL)` CHECK —
-- the claim lands first and the undo audit id is stamped after it is written.
--
-- Merges audited before this migration have no ledger and can never get one; the
-- information was never recorded. They report non-reversible (prod carried zero
-- `cigar.merge` rows when this landed, so the backfill question is moot).

CREATE TABLE cigar_merges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Both cascade: if a cigar is ever hard-deleted by another path the merge is
  -- moot, and a ledger pointing at a missing referent is worse than no ledger.
  source_cigar_id uuid NOT NULL REFERENCES cigars (id) ON DELETE CASCADE,
  target_cigar_id uuid NOT NULL REFERENCES cigars (id) ON DELETE CASCADE,
  -- The `cigar.merge` audit row this ledger belongs to. UNIQUE so an audit id
  -- resolves to exactly one ledger — that is how Undo finds it. No ON DELETE
  -- rule: the audit log is append-only.
  audit_id        uuid NOT NULL UNIQUE REFERENCES audit_log (id),
  moves           jsonb NOT NULL,
  merged_at       timestamptz NOT NULL DEFAULT now(),
  undone_at       timestamptz,
  undo_audit_id   uuid REFERENCES audit_log (id),
  CHECK (source_cigar_id <> target_cigar_id)
);

-- "Is this tombstone undoable?" — by source, the lookup the console and the
-- state guards run.
CREATE INDEX cigar_merges_source_idx ON cigar_merges (source_cigar_id);
-- The LIFO chain guard asks "was this survivor itself later merged, still live?"
-- — a partial index, since an undone ledger row never blocks anything.
CREATE INDEX cigar_merges_live_target_idx ON cigar_merges (target_cigar_id) WHERE undone_at IS NULL;
-- The "Recent merges" console read, newest first.
CREATE INDEX cigar_merges_merged_at_idx ON cigar_merges (merged_at DESC);
