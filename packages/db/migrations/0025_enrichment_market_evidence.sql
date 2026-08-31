-- 0025_enrichment_market_evidence — everything the EVIDENCED MARKET lane needs
-- (ADR-006 amendment 2026-08-30; issues #170, #185, #155, #209), in five parts:
--   1. two read-path indexes (evidenced market, per-vendor lane liveness);
--   2. `listing_matches.unmatched_reason` + its backfill — WHY a crawler-
--      unmatched listing is unmatched;
--   3. a widened `enrichment_attempts.last_outcome` CHECK admitting
--      'photo_refused';
--   4. one registry correction (`vendors.focus` for Cuban Lou's);
--   5. one catalogue-photo deletion (the wrong-market photo the defect wrote).
--
-- ONE FILE, AND ON PURPOSE. 0025 is this PR's number in the ledger
-- (.agents/HANDOFF.md: 0025 = #192, 0026–0027 = taxonomy #196, 0028+ = reviews
-- #199), and none of it has deployed. Parts 2 and 3 were briefly written as a
-- separate 0026, which collided with the number ADR-012's taxonomy wave already
-- holds — the #178/#181 collision class the ledger exists to prevent. Extending
-- the number this lane already owns is the fix; taking the next free one would
-- have been the same mistake one seat over.
--
-- THE CATALOGUE IS STILL NOT BACKFILLED, and that is the line this file holds.
-- The evidenced market is DERIVED on every read and never stored: writing an
-- inferred market into `cigars.type` — a curator-trust-order, user-visible field
-- — from a signal as coarse as a vendor's focus is manufacturing catalogue
-- facts, which is exactly what that amendment forbids. It would also not
-- self-heal: a backfilled row is frozen at the moment it was computed, while the
-- derived value sharpens with every crawl that links a listing and is overridden
-- outright the moment a curator types the cigar.
--
-- What the file DOES write is of a different kind, and the distinction is the
-- whole point. `cigars.type` would be a catalogue fact INFERRED from a weak
-- signal. `vendors.focus` is a registry fact about a shop that we simply recorded
-- WRONG. `unmatched_reason` records a decision the crawler MADE and then threw
-- away. And the photo is not an inference at all — it is a picture of a
-- Nicaraguan cigar sitting in a Cuban cigar's one permanent slot. Correcting a
-- wrong posture, recording a decision we already took, and deleting a wrong
-- artifact are none of them manufacturing a fact.

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

-- ---------------------------------------------------------------------------
-- PART 2. WHY A CRAWLER-UNMATCHED LISTING IS UNMATCHED (#170 verify round 2)
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
-- PART 3. A PHOTO REFUSAL IS NOT A LOOK (#209)
-- ---------------------------------------------------------------------------
-- `enrichment_attempts.last_outcome` admitted only the three verdicts a LOOK can
-- reach. A fourth is now recordable: the vendor completed the look, found the
-- cigar and linked it, and was refused the one catalogue-photo slot by the
-- write-authority guard.
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

-- ---------------------------------------------------------------------------
-- PART 4. THE REGISTRY CORRECTION (#170)
-- ---------------------------------------------------------------------------
-- Cuban Lou's was recorded `focus='CC'` on the strength of its name. Measured
-- against the live catalogue on 2026-08-31, that
-- is false: of the 57 untyped cigars it is the sole stockist of, the clear
-- majority are not Cuban — Perdomo, Gurkha, CAO, Rocky Patel, Quorum, Bahia,
-- Graycliff, Camacho, Drew Estate, Alec Bradley, Dominican and Nicaraguan
-- bundles, a listing named "Cohiba & Montecristo DOMINICAN Bundle (Outlet)", and
-- a Xikar punch tool. Genuine Habanos are there too. The shop trades in both.
--
-- This one value is load-bearing because the evidenced market reads it: while the
-- row said 'CC', those 57 listings asserted "CC" about every cigar only this shop
-- stocked, which is where ~39 wrong inferences came from — and each one then
-- excluded Fox (the only live enrich lane) from that cigar's fleet, so nothing
-- could ever contradict it. Recording the shop honestly collapses all of it with
-- no algorithm change: `evidencedMarketSql` already excludes `focus='both'` from
-- the evidence set. Verified by simulation against prod before writing:
-- 821 NC / 56 CC / 7 unknown becomes 822 NC / 0 CC / 62 unknown.
--
-- Guarded on the current value so this is idempotent and cannot silently undo a
-- later deliberate correction. `vendors.name` is the key `resolveVendor` matches
-- on; there is no unique index on it, so this is written to tolerate 0 rows (a
-- fresh database has no such row yet — the adapter seeds 'both' directly).
UPDATE vendors
   SET focus = 'both'
 WHERE name = 'Cuban Lou''s'
   AND focus = 'CC';

-- ---------------------------------------------------------------------------
-- PART 5. THE ONE ARTIFACT THE DEFECT ACTUALLY PRODUCED (#170)
-- ---------------------------------------------------------------------------
-- Everything above stops the mis-link happening again; this removes what it
-- already wrote.
--
-- `Petit Royales Romeo y Julieta` is `type='CC'`. Fox Cigar (`focus='NC'`) walked
-- its own sitemap, trigram-matched its Altadis `Romeo y Julieta 1875 Petit Bully`
-- listing to it, and — because the photo slot is filled straight after the link —
-- put Fox's photograph of a NICARAGUAN cigar into the one permanent slot of a
-- CUBAN one. That is the whole of #170 in a single row: not a debatable link but a
-- picture of the wrong cigar, shown to the owner as the catalogue's own.
--
-- It has to be deleted here because the crawler cannot: `product_photos` is
-- UNIQUE(cigar_id), inserted onConflictDoNothing, and NOTHING in the crawler ever
-- deletes a row. First write wins forever, so the guard added in this PR prevents
-- the next one and is powerless over this one. With the row gone the cigar
-- re-enters the `missing_photos` worklist and a covering source can fill it.
--
-- GUARDED ON `source_url`, not on the cigar name and not on the id, because the
-- source URL is the evidence: it names foxcigar.com and it names the 1875 Petit
-- Bully, so the predicate asserts exactly the thing that makes this photo wrong.
-- A hand-copied uuid would delete whatever occupies that slot at deploy time —
-- including a correct photo a curator uploaded in the meantime, which is the one
-- outcome worse than leaving the bad one. Verified read-only against prod on
-- 2026-08-31: one row matches, id 3a5e2010-…, rights 'pending'.
--
-- The S3/MinIO objects it referenced are deliberately left in place: a migration
-- cannot reach the object store, and an orphaned key costs a few KB, while a
-- delete this file could not verify would be a delete it could not undo.
DELETE FROM product_photos pp
 USING cigars c
 WHERE c.id = pp.cigar_id
   AND c.canonical_name = 'Petit Royales Romeo y Julieta'
   AND pp.source_url =
       'https://foxcigar.com/wp-content/uploads/2026/04/fox-product-romeo-y-julieta-1875-petit-bully-1000034200-0-1.jpg';
