-- 0026_taxonomy_registries — the reference entities above the leaf (ADR-012,
-- issue #196 Wave 1): `brands` → `lines` → `blends`, plus `blenders` and the
-- `blend_blenders` join, and the nullable FKs that let a `cigars` row hang off
-- them.
--
-- The leaf stays `cigars`, redefined as one blend in one vitola — the thing you
-- light. All thirteen FK-bearing tables keep pointing at `cigars.id`; nothing is
-- re-homed. This migration only ADDS structure: every existing read and write
-- path keeps working against the free-text `brand`/`line` columns, which stay
-- until Wave 5 retires them.
--
-- Every level is nullable and nothing is invented (the house rule ADR-012
-- reaffirms). A cigar with an unknown line hangs directly off its brand; unknown
-- stays NULL. Structure stores known facts in the right shape — it never
-- fabricates them.
--
-- Wave 1 is deliberately mechanical. It mints one brand per distinct free-text
-- brand string and links the cigars that already carry that string. It mints NO
-- lines, NO blends and NO blenders, and it edits no names: attaching the 565
-- unbranded rows, minting lines/blends and splitting the collapse buckets is
-- Wave 3 curation, done on evidence and audited.

-- Brand — the marca. Absorbs `brand_images` (Wave 5 retires `brand_slug`).
CREATE TABLE brands (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  -- The URL/facet key. Derived with the SAME rule as brandSlug() in
  -- @cj/domain catalog-browse.ts: lowercase, every run of non-[a-z0-9] to a
  -- single dash, dashes trimmed off both ends. Agreement is the point — this
  -- slug must equal the one today's brand URLs and `brand_images.brand_slug`
  -- already resolve through, so the fold is NOT applied here.
  --
  -- That rule does not strip accents, so `Padrón` slugs to `padr-n`. It is ugly
  -- and it is deliberate: changing it would break live URLs and orphan every
  -- `brand_images` row. The accent-folded spelling rides in `aliases` instead,
  -- which is where matching reads it. A prettier slug with a redirect is a
  -- Wave 4/5 decision, not a Wave 1 one.
  slug       text NOT NULL UNIQUE,
  -- MATCHING KEYS, NOT DISPLAY TEXT. Every entry is already folded and slugged
  -- (`padron`, `h-upmann`, `ryj`) — the exact output of the normalization the
  -- matcher runs over an incoming vendor string — so matching v2 (Wave 2) can
  -- anchor a listing with one exact-match probe against the GIN index below.
  -- The display spelling of this brand lives in `name`; a source-case string
  -- stored here would simply never be probed for. Each key resolves to exactly
  -- one brand — the backfill's collision pass enforces that.
  aliases    text[] NOT NULL DEFAULT '{}',
  country    text,
  website    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Line — a family within a brand (Drew Estate → Liga Privada).
CREATE TABLE lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NO ACTION, not CASCADE. Retiring a marca must not silently take its lines —
  -- and through them its blends — with it: emptying a brand is a curation
  -- decision with an audit trail, never a side effect of one DELETE landing on
  -- the wrong row. NO ACTION rather than RESTRICT because NO ACTION is checked
  -- at the END of the statement: it refuses an accidental delete exactly as
  -- RESTRICT does, while a deliberate curation move that empties the brand in
  -- the same statement — `WITH d AS (DELETE FROM lines WHERE brand_id = $1)
  -- DELETE FROM brands WHERE id = $1` — still succeeds. RESTRICT fires per row
  -- and would reject that too.
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE NO ACTION,
  name        text NOT NULL,
  slug        text NOT NULL,
  -- Matching keys, not display text — the same convention as `brands.aliases`.
  aliases     text[] NOT NULL DEFAULT '{}',
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Scoped to the brand, not global: two brands may both have a `reserva`.
  CONSTRAINT lines_brand_id_slug_key UNIQUE (brand_id, slug),
  -- The support key any composite FK from `cigars (brand_id, line_id)` would
  -- need to reference. Minted now because the table is empty and the index is
  -- therefore free; whether that FK is ever added is a separate question the
  -- ancestry note below answers. Adding it later would mean building a unique
  -- index over a populated table under lock.
  CONSTRAINT lines_id_brand_id_key UNIQUE (id, brand_id)
);

-- Blend — the recipe within a line (Liga Privada → No. 9). Wrapper variants
-- marketed as separate products (Padron Maduro/Natural) are distinct blends,
-- because that is how they are sold.
CREATE TABLE blends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NO ACTION for the same reason as `lines.brand_id` above: a line that still
  -- has blends is not deletable by accident, but a single-statement curation
  -- move that clears both still works.
  line_id     uuid NOT NULL REFERENCES lines(id) ON DELETE NO ACTION,
  name        text NOT NULL,
  slug        text NOT NULL,
  -- Matching keys, not display text — the same convention as `brands.aliases`.
  aliases     text[] NOT NULL DEFAULT '{}',
  -- Filler, binder and wrapper are a REQUIRED DOCUMENTATION TARGET on every
  -- blend (owner ruling 2026-08-31): they are the data that lets similar blends
  -- correlate to similar tasting notes. Required-target means enrichment pursues
  -- them and a curation worklist tracks the gaps — never that a value is
  -- invented, so the columns stay nullable and NULL means "not yet known".
  wrapper     text,
  binder      text,
  filler      text,
  strength    text,
  blend_notes text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blends_line_id_slug_key UNIQUE (line_id, slug),
  -- The support key for a composite FK from `cigars (line_id, blend_id)`, minted
  -- now for the same reason as `lines_id_brand_id_key`.
  CONSTRAINT blends_id_line_id_key UNIQUE (id, line_id)
);

