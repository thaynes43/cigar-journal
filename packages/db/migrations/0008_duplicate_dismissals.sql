-- 0008_duplicate_dismissals — curator "not duplicates" verdicts (ADR-006).
-- The curation queue's trigram candidate generator inevitably surfaces sibling
-- products that share a long brand/line prefix (Liga Privada No. 9 vs T52,
-- Padron 1964 Natural vs Maduro). A dismissal records the curator's judgment
-- that a surfaced pair is distinct products, and the queue excludes it from
-- then on. Pairs are stored id-ordered (a < b) to match the queue's
-- c1.id < c2.id join, enforced by CHECK. Rows cascade with either cigar — a
-- merge or delete makes the verdict moot — and survive the dismissing
-- curator's departure (dismissed_by drops to NULL; the verdict outlives the
-- account because it is about the catalog, not the curator).

CREATE TABLE duplicate_dismissals (
  cigar_a_id   uuid NOT NULL REFERENCES cigars (id) ON DELETE CASCADE,
  cigar_b_id   uuid NOT NULL REFERENCES cigars (id) ON DELETE CASCADE,
  dismissed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cigar_a_id, cigar_b_id),
  CHECK (cigar_a_id < cigar_b_id)
);
