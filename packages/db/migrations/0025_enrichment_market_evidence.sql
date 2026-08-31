-- 0025_enrichment_market_evidence — read-path indexes for the EVIDENCED MARKET
-- and for per-vendor lane liveness, plus one registry correction (ADR-006
-- amendment 2026-08-30; issues #170, #185, #155).
--
-- SCHEMA-NEUTRAL: no column, no constraint, no catalogue backfill. The evidenced
-- market is DERIVED on every read and never stored, deliberately: writing an
-- inferred market into `cigars.type` — a curator-trust-order, user-visible field
-- — from a signal as coarse as a vendor's focus is manufacturing catalogue
-- facts, which is exactly what that amendment forbids. It would also not
-- self-heal: a backfilled row is frozen at the moment it was computed, while the
-- derived value sharpens with every crawl that links a listing and is overridden
-- outright the moment a curator types the cigar.
--
-- It is NOT write-free. It makes two corrections, both at the bottom of this file:
-- ONE registry row (`vendors.focus` for Cuban Lou's) and ONE catalogue photo (the
-- wrong-market product photo the defect actually wrote). Both are the opposite
-- kind of write from the one forbidden above, and the distinction is the whole
-- point: `cigars.type` would be a catalogue fact INFERRED from a weak signal,
-- while `vendors.focus` is a registry fact about a shop that we simply recorded
-- WRONG, and the photo is not an inference at all — it is a picture of a
-- Nicaraguan cigar sitting in a Cuban cigar's one permanent slot. Correcting a
-- wrong posture, and deleting a wrong artifact, is not manufacturing a fact.

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

-- THE REGISTRY CORRECTION (#170). Cuban Lou's was recorded `focus='CC'` on the
-- strength of its name. Measured against the live catalogue on 2026-08-31, that
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

-- THE ONE ARTIFACT THE DEFECT ACTUALLY PRODUCED (#170). Everything above stops
-- the mis-link happening again; this removes what it already wrote.
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
