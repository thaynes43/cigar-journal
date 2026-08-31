-- 0028_review_observations — external review scores, the source-kind
-- discriminator they arrive through, and the two-population aggregate spine
-- (ADR-013, issue #199 slice 1).
--
-- Three parts, in dependency order:
--   1. `vendors.kind` — the crawl registry learns that not every source is a
--      shop (ADR-013 §4: vendor | reviewer | reference).
--   2. `review_observations` — the ADR-009 price-observation pattern applied to
--      reviews: one row per (source, url), scores and links only.
--   3. The aggregate views — one place where "the observations under this
--      blend / line / brand / blender" is defined, for both populations.
--
-- Nothing here fetches anything, and no reviewer or reference source is
-- registered by this migration. Adapters, egress allowlist entries and the
-- surfaces that render these numbers are slice 2.


-- ---------------------------------------------------------------------------
-- PART 1 — SOURCE KINDS (ADR-013 §4)
--
-- A COLUMN ON `vendors`, NOT A PARALLEL TABLE, and the reasoning is worth
-- writing down because the opposite choice was live until it was measured.
--
-- ADR-013 says "the crawl registry distinguishes" three kinds — one registry
-- with a discriminator, not two registries. The table already carries that
-- weight: `name`, `url`, `crawl_enabled` (probe-passed, may we fetch),
-- `approval_status`, `created_at` are the crawl posture of ANY source, and six
-- tables hang off `vendors.id` — `crawl_runs` and `enrichment_attempts` among
-- them, which a reviewer crawl needs verbatim (a run row, a per-source budget).
-- A parallel `review_sources` table would fork both of those, and every
-- politeness/budget mechanism ADR-006 built once would need a second copy that
-- could drift from the first. That is the cost the ADR is avoiding.
--
-- Structurally the fit is already exact: every NOT NULL column on `vendors`
-- either has a DEFAULT or is `name`, so halfwheel can be a row here today with
-- no migration at all. What was missing is not room — it is a way to say what
-- the row IS.
--
-- FOUR COLUMNS ARE MEANINGLESS FOR A NON-SHOP, AND TWO OF THEM DEFAULT THE
-- WRONG WAY. `purchase_linkout` defaults to true, so a reviewer minted today
-- would declare itself a place to buy cigars; `focus` (NC | CC | both) claims a
-- market the source trades in. `focus` is not decorative — `evidencedMarketSql`
-- infers a cigar's market from the focus of every crawl-enabled single-market
-- vendor that STOCKS it, and that inference is the #170 defect's mechanism. A
-- reviewer stocks nothing, so any focus it carried would be a stocking claim
-- from a site with no inventory.
--
-- So the discriminator arrives with a CHECK rather than as documentation: a
-- source that is not a shop has no market and is not a purchase destination,
-- and the database will not hold a row that says otherwise. That closes the
-- `focus IN ('NC','CC')` path in `evidencedMarketSql` and `focusedStockistSql`
-- structurally — no domain change needed for either, because a reviewer can
-- never satisfy the predicate they already carry.
--
-- The default is 'vendor', so every one of today's rows keeps meaning exactly
-- what it meant, and the crawler's `resolveVendor` seed path is unchanged.
ALTER TABLE vendors
  ADD COLUMN kind text NOT NULL DEFAULT 'vendor'
    CHECK (kind IN ('vendor', 'reviewer', 'reference'));

-- A non-shop source has no market and sells nothing. Stated once, here, so it
-- cannot be forgotten at an insert site — including the two that exist today
-- (the crawler CLI's `resolveVendor`, and `approved-import`, which mints every
-- row it adds with focus='CC' and would otherwise hand a reviewer a Cuban
-- market on its first sync).
--
-- It bites at INSERT: registering halfwheel means writing
-- `purchase_linkout = false` explicitly, because the column default is true.
-- That is the intended friction — a loud failure at registration beats a silent
-- "buy at halfwheel" link, and beats a reviewer quietly seeding market evidence.
ALTER TABLE vendors
  ADD CONSTRAINT vendors_non_vendor_source_chk
    CHECK (kind = 'vendor' OR (focus IS NULL AND purchase_linkout = false));


-- ---------------------------------------------------------------------------
-- PART 2 — `review_observations` (ADR-013 §2)
--
-- The ADR-009 price-observation pattern, with one deliberate difference in
-- shape. `offers` is an append-only SERIES: the same vendor pricing the same
-- cigar next week is a new fact, and history is never rewritten. A review is
-- not a series. One reviewer publishes one verdict at one URL; a later crawl of
-- that URL finds the SAME review, and if the score there has changed the
-- reviewer corrected themselves — that is an amendment, not a second data
-- point. So the idempotency key is a real UNIQUE (source, url) and re-ingestion
-- UPDATES in place, where the price path appends and dedupes on a time window.
-- Both rules exist to make a re-crawl create zero duplicates; they differ
-- because the underlying facts differ.
--
-- SCORES, LINKS AND SHORT EXCERPTS ONLY (ADR-013 §2). Reviewer prose is
-- copyrighted and the aggregate is our product, not theirs. The excerpt bound
-- below is a licence rule expressed as a constraint, not a formatting
-- preference — which is why the domain writer REFUSES an over-long excerpt
-- rather than truncating it the way `normalizeNote` truncates a user's note. A
-- truncating writer would happily accept a full review body forever and store
-- its first 400 characters; a refusing one makes the adapter that tried say so.
CREATE TABLE review_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO SAID IT ------------------------------------------------------------
  -- The stable ingestion key: the crawler's ADAPTER SLUG ('halfwheel'), folded
  -- to lowercase by the writer. Deliberately not `vendors.name` and not
  -- `source_id`, even though both identify the same source, because this column
  -- is half of the idempotency key and therefore has to outlive registry churn:
  -- renaming a registry row, or deleting and re-adding it, must not make every
  -- review it ever produced re-ingest as a new row. The slug is the key the
  -- adapter registry is already keyed by (`adapters` in @cj/crawler), so it is
  -- the one identifier that is stable by construction.
  --
  -- The length bound is not cosmetic. `review_observations_source_url_key` is a
  -- btree, and a btree entry cannot exceed roughly 2704 bytes — an unbounded
  -- source+url pair does not store badly, it fails the INSERT on the index.
  -- Bounding both halves turns that into a domain validation error the caller
  -- can act on. 2000 is the practical URL ceiling every browser and CDN already
  -- enforces; 100 is generous for a slug.
  source text NOT NULL
    CHECK (char_length(source) > 0 AND char_length(source) <= 100),
  -- The registry link, when the source is registered. NULLABLE and ON DELETE
  -- SET NULL on purpose: ADR-013 expects agents to bring review scores they find
  -- during enrichment, from sites the crawl registry does not carry, exactly as
  -- ADR-009 opened `offers` to named ad-hoc sources. Losing the registry row
  -- must cost the join, never the observation — the evidence is in `source` and
  -- `url`, which are what a human would use to check the claim.
  source_id uuid REFERENCES vendors (id) ON DELETE SET NULL,
  url text NOT NULL
    CHECK (char_length(url) > 0 AND char_length(url) <= 2000),
  -- The byline, when the source states one. Bounded because an extractor that
  -- picks up a paragraph here has a bug, and an unbounded column would store it.
  reviewer text CHECK (reviewer IS NULL OR char_length(reviewer) <= 200),

  -- WHAT THEY SAID ---------------------------------------------------------
  -- The native scale, and the score EXACTLY as the source wrote it. Both are
  -- kept beside the normalized number rather than being discarded once it is
  -- computed, and that is what makes the normalization safe to be wrong about:
  -- the letter-grade table and the scale factors in @cj/domain's
  -- `review-scores.ts` are a CONVENTION, and a convention that is later judged
  -- badly chosen can be restated and the whole corpus recomputed from these two
  -- columns — no re-crawl, nothing lost.
  --
  -- The CHECK list is the same list as REVIEW_SCALES in review-scores.ts, and
  -- the duplication is deliberate: a scale the code cannot normalize is a row
  -- the database will not hold. `review-scores.test.ts` pins the two together.
  native_scale text NOT NULL
    CHECK (native_scale IN ('0-100', '0-10', '0-5-stars', 'letter')),
  native_score text NOT NULL CHECK (char_length(native_score) > 0),
  -- The single axis every aggregate averages. numeric(5,2), not integer: a 0-10
  -- or 0-5-stars score lands on exact hundredths, and rounding 3.33/5 to an
  -- integer would discard information the source actually stated. The average
  -- of the true values is not less honest than the average of rounded ones.
  --
  -- NOT NULL, with no scoreless case. A review with no number is a fine thing to
  -- read and not a thing this table can hold: the store exists to be aggregated,
  -- and a row that cannot contribute a value would only inflate the sample
  -- counts that ADR-013 §3 requires every rendered aggregate to carry.
  normalized_score numeric(5,2) NOT NULL
    CHECK (normalized_score >= 0 AND normalized_score <= 100),
  -- Publication date, day precision, as reviewers state it. `date` rather than
  -- timestamptz because a publication day has no meaningful instant and storing
  -- one would invent a timezone the source never gave.
  reviewed_at date,
  -- The pull quote. 400 characters is one or two sentences — enough to show what
  -- the score meant, nowhere near enough to substitute for reading the review.
  excerpt text CHECK (excerpt IS NULL OR char_length(excerpt) <= 400),

  -- WHAT IT IS ABOUT -------------------------------------------------------
  -- Linkage at the most specific level the SOURCE states (ADR-013 §2): the leaf
  -- cigar when the reviewer named a vitola, the blend when they reviewed the
  -- blend at large. EXACTLY ONE is set.
  --
  -- The blend of a cigar-linked observation is NOT stored a second time here —
  -- it is derived through `cigars.blend_id` by the scope view in Part 3. Storing
  -- both would put a copy of the ancestry in a row that curation re-parents
  -- (Wave 3 splits collapse buckets and moves leaves between blends), and the
  -- copy would go stale silently, which is the one failure mode an aggregate
  -- cannot reveal.
  --
  -- THE TWO DELETE RULES DIFFER, AND THE ASYMMETRY IS THE POINT.
  -- `cigar_id` CASCADEs, matching every other cigar-linked observation table
  -- (offers, listing_matches, product_photos): cigars are never hard-deleted —
  -- exclusion and merge are tombstones (migration 0013) — so the rule is a
  -- consistency guarantee that in practice never fires. A cigar MERGE does move
  -- these rows: `review_observations` is a ledger slot in `cigar_merges.moves`
  -- alongside offers and listing_matches (the v1 shape sketched in 0020's header
  -- predates this table), so the evidence follows the survivor and comes back on
  -- unmerge. Blend-linked rows are untouched by a cigar merge.
  -- `blend_id` is NO ACTION, matching the registry hierarchy in 0026: retiring a
  -- blend that still carries externally-sourced evidence must be a deliberate
  -- curation move that re-points the observations first, not a silent loss of
  -- data that costs a crawl to reacquire. NO ACTION rather than RESTRICT for
  -- 0026's reason — it is checked at end of statement, so a single-statement
  -- curation move that clears both still succeeds.
  cigar_id uuid REFERENCES cigars (id) ON DELETE CASCADE,
  blend_id uuid REFERENCES blends (id) ON DELETE NO ACTION,
  CONSTRAINT review_observations_target_chk
    CHECK (num_nonnulls(cigar_id, blend_id) = 1),

  -- PROVENANCE -------------------------------------------------------------
  -- The extractor's payload, shapeless, exactly as `offers.raw` carries the
  -- crawler's. It is evidence about how the row was derived, never a place to
  -- park the review body — the excerpt bound above is not avoidable by writing
  -- prose in here, and the domain writer stamps a marker, not content.
  raw jsonb,
  -- `last_seen_at` is liveness, `updated_at` is change. A nightly re-crawl that
  -- finds the same review unchanged bumps the first and leaves the second
  -- alone, so "when did this source last confirm the review is still up" and
  -- "when did the score last move" stay separate questions. Conflating them
  -- would make every row look edited every night.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Idempotent on (source, url) — ADR-013 §2. One reviewer's verdict lives at
  -- one URL, so re-crawling that URL updates the row it already wrote.
  CONSTRAINT review_observations_source_url_key UNIQUE (source, url)
);

