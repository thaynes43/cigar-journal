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
  -- Every other spelling this brand is known by: accent-folded variants
  -- (`Padron`), abbreviations (`RYJ`), and vendor spellings. Matching v2
  -- (Wave 2) anchors a listing on a brand alias before anything else.
  aliases    text[] NOT NULL DEFAULT '{}',
  country    text,
  website    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Line — a family within a brand (Drew Estate → Liga Privada).
CREATE TABLE lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}',
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Scoped to the brand, not global: two brands may both have a `reserva`.
  CONSTRAINT lines_brand_id_slug_key UNIQUE (brand_id, slug)
);

-- Blend — the recipe within a line (Liga Privada → No. 9). Wrapper variants
-- marketed as separate products (Padron Maduro/Natural) are distinct blends,
-- because that is how they are sold.
CREATE TABLE blends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id     uuid NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
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
  CONSTRAINT blends_line_id_slug_key UNIQUE (line_id, slug)
);

-- Blender — the person or team credited with a blend. Global, not per-brand: a
-- blender's work spans brands, and collaborations exist (ADR-012 amendment).
-- Cuban blends typically credit no individual; those blends simply have no
-- `blend_blenders` row, and blender-level views roll up NC-side only.
CREATE TABLE blenders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  aliases    text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blend_blenders (
  blend_id   uuid NOT NULL REFERENCES blends(id) ON DELETE CASCADE,
  blender_id uuid NOT NULL REFERENCES blenders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blend_id, blender_id)
);

-- Alias lookup is the anchor step of matching v2 (Wave 2), so it gets an index
-- now rather than a second migration later. GIN over the array answers the
-- containment probe (`aliases @> ARRAY[...]`) these registries exist to serve.
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
-- must belong to its `brand_id`, and its `blend_id` to its `line_id` — is
-- enforced in the domain layer by `assertCigarAncestry` in
-- @cj/domain (packages/domain/src/cigar-ancestry.ts), called by every write
-- path that sets these columns. Deliberately not a trigger and not a composite
-- FK: the check needs to report WHICH level disagrees as a field-level
-- ValidationError the caller can act on, and the curation paths that re-parent
-- a row in Wave 3 need to move brand, line and blend in one statement without
-- fighting a per-row trigger firing mid-update.
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
-- Both statements are idempotent (ON CONFLICT / IS NULL guards), so the
-- migration is safe to replay and the test suite can observe it directly.
-- ---------------------------------------------------------------------------

-- The slug rule is spelled out with an explicit character class rather than the
-- `a-z` range: inside a bracket expression Postgres interprets ranges by
-- collation, and under a non-C collation `a-z` can swallow accented letters —
-- which would silently disagree with the JS brandSlug() this must match.
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
    -- NFKD decomposition then drop the combining marks: `Padrón` → `Padron`.
    -- The same normalization as `fold()` in the crawler
    -- (packages/crawler/src/core/wikidata.ts), which already codifies the split
    -- this migration follows: brandSlug() is the STORED key and never folds,
    -- folding is for MATCHING only. So the folded spelling is seeded as an
    -- ALIAS — where matching reads it — and never as the name or the slug.
    -- (`fold()` strips \p{M}; Postgres regex has no such class, so this uses the
    -- combining-diacritical-marks block, which is the part that matters for the
    -- Latin-script brand names this catalog holds.)
    regexp_replace(normalize(s.name, NFKD), U&'[\0300-\036F]', '', 'g') AS folded
  FROM source s
),
-- A brand string of pure punctuation slugs to the empty string and could not be
-- addressed by URL or joined to a brand image. It is not a brand; skip it.
addressable AS (
  SELECT * FROM slugged WHERE slug <> ''
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
alias_set AS (
  SELECT a.slug, array_agg(DISTINCT v ORDER BY v) AS aliases
  FROM addressable a
  JOIN canonical c ON c.slug = a.slug
  CROSS JOIN LATERAL (VALUES (a.name), (a.folded)) AS t(v)
  WHERE v <> c.canonical_name
  GROUP BY a.slug
)
SELECT c.canonical_name, c.slug, COALESCE(al.aliases, '{}')
FROM canonical c
LEFT JOIN alias_set al ON al.slug = c.slug
ON CONFLICT (slug) DO NOTHING;

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
UPDATE brand_images bi
SET brand_id = b.id
FROM brands b
WHERE bi.brand_id IS NULL
  AND b.slug = bi.brand_slug;
