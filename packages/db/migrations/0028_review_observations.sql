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

-- A non-shop source has no market and sells nothing.
--
-- WHAT THIS CHECK IS FOR, STATED HONESTLY. It is the backstop, not the guard.
-- The two registration paths that exist today are where a reviewer is actually
-- registered, and each now refuses the bad shape before the database is asked:
--
--   * the crawler CLI's `resolveVendor` seeds its row from an adapter, and the
--     adapter type is a union discriminated on `kind` — a `reviewer` adapter
--     that also named a `focus` does not compile. It passes `kind` through, so
--     this constraint is now reachable from that path at all; before, no code
--     could construct a non-vendor row and the CHECK guarded nothing.
--   * `approved-import` reads and writes `kind = 'vendor'` rows only. The
--     r/cubancigars wiki lists SHOPS, and its sync would otherwise flip a
--     reviewer whose host matched a wiki entry to `approval_status='approved'`
--     — a state this CHECK does not constrain, because it says nothing about
--     approval. A constraint cannot be the answer to that; scoping the read is.
--
-- What the CHECK does own is the case neither path can see: a hand-written
-- INSERT, a psql session, a future admin UI. It bites there — registering
-- halfwheel means writing `purchase_linkout = false` explicitly, because the
-- column default is true. That friction is intended: a loud failure at
-- registration beats a silent "buy at halfwheel" link, and beats a reviewer
-- quietly seeding market evidence.
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
  -- to lowercase by the writer. `source` and `url` are the WHOLE of the
  -- provenance, and that is a decision, not an omission.
  --
  -- THERE IS NO `source_id` FK TO `vendors`. One was drafted and removed. The
  -- slug is deliberately not `vendors.name` and not a registry id, because it is
  -- half of the idempotency key and therefore has to outlive registry churn:
  -- renaming a registry row, or deleting and re-adding it, must not make every
  -- review it ever produced re-ingest as a new row. The slug is the key the
  -- adapter registry is already keyed by (`adapters` in @cj/crawler), so it is
  -- the one identifier stable by construction. A nullable, unconstrained link
  -- alongside it buys nothing and costs a contradiction: nothing would have tied
  -- the FK to the slug, so a row could say `source = 'halfwheel'` and point at
  -- the Fox Cigar registry row, and no reader could tell which half was wrong.
  -- ADR-013 also expects agents to bring scores from sites the registry does not
  -- carry at all, so the link is absent for those rows anyway. `source` + `url`
  -- are what a human would use to check the claim, which is the definition of
  -- the evidence. A CONSTRAINED link — one that must agree with `source` — can
  -- return in slice 2 if a reviewer console needs to join on it.
  --
  -- The length bound is not cosmetic, and it is denominated in BYTES.
  -- `review_observations_source_url_key` is a btree, and a btree entry cannot
  -- exceed roughly 2704 BYTES — an unbounded source+url pair does not store
  -- badly, it fails the INSERT on the index. `char_length` would not have
  -- prevented that: a 2000-character URL of percent-decoded multibyte text is
  -- 6000 bytes and passes a character count on its way to an opaque index error.
  -- `octet_length` counts what the index counts, and the domain writer measures
  -- the same way (`Buffer.byteLength`), so a caller gets a validation error it
  -- can act on instead of a constraint violation from the storage layer. 2000 is
  -- the practical URL ceiling every browser and CDN already enforces; 100 is
  -- generous for a slug.
  source text NOT NULL
    CHECK (octet_length(source) > 0 AND octet_length(source) <= 100),
  url text NOT NULL
    CHECK (octet_length(url) > 0 AND octet_length(url) <= 2000),
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
  --
  -- CHARACTERS here, deliberately, where `source` and `url` count bytes. Those
  -- two are bounded by a btree entry's byte ceiling; this one is a licence rule
  -- about how much of someone's writing we hold, and "how much writing" is
  -- counted in characters — a sentence of Spanish is not two-thirds of a
  -- sentence because its accents cost an extra byte each.
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
  -- blend that still carries BLEND-TARGETED evidence must be a deliberate
  -- curation move that re-points those observations first, not a silent loss of
  -- data that costs a crawl to reacquire. NO ACTION rather than RESTRICT for
  -- 0026's reason — it is checked at end of statement, so a single-statement
  -- curation move that clears both still succeeds.
  --
  -- IT PROTECTS THE ROWS THAT NAME THE BLEND, AND ONLY THOSE. A cigar-linked
  -- observation on a leaf of that blend does not reference `blends` at all, so
  -- this constraint never sees it: `cigars.blend_id` is ON DELETE SET NULL
  -- (0026), and deleting the blend would quietly un-parent every leaf and drop
  -- their reviews out of every roll-up above the leaf while leaving the rows
  -- themselves intact. That state is unreachable today only because no code path
  -- deletes a blend — there is no curation move for it, and the registry has no
  -- retire operation — so the guard is DEFERRED, not present. When blend
  -- deletion becomes a real move (slice 2), it needs a pre-check over the
  -- leaves' observations of its own: the FK graph cannot express "no evidence
  -- resolves through this blend", only "no row names it".
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
--   one entity, both populations   cigar 1.5ms · blend 1.6ms · line 3.0ms
--                                  brand 3.4ms · blender 5.4ms
--   fifty entities, one round trip blend 4.6ms · line 5.5ms · brand 7.2ms
--                                  blender 29.2ms
--   materialized table, best case  read 0.1ms · full refresh 14.6ms
--
-- (Re-measured 2026-08-31 after the one-voice-per-journal amendment. Grouping
-- the journal population by author before averaging costs roughly half a
-- millisecond per level — a second aggregation over a set the first one already
-- reduced — and changes none of the conclusions below.)
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
-- The one number that is not comfortable is the fifty-blender batch at 29.2ms,
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
-- `catalog_status = 'active'` is the only filter, and it is DEFINED here so both
-- populations inherit it identically — every branch of every scope view either
-- joins this view or probes it with an EXISTS (the blend-linked branch of
-- `review_observation_scope`, which reaches no leaf and would otherwise miss it
-- entirely). One definition, no branch exempt. An excluded row is non-cigar pollution or
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
--
-- THE BLEND BRANCH CARRIES THE SAME FILTER, AS AN EXISTS. It has to be added
-- explicitly, because that branch never touches `cigar_ancestry` — it walks
-- `blends → lines` directly, so `catalog_status` has no way to reach it. Without
-- the probe the claim above (that applying the filter in one place makes both
-- populations inherit it identically) is false at exactly the blend level: a
-- blend whose every leaf has been merged into another blend, or excluded as
-- pollution, keeps reporting its critic score while its journal score — which
-- resolves through `cigar_ancestry` on both branches — has already gone to null.
-- The pair rendered side by side would then be counts over different
-- populations, which is the one thing the shared ancestry definition exists to
-- prevent. So an emptied blend stops reporting on both sides, together.
--
-- A SEMI-JOIN, NOT A JOIN TO THE LEAVES: the observation is about the blend, and
-- fanning it out over N active leaves would multiply one reviewer's verdict into
-- N rows and inflate every count above it.
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
JOIN lines ln ON ln.id = bl.line_id
WHERE EXISTS (SELECT 1 FROM cigar_ancestry ca WHERE ca.blend_id = ro.blend_id);

-- Every rated smoke, resolved to the same levels. The unrated ones are excluded
-- here rather than in each aggregate query, so nothing downstream has to
-- remember to: a blend with forty logged smokes and two ratings has two rows
-- here, not forty.
--
-- ONE ROW PER RATING, NOT PER VOICE. `user_id` rides along because the domain
-- read collapses each author's ratings to that author's mean before the level
-- averages anything (ADR-013 §3 as amended 2026-08-31: one voice per journal, so
-- a prolific logger counts once). That grouping cannot happen here, because the
-- level it groups at is the caller's question — the same rows are one voice per
-- blend and a different one voice per brand. The view supplies the population;
-- `score-aggregates.ts` decides what a voice is.
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