-- The aggregate spine reads observations BY TARGET; both indexes are partial
-- because the target CHECK guarantees each row populates exactly one of them,
-- so neither index ever holds a NULL entry it would only have to skip.
CREATE INDEX review_observations_cigar_idx ON review_observations (cigar_id)
  WHERE cigar_id IS NOT NULL;
CREATE INDEX review_observations_blend_idx ON review_observations (blend_id)
  WHERE blend_id IS NOT NULL;
-- "Everything this source has given us" — the per-source budget and coverage
-- reads a reviewer lane needs, and the only index that answers a crawl's own
-- bookkeeping without walking the table.
CREATE INDEX review_observations_source_idx ON review_observations (source, last_seen_at DESC);


-- ---------------------------------------------------------------------------
-- PART 3 — THE AGGREGATE SPINE (ADR-013 §3)
--
-- VIEWS, NOT MAINTAINED TABLES — benchmarked, not assumed
-- (`pnpm --filter @cj/domain bench:scores`, which is checked in beside this).
--
-- Seeded to roughly ten times today's production catalogue — 40 brands, 120
-- lines, 400 blends, 30 blenders, 2,000 cigars, 5,000 review observations and
-- 5,000 rated smokes — on the same embedded Postgres 16 the test suite runs,
-- median of 200 calls:
--
--   one entity, both populations   cigar 1.1ms · blend 1.2ms · line 2.1ms
--                                  brand 2.5ms · blender 4.3ms
--   fifty entities, one round trip blend 3.7ms · line 4.4ms · brand 6.0ms
--                                  blender 27.2ms
--   materialized table, best case  read 0.1ms · full refresh 10.5ms
--
-- (Run-to-run variance is roughly a tenth of each figure; the conclusions below
-- turn on the orders of magnitude, not the digits.)
--
-- The materialized read is genuinely faster — an index probe over stored rows
-- beats recomputing, and it always will. It is not worth what it costs. A
-- maintained table owes a write hook at every review ingest, every
-- saveSmoke / updateSmoke / deleteSmoke, and every curation move that re-parents
-- a leaf or a blend; each hook is a way for a stored number to disagree with the
-- rows under it, and a disagreeing aggregate is invisible — it looks exactly
-- like a correct one. Buying 1ms with that is a bad trade at this volume.
-- ADR-013's "no averages of averages" rule is about recomputing from raw
-- observations, and a view IS that recomputation: it cannot drift, because there
-- is nothing for it to drift from.
--
-- The one number that is not comfortable is the fifty-blender batch at 25.9ms,
-- and it is honest rather than pathological: with 30 blenders seeded, asking for
-- fifty asks for ALL of them, which is a full aggregation of the whole corpus by
-- definition. Revisit materialization at a hundred times this volume, or when a
-- sort or facet by critic score across the whole catalogue lands (slice 2) —
-- that is the read shape a view genuinely struggles with, and the shape a
-- maintained table exists for.
--
-- Two populations, never mixed (the Rotten Tomatoes model): critic over external
-- observations, journal over users' smoke ratings. They share ONE definition of
-- what sits under a level — `cigar_ancestry` — for the same reason
-- catalog-hierarchy.ts shares one: a critic count and a journal count rendered
-- side by side must be counts over the same population, or the pair is a lie
-- about the same blend.

