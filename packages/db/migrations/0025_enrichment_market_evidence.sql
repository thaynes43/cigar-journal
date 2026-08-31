-- 0025_enrichment_market_evidence — read-path indexes for the EVIDENCED MARKET
-- and for per-vendor lane liveness (ADR-006 amendment 2026-08-30; issues #170,
-- #185, #155).
--
-- SCHEMA-NEUTRAL AND WRITE-FREE. No column, no constraint, no backfill. The
-- evidenced market is DERIVED on every read and never stored, deliberately:
-- writing an inferred market into `cigars.type` — a curator-trust-order,
-- user-visible field — from a signal as coarse as a vendor's focus is
-- manufacturing catalogue facts, which is exactly what that amendment forbids.
-- It would also not self-heal: a backfilled row is frozen at the moment it was
-- computed, while the derived value sharpens with every crawl that links a
-- listing and is overridden outright the moment a curator types the cigar.

-- The evidenced market asks "which single-market vendors already stock this
-- cigar?" — a correlated subquery keyed on `listing_matches.cigar_id`, evaluated
-- once per candidate row (up to ENRICHMENT_BACKLOG_MAX = 100 per backlog press,
-- twice per row in the drain's open set). That column carries NO index today:
-- the table has only its primary key and UNIQUE (vendor_id, listing_key), so
-- every evaluation was a sequential scan.
--
-- Partial on NOT NULL because an unmatched listing (cigar_id IS NULL) is never
-- evidence about any cigar and the subquery never looks for one. On prod's
-- listing_matches that is most of the triage queue kept out of the index.
CREATE INDEX listing_matches_cigar_idx
  ON listing_matches (cigar_id)
  WHERE cigar_id IS NOT NULL;

-- Two reads, one index:
--   * #185 liveness — "when did this vendor's enrich lane last START a run that
--     succeeded?", per vendor, on every fleet read (once per backlog row);
--   * #155's stranded-run sweep — "any row still `running` for this (vendor,
--     kind)?", once per crawl.
-- The column order follows the equality predicates both share, with started_at
-- trailing so the liveness read is an index-only backwards scan for its max.
CREATE INDEX crawl_runs_vendor_kind_started_idx
  ON crawl_runs (vendor_id, kind, status, started_at DESC);
