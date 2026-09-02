-- 0035_implied_single_packaging — a bare listing at a single-stick shop IS a
-- single. Backfills the offers three vendors wrote while DESIGN-005 rule 1 read
-- "packaging not stated" over the whole fleet.
--
-- ONE STATEMENT. No table, no column, no index, no constraint. It moves rows the
-- crawler would write this way today, now that `impliedPackaging` ships beside
-- it on the adapter.
--
--
-- THE DEFECT. DESIGN-005 renders an offer whose packaging is not stated under a
-- `Not stated` block, with `packaging not stated` and no per-stick, sorted last
-- and never the headline. That rule was written for a shop whose bare listing
-- genuinely states nothing — Small Batch's grouped parent products, Cuban Lou's
-- bundle-dominated outlet — and applied globally it turned the COMMON case into
-- the exception. foxcigar.com lists a single stick by default and NAMES every
-- other unit, so on 2026-09-02 prod held, for Fox Cigar:
--
--     packaging NULL   6,894      tubo 142   pack 78   tin 36
--     total offers     7,169      2-pack 6   5-pack 6  3-pack 3
--                                 bundle 2   box 2
--
-- 6,894 of 7,169 — the price authority's whole catalogue reading as unpriceable
-- per stick, on the one vendor whose offers are actually displayed (tier 1,
-- `display_enabled`). Cigarworld.de (per-stick EUR on bare names) and J.J. Fox
-- (per-stick GBP; a box listing says `Box of 25`) are the same shop shape and
-- are included; they hold 1 and 1 offers today, so they are here for the seed
-- walks that follow rather than for the rows they have.
--
-- WHY IT IS SAFE, and it is a vendor fact rather than a guess: at these three
-- shops the multi-stick listing is the one that says so in its title. Fox's own
-- 275 packaged rows are proof from inside the same catalogue — every box, pack,
-- tin, tubo and bundle it sells arrived here through the NAME parse, which is
-- why they are excluded below by `packaging IS NULL` without a single literal.
--
--
-- THE POPULATION, measured on prod 2026-09-02 (rows this statement changes):
--
--     Fox Cigar       6,044
--     Cigarworld.de       1
--     J.J. Fox            0   (its one offer states no price)
--     ------------------------
--     total           6,045
--
-- and the 850 Fox rows that are NOT touched, each for a stated reason:
--
--   * 846 have `price IS NULL`. They become singles on the next crawl, not here.
--     A null price has no per-stick, so rewriting their packaging would buy
--     nothing today and would spend the only signal that says "this row predates
--     the fix" — the crawler re-derives them from the page, which is the source
--     of truth for both facts at once.
--   * 4 have `packaging IS NULL` but a `sticks_per_package` the count vocabulary
--     read out of the title: `Undercrown El Tigre 5ct Promo Pack` (5, $65.00) and
--     `Davidoff Premium Selection 12 Count` (12, $312.00). These are the reason
--     `sticks_per_package IS NULL` is in the predicate and not decoration —
--     without it this statement would rewrite a 12-count pack into a $312 single
--     stick, which is the very defect DESIGN-005 exists to prevent, inverted.
--     The guard also makes the SQL agree with the code: `packagingOf` consults
--     the vendor's posture only when NEITHER a label NOR a count was derived.
--
-- No `price > 0` guard, deliberately. `computePricePerStickCents` has none, and
-- `normalizeListing` already refuses to store a non-positive price at all (it
-- reads `<= 0` as a placeholder and writes NULL), so no such row exists in the
-- population — min $3.73, max $2,487.50 on Fox, EUR 9.40 on Cigarworld.
--
--
-- PER-STICK MIRRORS THE WRITER EXACTLY. `computePricePerStickCents`
-- (packages/domain/src/price-observations.ts) is
-- `Math.round(priceCents / sticksPerPackage)` over a `priceCents` that is
-- `Math.round(price * 100)`; at `sticksPerPackage = 1` that is `round(price*100)`,
-- which is what the SET below writes. Every price in the population has scale 2,
-- so the rounding is exact and the half-way rule (JS rounds half up, Postgres
-- half away from zero) can never be reached — and both agree on positives
-- regardless. Currency is not converted and not consulted, exactly as the writer
-- does not consult it: a per-stick figure is in its own row's currency.
--
-- Vendors are named, not id'd, because `vendors.name` is what the adapter
-- resolves its row by (`resolveVendor`) and it is unique in practice across the
-- 13 registry rows. On a database that never held these vendors — a fresh
-- deploy, a restored backup, this package's own test database — the join
-- produces no rows and the statement updates nothing.
--
-- Re-runnable: after the first execution no row in the population still has
-- `packaging IS NULL`, because the first execution is what set them to 'single'.
-- A curator who later re-decides one of these rows keeps that decision, for the
-- same reason.
UPDATE offers o
   SET packaging = 'single',
       sticks_per_package = 1,
       price_per_stick_cents = round(o.price * 100)::int
  FROM vendors v
 WHERE v.id = o.vendor_id
   AND v.name IN ('Fox Cigar', 'Cigarworld.de', 'J.J. Fox')
   AND o.packaging IS NULL
   AND o.sticks_per_package IS NULL
   AND o.price IS NOT NULL;
