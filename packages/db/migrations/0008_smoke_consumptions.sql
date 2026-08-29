-- 0008_smoke_consumptions — explicit consumption link (ADR-008). A Smoke deducts
-- one stick from the humidor only via a row here; no row means the stick came
-- from elsewhere (lounge, gift, sample) or predates this model. User and cigar
-- derive through the smoke, so nothing is denormalized to drift. A Smoke is one
-- physical cigar (ADR-002), so quantity is structural — never a column. This
-- supersedes the derivation heuristic (get_my_inventory, record_purchase,
-- PRD-001 R13): remaining = totalAcquired − count(consumptions), floored only at
-- the display; the ledger surfaces over-consumption instead of hiding it.
-- Applied by the advisory-locked migrate runner (ADR-003), never drizzle-kit push.

CREATE TABLE smoke_consumptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One consumption per smoke — the unique link that makes a smoke a deduction.
  smoke_id    uuid NOT NULL UNIQUE REFERENCES smokes (id) ON DELETE CASCADE,
  -- Lot attribution when the user stated or picked one (ADR-008 R-CONS-4, the
  -- substrate Cuban box codes need). Null = an unattributed humidor stick.
  purchase_id uuid REFERENCES purchases (id),
  -- 'user' for an explicit capture; 'heuristic-backfill' for the one-time seed
  -- below, flagged so curation can review the inherited blindness.
  source      text NOT NULL DEFAULT 'user'
                CHECK (source IN ('user', 'heuristic-backfill')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The count() per cigar drives remaining; index the derivation path.
CREATE INDEX smoke_consumptions_smoke_idx ON smoke_consumptions (smoke_id);
CREATE INDEX smoke_consumptions_purchase_idx ON smoke_consumptions (purchase_id);

-- One-time backfill (ADR-008): seed a consumption for each existing smoke using
-- the dying heuristic's own rule — smokes of a cigar the caller has purchased,
-- dated on or after that cigar's first purchase, null-dated smokes included.
-- Flagged `heuristic-backfill` so history is reconciled once, visibly, not
-- presented as user truth. The migrate runner is the only writer at this point,
-- and ON CONFLICT keeps it idempotent if ever replayed. purchase_id stays null —
-- the heuristic never knew which lot a smoke came from.
INSERT INTO smoke_consumptions (smoke_id, source)
SELECT s.id, 'heuristic-backfill'
FROM smokes s
JOIN (
  SELECT user_id, cigar_id, min(purchased_at) AS first_purchase
  FROM purchases
  GROUP BY user_id, cigar_id
) fp ON fp.user_id = s.user_id AND fp.cigar_id = s.cigar_id
WHERE fp.first_purchase IS NULL
   OR s.smoked_at IS NULL
   OR s.smoked_at >= fp.first_purchase
ON CONFLICT (smoke_id) DO NOTHING;