-- The leaf's effective ancestry — one row per active cigar, each level resolved
-- to the most specific known parent.
--
-- COALESCE per level, not a single path down from the blend, because ancestry is
-- partial by design (ADR-012: every level is nullable, unknown stays NULL). A
-- cigar with a brand and no blend still belongs to that brand, and must count
-- there; it simply contributes to no blend. Preferring the blend-derived line
-- and the line-derived brand over the leaf's own columns makes the registry the
-- authority where it has an opinion — `assertCigarAncestry` keeps the two
-- consistent on the write paths, and where they ever disagree the structural
-- parent is the one curation set deliberately.
--
-- `catalog_status = 'active'` is the only filter, and it is applied HERE so both
-- populations inherit it identically. An excluded row is non-cigar pollution or
-- an entry a curator hid; a merged row is a tombstone whose smokes and offers
-- already moved to the survivor. Either contributing would double-count the
-- survivor or let hidden junk score a blend. The consequence is deliberate and
-- worth stating: a rated smoke on an excluded cigar drops out of every
-- catalogue-level aggregate. The smoke is untouched and the journal still shows
-- it — it just stops speaking for a blend the curator said it should not
-- represent.
CREATE VIEW cigar_ancestry AS
SELECT
  c.id AS cigar_id,
  c.blend_id,
  COALESCE(bl.line_id, c.line_id) AS line_id,
  COALESCE(ln.brand_id, c.brand_id) AS brand_id
