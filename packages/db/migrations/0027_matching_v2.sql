-- 0027_matching_v2 — the write-path half of ADR-012 (issue #196 Wave 2).
--
-- Three things, in order of how much they change:
--   1. `listing_matches.suggested_parse` — the structured parse the resolver
--      computed for a listing it could NOT resolve to one leaf. A triage row
--      that says only "unmatched" makes a curator redo the parse by eye; a
--      triage row carrying "brand=Padrón, line=1964 Anniversary, vitola=Exclusivo,
--      residue='maduro 10 ct'" is a decision waiting to be confirmed.
--   2. `listing_matches.category_path` — the vendor's own breadcrumb trail.
--      `normalizeListing` has always parsed it and thrown it away after the
--      category gate; it is the ONE structured taxonomy signal vendors hand us
--      (ADR-012), so it is now kept as parse evidence next to the parse it fed.
--   3. Two new `unmatched_reason` values, and a re-run of the 0026 backfill.
--
-- Nothing here re-homes a foreign key and nothing here edits a name. The parse
-- columns are evidence, not identity: a curator reads them, the matcher never
-- reads them back. Identity still lives on `cigars`.

-- --------------------------------------------------------------------------
-- 1 + 2. Parse evidence on the match row.
-- --------------------------------------------------------------------------

-- `IF NOT EXISTS` throughout: the migration runner applies each file once, but
-- the suite replays this file directly to assert the backfill below is
-- re-runnable, and a bare ADD COLUMN would abort that replay before it reached
-- the statements actually under test.
ALTER TABLE listing_matches
  -- The parse for a row the resolver could not settle. NULL means "no parse
  -- recorded" — an older row, or a link so clean there was nothing to triage.
  -- Deliberately jsonb and deliberately unindexed: this is a human-facing
  -- explanation read one row at a time from the triage queue, not a query key.
  -- The moment it becomes a query key it should become columns instead.
  ADD COLUMN IF NOT EXISTS suggested_parse jsonb,
  -- Nullable with NO default, and the distinction is load-bearing: NULL means
  -- the breadcrumbs were never captured (every row written before this
  -- migration), `{}` means the vendor's page genuinely offered none. A DEFAULT
  -- '{}' would erase that difference across the whole backlog at once.
  ADD COLUMN IF NOT EXISTS category_path text[];

-- --------------------------------------------------------------------------
-- 3. Two more reasons a crawler row can be unmatched.
--
--   no_anchor — the title yielded no brand anchor at all. THE IMPORTANT ONE:
--               before matching v2, seed mode minted a catalog row from exactly
--               this case, which is how a flat namespace grew a parallel copy of
--               itself per vendor (ADR-012). An unparseable title is now a
--               question for a curator, not a licence to create identity.
--   ambiguous — a brand anchored and more than one leaf under it fit. We know
--               more than `no_match` does and still cannot choose; minting here
--               would be the collapse-bucket failure running in reverse.
--
-- The two 0025 reasons keep their exact meanings. The constraint is dropped and
-- re-added rather than widened in place because Postgres has no ALTER ... CHECK;
-- the name is the one Postgres generated for the inline CHECK in 0025
-- (`<table>_<column>_check`), and IF EXISTS keeps the drop honest if that ever
-- stops being true.
-- --------------------------------------------------------------------------

ALTER TABLE listing_matches
  DROP CONSTRAINT IF EXISTS listing_matches_unmatched_reason_check;

ALTER TABLE listing_matches
  ADD CONSTRAINT listing_matches_unmatched_reason_check
  CHECK (
    unmatched_reason IS NULL
    OR unmatched_reason IN ('market_refusal', 'no_match', 'no_anchor', 'ambiguous')
  );


-- ---------------------------------------------------------------------------
-- THE 0026 BACKFILL, RE-RUN.
--
-- 0026 wrote this down as a debt and this migration is where it comes due:
--
--   "Wave 1 leaves the INSERT paths (cigar-resolution, the crawler's listing
--    match) unwired, so a cigar created after this migration lands with
--    `brand_id` NULL. Wave 2 wires those paths AND RE-RUNS THE TWO UPDATES
--    BELOW to sweep up whatever accumulated in between."
--
-- The gap is real: every cigar minted by `add_cigar`, `record_purchase`,
-- `save_smoke` or a crawl between 0026 shipping and this migration landing
-- carries a brand string and no `brand_id`. This sweeps them up.
--
-- WIDER THAN THE TWO UPDATES, deliberately. 0026 named the two UPDATEs because
-- at the time it was written the only gap it foresaw was rows carrying an
-- ALREADY-KNOWN brand string. But a cigar minted in the gap can just as easily
-- carry a brand string no `brands` row covers — `add_cigar` takes free text —
-- and for that row the UPDATE alone finds nothing to link it to and it stays
-- unlinked forever. So the mint (and its collision pass) runs again too. That is
-- the same mechanical rule 0026 applied, applied to the rows that arrived since,
-- and it mints brands ONLY: still no lines, no blends, no blenders, no name
-- edits, no attachment of the unbranded rows. All of that remains Wave 3
-- curation, which needs evidence and an audit trail a migration cannot produce.
--
-- Each statement is unchanged from 0026 apart from this comment, and each was
-- written to be re-runnable — ON CONFLICT DO NOTHING, `IS NULL` guards, and a
-- collision pass whose every subquery reads the pre-statement snapshot. Their
-- idempotency is not taken on faith: `taxonomy-backfill.test.ts` replays this
-- file and asserts the second application changes nothing.
-- ---------------------------------------------------------------------------

