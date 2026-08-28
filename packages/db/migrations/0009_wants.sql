-- 0009_wants — the single per-user want mark (PRD-003 R-WANT-1..3, DESIGN-002).
-- An independent personal flag on a catalog cigar: never auto-cleared by smoking,
-- and acquisition only OFFERS the clear (never silent). One row per (user, cigar);
-- the UNIQUE pair makes set/clear a target-state idempotent upsert/delete.
--
-- List-ready (R-WANT-4): when named lists arrive, `wants` becomes the seeded
-- system list. A later migration adds the list dimension (a nullable list_id, or
-- a rename into a generic list-membership table) WITHOUT reshaping this row — the
-- (user, cigar, note, created_at) shape carries forward untouched, so nothing
-- here precludes that migration.
--
-- ON DELETE CASCADE keeps referential integrity when a cigar or user is removed;
-- catalog merge (ADR-006) does not yet repoint wants, so a merge drops the
-- source cigar's marks — acceptable for v1, revisited with the unified catalog.

CREATE TABLE wants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cigar_id   uuid NOT NULL REFERENCES cigars (id) ON DELETE CASCADE,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, cigar_id)
);

-- The overlay reads filter by user_id (a caller's marks across the catalog) and
-- join by (user_id, cigar_id); the UNIQUE constraint already indexes the pair,
-- this covers the user-scoped shelf/facet scan the unified catalog will add.
CREATE INDEX wants_user_idx ON wants (user_id);