FROM cigars c
LEFT JOIN blends bl ON bl.id = c.blend_id
LEFT JOIN lines ln ON ln.id = COALESCE(bl.line_id, c.line_id)
WHERE c.catalog_status = 'active';

-- Every external observation, resolved to the levels it counts at.
--
-- A UNION ALL OF THE TWO KINDS OF OBSERVATION, not one row shape with COALESCEd
-- levels, and the reason is a measured factor of eight rather than a matter of
-- taste. The obvious spelling is a pair of LEFT JOINs with
-- `COALESCE(ro.blend_id, ca.blend_id) AS blend_id` — correct, and shorter. But
-- that makes `blend_id` an EXPRESSION, and the planner cannot use an expression
-- as a join key: the blender roll-up, whose key is not a column on this view,
-- degenerated into a nested loop that built 65,000 rows and filtered 64,838 of
-- them away to answer for 162 (20.7ms, against 2-3ms at every other level).
-- Splitting the branches makes `blend_id` a plain column in each — `c.blend_id`
-- on one side, `ro.blend_id` on the other — so a blend restriction pushes down
-- into `cigars_blend_id_idx` and `review_observations_blend_idx` instead.
--
-- The split also states the model more honestly than the COALESCE did: an
-- observation is about a leaf or about a blend, which is precisely what the
-- exactly-one-target CHECK says. The two branches are those two cases, and the
-- CHECK is what guarantees they cannot both fire for one row.
--
-- `cigar_id` is NULL on the blend branch rather than being widened to the
-- blend's leaves: a blend-linked review is about the blend, and presenting it as
-- a particular vitola's score would invent a specificity the reviewer never
-- claimed. It is the mirror of the rule ADR-013 §1 states in the other direction.
--
-- Both joins are INNER. On the leaf branch that is the `catalog_status` filter
-- doing its work — an observation whose cigar is excluded or merged has no
-- active ancestry and drops out, which is the same answer the LEFT-JOIN form
-- reached by producing a row of all-NULL levels that no aggregate could match.
CREATE VIEW review_observation_scope AS
SELECT
  ro.id AS observation_id,
  ro.normalized_score,
  ca.cigar_id,
  ca.blend_id,
  ca.line_id,
  ca.brand_id