-- Blender — the person or team credited with a blend. Global, not per-brand: a
-- blender's work spans brands, and collaborations exist (ADR-012 amendment).
-- Cuban blends typically credit no individual; those blends simply have no
-- `blend_blenders` row, and blender-level views roll up NC-side only.
CREATE TABLE blenders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  -- Matching keys, not display text — the same convention as `brands.aliases`.
  aliases    text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- CASCADE here, unlike the hierarchy above, and the difference is the point: a
-- credit edge is not an entity. It carries no facts of its own, so a credit that
-- outlived the blend or the blender it joins would be pure garbage rather than
-- something a curator could rescue. Nothing is lost by dropping it with either
-- end.
CREATE TABLE blend_blenders (
  blend_id   uuid NOT NULL REFERENCES blends(id) ON DELETE CASCADE,
  blender_id uuid NOT NULL REFERENCES blenders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blend_id, blender_id)
);

-- Alias lookup is the anchor step of matching v2 (Wave 2), so it gets an index
-- now rather than a second migration later. GIN with the default array_ops
-- answers the containment probe (`aliases @> ARRAY[...]`) these registries exist
-- to serve — which is an EXACT-match probe, and therefore only useful because
-- the alias convention stores pre-normalized matching keys rather than display
-- spellings.
CREATE INDEX brands_aliases_gin ON brands USING gin (aliases);
CREATE INDEX lines_aliases_gin ON lines USING gin (aliases);
CREATE INDEX blends_aliases_gin ON blends USING gin (aliases);
CREATE INDEX blenders_aliases_gin ON blenders USING gin (aliases);
-- The reverse edge: "every blend this blender is credited on". The PK already
-- covers the blend → blenders direction.
CREATE INDEX blend_blenders_blender_idx ON blend_blenders (blender_id);

-- The leaf's structural ancestry. All three are NULLABLE — an unknown level
-- stays NULL — and all three ON DELETE SET NULL: retiring a registry row must
-- never delete a cigar, a smoke, or a purchase.
--
-- ANCESTRY CONSISTENCY IS NOT ENFORCED HERE. The rule — a cigar's `line_id`
-- must belong to its `brand_id`, and its `blend_id` to its `line_id` — lives in
-- the domain layer as `assertCigarAncestry` (@cj/domain,
-- packages/domain/src/cigar-ancestry.ts). Wave 1 defines and tests it and calls
-- it from NOTHING; Wave 2 wires it into the identity write paths. Until then the
-- invariant is stated and unpoliced, which is safe only because Wave 1 also
-- writes no `line_id` or `blend_id` at all.
--
-- Not a composite FK — and the reason is about ON DELETE SET NULL, not about
-- timing. A composite FK is checked at the END of the statement, so it would NOT
-- fight a curation move that re-parents brand, line and blend together; the
-- earlier version of this comment claimed otherwise and was wrong. The real
-- objection is that `FOREIGN KEY (brand_id, line_id) REFERENCES lines
-- (brand_id, id) ON DELETE SET NULL` nulls the WHOLE column pair when a line is
-- retired, discarding a brand link that is still true — and that the default
-- MATCH SIMPLE skips the check entirely whenever either column is NULL, which is
-- the common shape here (brand known, line not). It would destroy a fact in the
-- case where it fires and check nothing in the case where it does not.
--
-- Not a trigger either: the surfaces need to know WHICH level disagrees, as a
-- field-level ValidationError the caller can act on, and a per-row trigger would
-- fight the Wave 3 curation paths that re-parent a row mid-statement.
--
-- The support keys a composite FK would need (`lines (id, brand_id)`, `blends
-- (id, line_id)`) are minted above regardless: they are free on an empty table
-- and they keep the option open without committing to it.
ALTER TABLE cigars
  ADD COLUMN brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  ADD COLUMN line_id  uuid REFERENCES lines(id)  ON DELETE SET NULL,
  ADD COLUMN blend_id uuid REFERENCES blends(id) ON DELETE SET NULL,
  -- `canonical_name` becomes a maintained projection. `freeform` (every row
  -- today) means the string is authoritative and renameCigar edits it directly;
  -- `composed` means the name is recomposed from brand + line + blend + vitola +
  -- edition and renameCigar edits the parts instead. Wave 2 writes the first
  -- `composed` row; nothing in Wave 1 does.
  ADD COLUMN name_source text NOT NULL DEFAULT 'freeform'
    CHECK (name_source IN ('freeform', 'composed'));