INSERT INTO brands (name, slug, aliases)
WITH source AS (
  SELECT btrim(c.brand) AS name, count(*) AS cigar_count
  FROM cigars c
  WHERE nullif(btrim(c.brand), '') IS NOT NULL
  GROUP BY btrim(c.brand)
),
slugged AS (
  SELECT
    s.name,
    s.cigar_count,
    btrim(regexp_replace(lower(s.name), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-') AS slug,
    btrim(regexp_replace(lower(regexp_replace(normalize(s.name, NFKD), U&'[\0300-\036F]', '', 'g')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-') AS folded_slug
  FROM source s
),
addressable AS (
  SELECT * FROM slugged WHERE slug <> '' AND octet_length(slug) <= 2000
),
canonical AS (
  SELECT DISTINCT ON (slug) slug, name AS canonical_name
  FROM addressable
  ORDER BY slug, cigar_count DESC, name ASC
),
alias_set AS (
  SELECT a.slug, array_agg(DISTINCT v ORDER BY v) AS aliases
  FROM addressable a
  CROSS JOIN LATERAL (VALUES (a.slug), (a.folded_slug)) AS t(v)
  WHERE v <> ''
  GROUP BY a.slug
)
-- DO NOTHING skips the conflicting row WHOLE, aliases included, so a matching key
-- contributed only by a spelling that arrives after the brand row already exists
-- is dropped rather than merged in. Kept as 0026 wrote it rather than upgraded to
-- a DO UPDATE that unions the arrays, and the reason is authority: this statement
-- is a mechanical sweep, and merging keys into a brand a curator has since edited
-- would let it silently restore an alias that curator deliberately removed. The
-- gap it leaves is narrow — it needs two spellings that share a slug but fold
-- differently, i.e. differently-accented letters in identical positions — and the
-- fix for it is a curated alias (`addLineAliases`-style, with an audit row), not
-- a wider migration.
SELECT c.canonical_name, c.slug, COALESCE(al.aliases, '{}')
FROM canonical c
LEFT JOIN alias_set al ON al.slug = c.slug
ON CONFLICT (slug) DO NOTHING;

-- An alias must resolve to exactly ONE brand or the anchor probe is worse than
-- no index at all — and matching v2 now actually runs that probe, so this pass
-- has stopped being preparation and become load-bearing. Identity wins: the
-- brand owning a key as its slug keeps it, every other brand drops it, and a key
-- no brand owns but two claim is dropped from both. A missing key lets the
-- matcher fall through to triage; an ambiguous key anchors it confidently on the
-- wrong marca.
UPDATE brands b
SET aliases = COALESCE((
  SELECT array_agg(t.a ORDER BY t.a)
  FROM unnest(b.aliases) AS t(a)
  WHERE NOT EXISTS (SELECT 1 FROM brands o WHERE o.id <> b.id AND o.slug = t.a)
    AND NOT EXISTS (
      SELECT 1 FROM brands o
      WHERE o.id <> b.id
        AND t.a = ANY (o.aliases)
        AND NOT EXISTS (SELECT 1 FROM brands k WHERE k.slug = t.a)
    )
), '{}')
WHERE EXISTS (
  SELECT 1
  FROM unnest(b.aliases) AS t(a)
  JOIN brands o ON o.id <> b.id AND (o.slug = t.a OR t.a = ANY (o.aliases))
);

-- The sweep 0026 named. `brand_id IS NULL` means a re-run only ADDS links and
-- can never overwrite one a curator has since corrected. `updated_at` stays
-- untouched: a structural link is not an edit to the cigar's content, and
-- bumping it would churn recency ordering across the whole catalog.
--
-- THAT GUARANTEE IS ABOUT LINKS, NOT ABOUT BRAND RETIREMENT — measured, not
-- assumed. Firing this backfill again AFTER Wave 3 curation has begun would
-- re-mint a brand a curator had merged away and deleted, because the mint above
-- reads the free-text `cigars.brand` column, which the merge does not clear. The
-- resurrected row is empty (the link guard correctly leaves the cigar on the
-- brand the curator chose) and a further run changes nothing, so this is a
-- cosmetic resurrection rather than an idempotency break — but it is the reason
-- this re-run is scoped to closing the Wave 1→2 gap and is not a statement that
-- the backfill may be replayed at any time forever. A backfill that must survive
-- curation needs a tombstone the mint respects, which is a Wave 3 design
-- decision and deliberately not made here.
UPDATE cigars c
SET brand_id = b.id
FROM brands b
WHERE c.brand_id IS NULL
  AND nullif(btrim(c.brand), '') IS NOT NULL
  AND b.slug = btrim(regexp_replace(lower(btrim(c.brand)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-');

-- Still a near no-op in production, and still worth running: 0026 predicted the
-- brand-image job would start writing rows between the two migrations, and the
-- `IS NULL` guard makes running it early free either way.
UPDATE brand_images bi
SET brand_id = b.id
FROM brands b
WHERE bi.brand_id IS NULL
  AND b.slug = bi.brand_slug;