FROM review_observations ro
JOIN cigar_ancestry ca ON ca.cigar_id = ro.cigar_id
UNION ALL
SELECT
  ro.id AS observation_id,
  ro.normalized_score,
  NULL::uuid AS cigar_id,
  ro.blend_id,
  bl.line_id,
  ln.brand_id
FROM review_observations ro
JOIN blends bl ON bl.id = ro.blend_id
JOIN lines ln ON ln.id = bl.line_id;

-- Every rated smoke, resolved to the same levels. The unrated ones are excluded
-- here rather than in each aggregate query, so a journal count is always a count
-- of ratings and never of smokes — a blend with forty logged smokes and two
-- ratings has a sample count of two, and says so.
--
-- `visibility` RIDES ALONG BECAUSE THE JOURNAL POPULATION IS A PRIVACY QUESTION,
-- and it is one the Rotten Tomatoes analogy hides. An audience score is built
-- from reviews people published; a journal rating is a private note by default —
-- `users.journal_visibility` is `'private'` unless its owner changed it
-- (migration 0001). Averaging every rating into one community number would
-- publish exactly the entries their authors marked private, and at a sample
-- count of one the "aggregate" IS that person's private rating, printed on a
-- catalogue page.
--
-- So the view carries the flag rather than deciding, and the domain read
-- (`score-aggregates.ts`) picks the population explicitly, defaulting to the
-- non-disclosing one. Filtering here would have foreclosed the other legitimate
-- population — "my own score for this blend" — which is a private read the same
-- flag must not block.
CREATE VIEW smoke_rating_scope AS
SELECT
  s.id AS smoke_id,
  s.user_id,
  u.journal_visibility AS visibility,
  s.rating,
  ca.cigar_id,
  ca.blend_id,
  ca.line_id,
  ca.brand_id