CREATE INDEX cigars_brand_id_idx ON cigars (brand_id);
CREATE INDEX cigars_line_id_idx ON cigars (line_id);
CREATE INDEX cigars_blend_id_idx ON cigars (blend_id);

-- Fold `brand_images` onto the registry. `brand_slug` keeps working exactly as
-- it does today — it stays NOT NULL and UNIQUE, and every current reader is
-- untouched; Wave 5 retires it once `brand_id` carries the joins. The new column
-- is nullable because a brand image may be resolved for a slug that has no
-- catalog cigar behind it yet.
ALTER TABLE brand_images
  ADD COLUMN brand_id uuid REFERENCES brands(id) ON DELETE SET NULL;

CREATE INDEX brand_images_brand_id_idx ON brand_images (brand_id);


-- ---------------------------------------------------------------------------
-- BACKFILL — mechanical only.
--
-- One brands row per distinct non-blank trimmed `cigars.brand` (36 in
-- production on 2026-08-31), then the brand_id links. It mints nothing else and
-- it edits nothing else: no lines, no blends, no blenders, no name changes, no
-- attachment of the 565 unbranded rows. Every one of those is Wave 3 curation,
-- which needs evidence and an audit trail this migration cannot produce.
--
-- Every statement below is idempotent (ON CONFLICT / IS NULL guards / a
-- snapshot-based alias pass), so the migration is safe to replay and the test
-- suite can observe it directly.
--
-- That is load-bearing beyond replay safety. Wave 1 leaves the INSERT paths
-- (cigar-resolution, the crawler's listing match) unwired, so a cigar created
-- after this migration lands with `brand_id` NULL. Wave 2 wires those paths AND
-- RE-RUNS THE TWO UPDATES BELOW to sweep up whatever accumulated in between.
-- Both are written for that: each fills only rows whose link is still NULL, so a
-- re-run adds links and can never overwrite one a curator has since corrected.
-- ---------------------------------------------------------------------------

-- The slug rule is spelled out with an explicit character class rather than the
-- `a-z` range: inside a bracket expression Postgres interprets ranges by
-- collation, and under a non-C collation `a-z` can swallow accented letters —
-- which would silently disagree with the JS brandSlug() this must match.
--
-- HOW EXACT THAT AGREEMENT IS, precisely: this transcription equals brandSlug()
-- for every character whose lowercase lands in ASCII, with two measured
-- exceptions. JS `toLowerCase()` applies the full Unicode mapping while
-- Postgres `lower()` under C ctype maps only A-Z, so `İ` (U+0130) and the Kelvin
-- sign `K` (U+212A) slug to `i` and `k` in JS and to the empty string here —
-- meaning a brand made only of those would be minted by neither side, since the
-- empty slug is skipped below as unaddressable. No catalog brand contains
-- either character. The divergence is pinned in
-- packages/domain/src/brand-slug-agreement.test.ts so it stays documented rather
-- than becoming a surprise.
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
    -- The MATCHING key for this spelling: NFKD-decompose, drop the combining
    -- marks (`Padrón` → `Padron`), then apply the same slug rule — `fold()` from
    -- the crawler (packages/crawler/src/core/wikidata.ts) composed with
    -- brandSlug(). That composition is exactly what matching v2 will run over an
    -- incoming vendor string, which is the whole reason it is what gets stored
    -- in `aliases`. It is deliberately NOT the slug: brandSlug() is the STORED
    -- key and never folds, folding is for matching only.
    -- (`fold()` strips \p{M}; Postgres regex has no such class, so this uses the
    -- combining-diacritical-marks block, which is the part that matters for the
    -- Latin-script brand names this catalog holds.)
    btrim(regexp_replace(lower(regexp_replace(normalize(s.name, NFKD), U&'[\0300-\036F]', '', 'g')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-') AS folded_slug
  FROM source s
),
-- A brand string of pure punctuation slugs to the empty string and could not be
-- addressed by URL or joined to a brand image. It is not a brand; skip it.
--
-- The length bound is the same kind of guard, and it is the difference between a
-- bad row and a failed deploy. `brands_slug_key` is a btree, and a btree entry
-- cannot exceed roughly 2704 bytes — an over-long slug does not skip its row, it
-- ABORTS THIS MIGRATION on the index insert and rolls the whole deploy back. The
-- catalog's longest brand is well under 40 bytes and the MCP schemas now cap
-- `brand` at 200 characters, but a migration must not sit one oversized
-- free-text value away from refusing to apply. Over-long spellings are skipped
-- exactly like punctuation-only ones: unaddressable either way.
addressable AS (
  SELECT * FROM slugged WHERE slug <> '' AND octet_length(slug) <= 2000
),
-- Distinct spellings can collapse onto one slug (`Davidoff` / `davidoff`). They
-- are one brand, so the most-used spelling becomes the canonical name — ties
-- broken alphabetically to keep the result deterministic — and the losers
-- become aliases rather than being dropped.
canonical AS (
  SELECT DISTINCT ON (slug) slug, name AS canonical_name
  FROM addressable
  ORDER BY slug, cigar_count DESC, name ASC
),
-- ALIAS CONVENTION — `aliases` holds MATCHING KEYS, never display text.
-- Every entry is the output of the same fold-then-slug the matcher applies to an
-- incoming string, so matching v2's anchor step (Wave 2) is a single exact-match
-- probe against the GIN index — `aliases @> ARRAY[key]` — with no per-row
-- normalization to defeat it. The display spelling lives in `name` and nowhere
-- else; seeding source-case strings here would have made every one of those
-- probes miss.
--
-- A brand's own slug is one of its matching keys, so it is included rather than
-- excluded: the probe alone then resolves any spelling the brand answers to,
-- without a second lookup against `slug`.
alias_set AS (
  SELECT a.slug, array_agg(DISTINCT v ORDER BY v) AS aliases
  FROM addressable a
  CROSS JOIN LATERAL (VALUES (a.slug), (a.folded_slug)) AS t(v)
  WHERE v <> ''
  GROUP BY a.slug
)
SELECT c.canonical_name, c.slug, COALESCE(al.aliases, '{}')
FROM canonical c
LEFT JOIN alias_set al ON al.slug = c.slug
ON CONFLICT (slug) DO NOTHING;

-- An alias must resolve to exactly ONE brand, or the anchor probe it exists to
-- serve is worse than no index at all. Two brands can legitimately mint the same
-- matching key: `Padrón` slugs to `padr-n` and folds to `padron`, while a plain
-- `Padron` spelling elsewhere in the catalog mints its own brand whose SLUG is
-- `padron`. Both then claim `padron`.
--
-- Identity wins. The brand that owns a key as its slug keeps it; every other
-- brand drops it. A key that no brand owns as a slug but that two or more brands
-- claim as an alias is dropped from all of them — an ambiguous key is worth less
-- than a missing one, because a missing key lets the matcher fall through to its
-- fuzzy stages instead of anchoring confidently on the wrong marca.
--
-- Re-runnable: every subquery reads the pre-statement snapshot, so the outcome
-- does not depend on row order, and a second run finds nothing left to strip.
UPDATE brands b
SET aliases = COALESCE((
  SELECT array_agg(t.a ORDER BY t.a)
  FROM unnest(b.aliases) AS t(a)
  -- Another brand owns this key as its slug.
  WHERE NOT EXISTS (SELECT 1 FROM brands o WHERE o.id <> b.id AND o.slug = t.a)
    -- Or nobody owns it and more than one brand claims it.
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

-- Link each cigar to its brand. Matching on the derived slug IS the
-- case- and trim-insensitive match (the rule lowercases and collapses
-- punctuation), and it is the same key the rows were minted under, so every row
-- that contributed a brand gets linked. `updated_at` is deliberately NOT
-- touched: this is a structural link, not an edit to the cigar's content, and
-- bumping it would churn recency ordering across the whole catalog.
UPDATE cigars c
SET brand_id = b.id
FROM brands b
WHERE c.brand_id IS NULL
  AND nullif(btrim(c.brand), '') IS NOT NULL
  AND b.slug = btrim(regexp_replace(lower(btrim(c.brand)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-');

-- `brand_images.brand_slug` is already brandSlug(brand), so this is a direct
-- equality — the agreement the slug rule above exists to preserve.
--
-- A NO-OP in production today: `brand_images` holds no rows, so this links
-- nothing. It runs anyway because it is the statement Wave 2 re-runs once the
-- brand-image job starts writing, and because the `IS NULL` guard makes running
-- it early free.
UPDATE brand_images bi
SET brand_id = b.id
FROM brands b
WHERE bi.brand_id IS NULL
  AND b.slug = bi.brand_slug;
