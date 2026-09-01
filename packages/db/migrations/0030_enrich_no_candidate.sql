-- 0030_enrich_no_candidate — the outcome a look that read nothing is allowed to
-- record, and a clean slate for the asks the old prefilter wrote off (issue #240).
--
-- WHAT PROD RECORDED. Four nights of enrich drains, `errors=0`, every job green,
-- and 58 of 58 rows in `enrichment_attempts` reading `last_outcome = 'miss'` —
-- 100%, no cigar enriched, ever. The 06:00 Cuban Lou's run logged
-- `requests=48 looked=48 matched=0` against a crawl that fetched 242 pages: most
-- of those "looks" never opened a page at all. Meanwhile the offers walk over the
-- same two vendors and the same URLs auto-matched 992 listings, so the matcher
-- was never the problem — the drain's own slug-token prefilter was, and every
-- `miss` it produced was written to this ledger as a factual claim about a shop's
-- inventory.
--
-- Two parts, and they are one repair: the code half of #240 stops a look that
-- opened no page from claiming it read a catalogue, and this half gives the
-- outcome somewhere to live and clears the verdicts the defect already wrote.
--
--   1. Widen the `last_outcome` CHECK with 'no_candidate'.
--   2. Delete the miss/error ledger rows attached to asks that are still open,
--      and put the requests they retired back in the queue.
--
-- Data + one constraint. No table, no column, no index.


-- ---------------------------------------------------------------------------
-- PART 1 — THE OUTCOME
--
-- `enrichment_attempts.last_outcome` has admitted the three verdicts a look can
-- reach since 0023, plus 'photo_refused' since 0025. 'no_candidate' is the fifth
-- and it is the only one that describes a look that read NOTHING: the vendor's
-- product enumeration named the ask nowhere, so the drain fetched no page.
--
-- It carries `attempts = 0` exactly as 'photo_refused' does, and for the same
-- reason stated the other way round: `attempts` running out is what licenses
-- `exhausted`, whose whole meaning is "we read this catalogue and the cigar is
-- not in it". A row that opened no page cannot be a step toward that sentence.
-- The row is still WRITTEN, because "which lane came up empty-handed, and when"
-- is the fact an operator needs to tell a shop that does not stock the brand from
-- a registry that has not learned its aliases yet.
--
-- Re-runnable: the constraint is dropped IF EXISTS and re-added by name.
ALTER TABLE enrichment_attempts
  DROP CONSTRAINT IF EXISTS enrichment_attempts_last_outcome_check;

ALTER TABLE enrichment_attempts
  ADD CONSTRAINT enrichment_attempts_last_outcome_check
    CHECK (last_outcome IN ('miss', 'match', 'error', 'photo_refused', 'no_candidate'));


-- ---------------------------------------------------------------------------
-- PART 2 — THE CLEAN SLATE
--
-- WHY THIS IS SAFE TO DELETE, which is the only question worth asking about a
-- statement that erases evidence. A `miss` in this ledger asserts "vendor V read
-- its catalogue and does not carry cigar C". Every row being deleted was written
-- by the prefilter #240 replaces, and for the great majority of them no page was
-- fetched at all — the assertion was manufactured by our own shortlist scoring
-- zero, not observed at the vendor. The remainder were looks whose shortlist was
-- filled by whatever shared a stray token with the ask (`robusto`, `the`), so
-- they read the wrong pages. Neither kind is evidence about a catalogue, and
-- leaving them in place means the queue keeps retiring by exhaustion under
-- verdicts that were never true.
--
-- SCOPED THREE WAYS, and each narrowing is load-bearing:
--
--   * only NON-FULFILLED requests. A fulfilled ask has its catalogue photo; its
--     history is the record of how it got one and is not ours to rewrite.
--   * only 'miss' and 'error'. A 'match' row is the trail behind a real link, and
--     a 'photo_refused' row is why an ask is visibly stuck (#209) — it burns no
--     budget, so it holds nothing open and deleting it would only lose the reason.
--     Neither exists on prod today; the predicate is here so a row written between
--     writing this and deploying it is not swept up by accident.
--   * `attempts` is RECOMPUTED from what survives rather than zeroed, so the
--     request's reporting total and the per-vendor ledger cannot disagree — which
--     they would the moment either exception above actually fires.
--
-- Nothing is permanently lost by being wrong here in the other direction, either:
-- `exhausted` is in the drain's open set, so an ask put back in the queue that a
-- vendor genuinely does not carry simply re-earns its two looks and re-retires,
-- once, at the cost of at most `ATTEMPTS_PER_VENDOR` polite fetches per lane.
--
-- Re-runnable: a second execution finds no matching rows and changes nothing.
DELETE FROM enrichment_attempts a
 USING enrichment_requests r
 WHERE a.request_id = r.id
   AND r.status IN ('pending', 'in_progress', 'exhausted')
   AND a.last_outcome IN ('miss', 'error');

-- The cached status is a rollup over the ledger (see `finalizeEnrichment`), so a
-- row whose ledger just emptied is no longer exhausted by any reading of it. Put
-- it back to 'pending' with `resolved_at` cleared — the same shape the drain's own
-- reopen path writes — and re-derive `attempts` from whatever ledger rows remain.
-- `in_progress` is normalized to 'pending' on the way past for the reason 0023
-- gives: the drain has not written that state since #157 and nothing re-selects it.
UPDATE enrichment_requests r
   SET status = 'pending',
       resolved_at = NULL,
       attempts = COALESCE(
         (SELECT sum(a.attempts) FROM enrichment_attempts a WHERE a.request_id = r.id),
         0
       )
 WHERE r.status IN ('pending', 'in_progress', 'exhausted');