FROM smokes s
JOIN users u ON u.id = s.user_id
JOIN cigar_ancestry ca ON ca.cigar_id = s.cigar_id
WHERE s.rating IS NOT NULL;

-- Cuban-ness at the blend, for the blender gate (ADR-013: "Blender comparison is
-- NC-territory by nature; Cuban roll-ups stop at the marca").
--
-- `blends` has no market column, and inventing one would be a fact nobody
-- established. The derivable signal is the leaf's `cigars.type` — the same
-- signal every other CC/NC rule in the app reads, and exactly what the cigar
-- detail page's blender row already gates on.
--
-- FAIL-CLOSED, TRANSCRIBED FROM THAT GATE. The UI tests `type === 'NC'`
-- positively rather than `!== 'CC'`, because `type` is nullable and most
-- production rows are NULL (890 of 977 when that shipped): the negative form
-- credited a blender on every row nobody had established anything about. The
-- same reasoning lifts to the blend with one addition — a blend has many leaves,
-- and nothing in the schema makes them agree. So a CC leaf disqualifies the
-- blend outright, an NC leaf qualifies it only when no leaf contradicts, and a
-- blend whose leaves are all untyped is simply unknown. Only 'NC' contributes to
-- blender roll-ups; 'CC' and NULL both stop at the marca.
--
-- Written as two EXISTS probes rather than a GROUP BY so the planner can answer
-- it per blend off `cigars_blend_id_idx` when the caller has already narrowed to
-- one blender's blends, instead of grouping the whole leaf table first.
CREATE VIEW blend_market_type AS
SELECT
  bl.id AS blend_id,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM cigars c
      WHERE c.blend_id = bl.id AND c.catalog_status = 'active' AND c.type = 'CC'
    ) THEN 'CC'
    WHEN EXISTS (
      SELECT 1 FROM cigars c
      WHERE c.blend_id = bl.id AND c.catalog_status = 'active' AND c.type = 'NC'
    ) THEN 'NC'
  END AS type
FROM blends bl;
