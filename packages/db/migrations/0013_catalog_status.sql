-- 0013_catalog_status — catalog lifecycle gate + tombstone merge (DESIGN-003
-- §Curation). `catalog_status` is the browse-visibility gate every catalog-facing
-- read now honors (browse/brands/shelves/brand pages/search/curation queue):
--   active   — the default, shown everywhere.
--   excluded — non-cigar pollution, or an entry a curator chose to hide. Hidden
--              from browse/search/queue but NOT deleted: an excluded cigar with
--              owner smokes stays reachable by direct id (its detail/journal reads
--              still resolve — see excludeCigar's contract in curation.ts).
--   merged   — a duplicate folded into a survivor by mergeCigars (below).
-- Backfilled to 'active' for every existing row by the column DEFAULT.
--
-- `merged_into` turns merge from a hard delete into a tombstone (DESIGN-003
-- "Merge stops hard-deleting … so Undo is real"): the source row survives with
-- catalog_status='merged' and merged_into pointing at the survivor, keeping its
-- data. ON DELETE SET NULL so the self-FK never blocks — merge no longer deletes
-- cigars, but the constraint stays safe if one is ever removed by another path.

ALTER TABLE cigars
  ADD COLUMN catalog_status text NOT NULL DEFAULT 'active'
    CHECK (catalog_status IN ('active', 'excluded', 'merged')),
  ADD COLUMN merged_into uuid REFERENCES cigars (id) ON DELETE SET NULL;

-- Every browse/search/queue read filters catalog_status = 'active'. A plain index
-- keeps the excluded/merged tombstone lookups (review views, the merge chain)
-- cheap; the 'active' majority is answered by seq scan regardless.
CREATE INDEX cigars_catalog_status_idx ON cigars (catalog_status);
