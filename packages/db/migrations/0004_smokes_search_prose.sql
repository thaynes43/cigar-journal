-- 0004_smokes_search_prose — widen the smokes FTS vector to cover all journal
-- prose, not just narrative + impression. Imported smokes keep journal_narrative
-- null and carry their content in original_markdown, so a text search for a word
-- that only appears there (e.g. "burn" in "Burn started off beautifully") missed
-- them entirely (production finding). Regenerate the generated tsvector over
-- journal_title, journal_narrative, impression, construction_notes, and
-- original_markdown, weighted by signal strength (title/impression highest, raw
-- imported markdown lowest). Progression verbatim stays covered by the EXISTS
-- clause in queryMySmokes (@cj/domain), not this column.
--
-- A generated column's expression can't be altered in place, so drop and re-add;
-- the GIN index drops with the column and is recreated. Applied by the
-- advisory-locked migrate runner (ADR-003), never drizzle-kit push.

ALTER TABLE smokes DROP COLUMN search;

ALTER TABLE smokes
  ADD COLUMN search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(journal_title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(impression, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(journal_narrative, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(construction_notes, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(original_markdown, '')), 'D')
  ) STORED;

CREATE INDEX smokes_search_idx ON smokes USING gin (search);
