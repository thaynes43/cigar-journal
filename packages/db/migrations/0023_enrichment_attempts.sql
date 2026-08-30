-- 0023_enrichment_attempts — the vendor dimension the attempt budget always
-- needed (ADR-006 amendment 2026-08-30, issue #158). A vendor's catalogue is
-- PARTIAL: "no match at Fox" is evidence about Fox, never about the cigar. The
-- pre-0023 budget was one counter per REQUEST shared across every vendor, so at
-- two lanes a request retired after ONE look from each. This table gives every
-- vendor its own budget against the same ask.
CREATE TABLE enrichment_attempts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The ask, not the cigar: a merge re-points enrichment_requests.cigar_id and
  -- the evidence follows the request without touching this table.
  request_id uuid NOT NULL REFERENCES enrichment_requests (id) ON DELETE CASCADE,
  -- Cascade: a verdict naming a vendor that no longer exists is worse than no
  -- verdict, and RESTRICT would make deleting a vendor a support ticket. Losing
  -- the row reopens the request, which is the honest outcome.
  vendor_id  uuid NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  -- Completed looks. A look is complete when the vendor's product enumeration was
  -- non-empty and every ranked candidate was fetched-and-judged — INCLUDING "no
  -- candidate scored", which is a real miss (we read the catalogue; nothing there
  -- resembled the cigar) and burns budget.
  attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Looks that could not complete (empty enumeration, every candidate non-200).
  -- Not evidence about the vendor's catalogue, so they never burn `attempts` —
  -- but they are bounded, or a broken vendor pins a request open forever. Reset
  -- to zero by any completed look: the budget is for CONSECUTIVE failures, and a
  -- vendor that answered once is not permanently broken.
  errors     integer NOT NULL DEFAULT 0 CHECK (errors >= 0),
  last_outcome    text NOT NULL CHECK (last_outcome IN ('miss', 'match', 'error')),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  note       text,
  -- One ledger row per (ask, vendor). Also the ON CONFLICT target that makes the
  -- increment atomic, so two overlapping same-vendor runs record two real looks
  -- instead of losing one to a read-modify-write (#157 defect 1).
  UNIQUE (request_id, vendor_id)
);

-- The drain's question: "which open requests has THIS vendor not spent?"
CREATE INDEX enrichment_attempts_vendor_idx ON enrichment_attempts (vendor_id, request_id);

-- The drain no longer stamps a request `in_progress` (a request-level lock on a
-- per-vendor operation). Legacy rows would otherwise be unreachable — nothing
-- re-selects them (#157 defect 2). Prod holds none; this is for dev/test DBs and
-- for honesty about the state the code is dropping. `attempts` is deliberately
-- untouched: the pre-0023 counter is vendor-blind, and splitting it across
-- vendors would mean INVENTING which vendor spent it — manufactured evidence
-- about a vendor is exactly what the ADR amendment forbids. The ledger therefore
-- starts empty and every (request, vendor) pair starts at zero.
UPDATE enrichment_requests SET status = 'pending' WHERE status = 'in_progress';
