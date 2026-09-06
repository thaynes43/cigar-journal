-- 0039_brand_abbreviation_aliases — the marca abbreviations a smoker actually
-- speaks, as brand matching keys (issue #303).
--
-- ONE STATEMENT. No table, no column, no index, no constraint. It adds keys to
-- rows that already exist, and adds nothing at all to a database whose registry
-- does not hold the brand.
--
--
-- THE DEFECT. `search_cigars("La Flor Dominicana La Nox")` returned five other
-- LFD cigars and neither row named `LFD La Nox`. Trigram similarity scores a
-- name whole, so the query that spells the brand out cannot reach the row that
-- abbreviates it — and the siblings that spell it out the same way the query
-- did score higher than the cigar the user named. The reverse direction had the
-- same hole: `HdM` matched no Hoyo de Monterrey name at all.
--
-- `brands.aliases` is where that fact belongs. It already holds every other
-- spelling a marca answers to (0026 seeded the accent-folded ones), and it is
-- brand-level, so one row here answers for every cigar under it — the reason
-- issue #303 rules out a per-cigar alias table.
--
--
-- WHAT IS SEEDED, and nothing is guessed: seven abbreviations in common trade
-- use, each expanded to exactly one marca. A brand with no registry row is
-- skipped by the join — on prod today that is A.J. Fernandez and Pinar del Rio,
-- neither of which the catalog holds. `hdm` and `ryj` are already curated onto
-- their rows and this is a no-op for them.
--
-- ALIAS CONVENTION, unchanged since 0026: entries are MATCHING KEYS — already
-- folded and slugged, never display text — because the probe is an exact
-- containment test against `brands_aliases_gin`. All seven are ASCII lowercase,
-- so they are their own folded form.
--
-- TWO GUARDS, both about the one property this column must keep — A KEY
-- RESOLVES TO EXACTLY ONE BRAND (`anchorByAlias` drops a key two rows claim, so
-- a collision does not mis-anchor, it silently stops working):
--
--   * the target must be UNAMBIGUOUS — exactly one brand answers to the
--     expansion's slug, by `slug` or by an alias of its own, so an accented or
--     duplicated marca cannot take the key twice;
--   * the key must be UNCLAIMED — no other brand already owns it as a slug or
--     an alias.
--
-- Re-running changes nothing: an alias already present fails the `NOT (... =
-- ANY ...)` test, which is what keeps this idempotent alongside the runner's
-- own ledger.
--
-- `af` and `rp` are two characters, below the crawler's MIN_ANCHOR_KEY_LENGTH
-- floor of three, so they cannot anchor a vendor title mid-string; they are
-- reachable from search, which matches a LEADING window of a spoken mention and
-- holds its own two-character floor.
WITH abbreviation (brand_slug, alias) AS (
  VALUES
    ('la-flor-dominicana', 'lfd'),
    ('a-j-fernandez',      'ajf'),
    ('romeo-y-julieta',    'ryj'),
    ('hoyo-de-monterrey',  'hdm'),
    ('pinar-del-rio',      'pdr'),
    ('rocky-patel',        'rp'),
    ('arturo-fuente',      'af')
)
UPDATE brands b
SET aliases = (
      SELECT array_agg(DISTINCT a ORDER BY a)
      FROM unnest(b.aliases || abbreviation.alias) AS t(a)
    ),
    updated_at = now()
FROM abbreviation
WHERE (b.slug = abbreviation.brand_slug OR abbreviation.brand_slug = ANY (b.aliases))
  AND (
    SELECT count(*) FROM brands o
    WHERE o.slug = abbreviation.brand_slug OR abbreviation.brand_slug = ANY (o.aliases)
  ) = 1
  AND NOT (abbreviation.alias = ANY (b.aliases))
  AND NOT EXISTS (
    SELECT 1 FROM brands o
    WHERE o.id <> b.id AND (o.slug = abbreviation.alias OR abbreviation.alias = ANY (o.aliases))
  );
