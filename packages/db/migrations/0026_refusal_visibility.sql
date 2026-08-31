-- 0026_refusal_visibility — make the crawler's two REFUSALS visible instead of
-- silent (verify round 2 of #170; issue #209). Both halves record a decision the
-- crawler already made and then threw away, and in both cases throwing it away is
-- what let a wrong outcome pass for a right one.

-- ---------------------------------------------------------------------------
-- 1. WHY A CRAWLER-UNMATCHED LISTING IS UNMATCHED
-- ---------------------------------------------------------------------------
-- A refused listing is written `status='unmatched', cigar_id=NULL,
-- decided_by='crawler'` — byte-for-byte the same row an ordinary no-match writes,
-- and the same row the excludeCigar cascade leaves behind. Three different facts,
-- one indistinguishable state, and the triage queue therefore showed none of them
-- (`matchTriagePage` read `status='auto'` only).
--
-- The three have to be told apart, because they want opposite treatment:
--   market_refusal — the resolver found a candidate above the similarity floor and
--                    DECLINED it on market grounds. The most actionable row in the
--                    queue: a curator can confirm the link or create the cigar,
--                    and while nobody does, an offer sits unattached.
--   no_match       — the resolver looked and found nothing above the floor. Worth
--                    seeing (in `seed` mode it is what a new catalogue row would
--                    have been made from) but nothing was refused.
--   NULL           — nothing the CRAWLER decided. Today that is the excludeCigar
--                    cascade (#126), which unmatches an excluded cigar's links so
--                    the 20 gift-card listings leave triage FOR GOOD. Those must
--                    stay out, so the triage read keys on this column being set
--                    rather than on `decided_by='crawler'` alone.
--
-- Cleared (not just overwritten) whenever the row becomes a link again — see
-- upsertListingMatch, which always writes this column so a re-matched row cannot
-- keep a stale reason.
ALTER TABLE listing_matches
  ADD COLUMN unmatched_reason text
    CHECK (unmatched_reason IS NULL OR unmatched_reason IN ('market_refusal', 'no_match'));

-- Backfill. Every row currently in the crawler-unmatched state is a no-match: on
-- prod (verified 2026-08-31) there are exactly 3 — Fox Cigar's three Oliva Master
-- Blends 3 listings from the 2026-08-30 04:00 offers pass, all with
-- `updated_at = created_at`, i.e. written once by the resolver and never touched
-- since. No cascade row is in this state (a cascaded row is re-proposed 'auto' by
-- the next crawl, and the triage read filters it on the cigar being inactive), and
-- market refusals cannot be here because nothing has ever written one — the code
-- that produces them ships in this PR. So the backfill is exact rather than
-- best-effort, and it is what makes those 3 rows appear the moment this deploys
-- instead of after the next crawl re-writes them.
UPDATE listing_matches
   SET unmatched_reason = 'no_match'
 WHERE status = 'unmatched'
   AND decided_by = 'crawler'
   AND unmatched_reason IS NULL;

-- ---------------------------------------------------------------------------
-- 2. A PHOTO REFUSAL IS NOT A LOOK
-- ---------------------------------------------------------------------------
-- `enrichment_attempts.last_outcome` admitted only the three verdicts a LOOK can
-- reach. A fourth is now recordable: the vendor completed the look, found the
-- cigar and linked it, and was refused the one catalogue-photo slot by the
-- write-authority guard (#209).
--
-- It is its own value precisely because it must NOT behave like the other three.
-- `attempts` is the budget whose exhaustion licenses the sentence "we read this
-- vendor's catalogue and the cigar is not in it" — which a refusal would make
-- false, since the catalogue plainly does carry it. So a refusal increments
-- neither `attempts` nor `errors`; it records only that it happened, and that
-- record is what lets the backlog press name the lane holding an ask open
-- (`photoRefusedVendors`) instead of leaving it an inexplicable `already_queued`.
ALTER TABLE enrichment_attempts
  DROP CONSTRAINT enrichment_attempts_last_outcome_check;

ALTER TABLE enrichment_attempts
  ADD CONSTRAINT enrichment_attempts_last_outcome_check
    CHECK (last_outcome IN ('miss', 'match', 'error', 'photo_refused'));
