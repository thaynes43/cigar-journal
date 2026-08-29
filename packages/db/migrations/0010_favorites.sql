-- 0010_favorites — the second per-user cigar-level mark (PRD-003, DESIGN-002),
-- mirroring `wants` (0009). Favorite = a cigar the user LOVES, distinct from Want
-- (a cigar to try/own). An independent personal flag on a catalog cigar: never
-- touched by smoking or acquisition. One row per (user, cigar); the UNIQUE pair
-- makes set/clear a target-state idempotent upsert/delete.
--
-- List-ready: when named lists arrive, `favorites` joins `wants` as the two seeded
-- system lists. A later migration adds the list dimension (a nullable list_id, or
-- a rename into a generic list-membership table) WITHOUT reshaping this row — the
-- (user, cigar, note, created_at) shape carries forward untouched.
--
-- ON DELETE CASCADE keeps referential integrity when a cigar or user is removed.
-- Unlike Want v1, catalog merge (ADR-006, curation.ts) DOES re-point favorites to
-- the surviving cigar, de-duplicated against any mark the user already holds on
-- the target — see mergeCigars.

CREATE TABLE favorites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cigar_id   uuid NOT NULL REFERENCES cigars (id) ON DELETE CASCADE,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, cigar_id)
);

-- The overlay reads filter by user_id (a caller's marks across the catalog) and
-- join by (user_id, cigar_id); the UNIQUE constraint already indexes the pair,
-- this covers the user-scoped shelf/facet scan a later Favorites view will add.
CREATE INDEX favorites_user_idx ON favorites (user_id);
