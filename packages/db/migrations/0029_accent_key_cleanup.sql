-- 0029_accent_key_cleanup — the last of the Wave 3 accent residue (issue #196).
--
-- PR #220 taught the mint path to fold accents, but only in two of the three
-- places a mint writes a key. Slugs folded, and the alias-ADD path folded; the
-- NAME-DERIVED alias key kept emitting `brandSlug(name)` beside `fold(name)`.
-- So the three marcas Wave 3 minted after #220 wear a clean folded slug and a
-- junk key next to it, and one marca minted BEFORE #220 still wears the
-- transcription as its slug — which is its live URL.
--
-- The code side is fixed in this PR (`aliasKeysFor`, packages/domain/src/
-- taxonomy-writes.ts): a mint now emits exactly one name-derived key, the folded
-- one. This migration repairs the rows that were written before that.
--
-- Two parts, and PART 1 MUST RUN FIRST — its rule reads `slug`, and part 2
-- changes one. Ordering them the other way would make part 1 strip the very key
-- part 2 needs kept.
--
--   1. Strip the legacy transcription key from every registry row that does not
--      wear it as a slug — the three Wave 3 marcas, plus anything the curation
--      lane mints in the same shape before this ships.
--   2. Rename `Padrón` from the transcription `padr-n` to the folded `padron`,
--      keeping `padr-n` as an ordinary alias so its old URLs still resolve.
--
-- Data only. No schema change, no index, no constraint.


-- ---------------------------------------------------------------------------
-- PART 1 — STRIP THE MINT-TIME TRANSCRIPTION KEYS
--
-- THE RULE IS GENERAL, NOT A LIST OF THREE IDS. The three rows issue #196
-- flagged are the ones this hits today (verified against production: they are
-- the only accented registry rows in the database besides Padrón), but the
-- defect is in a code path the curation lane is actively running, so any marca
-- minted from an accented name between now and this deploy accrues the same
-- key. A rule catches those; three UPDATEs by id do not.
--
-- The two key expressions are transcribed from migration 0026 character for
-- character, and they must stay that way: `legacy` is the `brandSlug()`
-- transcription (no accent folding — `Padrón` → `padr-n`), `folded` is the
-- matching key (NFKD, drop the combining marks, then slug — `Padrón` →
-- `padron`). Postgres has no `\p{M}`, hence the explicit
-- combining-diacritical-marks block, and the explicit character class rather
-- than `a-z`, which a non-C collation can widen to swallow accented letters.
--
-- THREE GUARDS, each removing a way this could do harm:
--
--   `legacy <> folded`  — an ASCII name derives one key by both rules, so there
--     is nothing to strip and the row must not be touched.
--
--   `slug <> legacy`    — the row wears the transcription as its ADDRESS. That
--     key is a live URL, not junk, and it stays. This is what spares Padrón
--     here so part 2 can rename it deliberately.
--
--   `NOT IN (retained)` — a transcription that WAS an address and has since
--     been renamed off. Nothing owns it as a slug any more, so the guard above
--     no longer sees it, but old links still arrive on it and the read path
--     (`brandSlugMatch`, packages/domain/src/catalog-hierarchy.ts) resolves them
--     through exactly this key. Without this list a second execution of this
--     file would strip `padr-n` straight back off the row part 2 just renamed.
--     Wave 5 renames the rest of the cohort and grows this list as it goes.
--
-- Idempotent: after one run the key is gone, so `= ANY(aliases)` is false and a
-- re-run matches no rows. Safe on a database where none of these rows exist —
-- the predicate simply selects nothing.
--
-- The last-key guard mirrors the one the alias editor enforces: an empty
-- `aliases` array is a row no probe can ever return. It cannot fire here (a row
-- whose only key is the transcription would have to have a different slug, which
-- means it was minted with the folded key too), and it is cheap insurance
-- against a hand-edited row.

UPDATE brands b
SET aliases = array_remove(b.aliases, btrim(regexp_replace(lower(btrim(b.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')),
    updated_at = now()
WHERE btrim(regexp_replace(lower(btrim(b.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
      <> btrim(regexp_replace(lower(regexp_replace(normalize(b.name, NFKD), U&'[\0300-\036F]', '', 'g')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
  AND b.slug <> btrim(regexp_replace(lower(btrim(b.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
  AND btrim(regexp_replace(lower(btrim(b.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-') = ANY (b.aliases)
  AND btrim(regexp_replace(lower(btrim(b.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
      NOT IN (SELECT s FROM (VALUES ('padr-n')) AS retained_legacy_slugs(s))
  AND COALESCE(array_length(array_remove(b.aliases, btrim(regexp_replace(lower(btrim(b.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')), 1), 0) >= 1;

-- The same rule at the other three levels. Nothing matches today — every
-- accented registry row in production is a brand — but `aliasKeysFor` is one
-- function serving all four mints, so the defect was never brand-specific and
-- neither is the repair. The retained-slug list is brand-only on purpose: no
-- line, blend or blender slug has ever been renamed, so none of them has a
-- legacy address to protect.

UPDATE lines l
SET aliases = array_remove(l.aliases, btrim(regexp_replace(lower(btrim(l.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')),
    updated_at = now()
WHERE btrim(regexp_replace(lower(btrim(l.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
      <> btrim(regexp_replace(lower(regexp_replace(normalize(l.name, NFKD), U&'[\0300-\036F]', '', 'g')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
  AND l.slug <> btrim(regexp_replace(lower(btrim(l.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
  AND btrim(regexp_replace(lower(btrim(l.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-') = ANY (l.aliases)
  AND COALESCE(array_length(array_remove(l.aliases, btrim(regexp_replace(lower(btrim(l.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')), 1), 0) >= 1;

UPDATE blends bl
SET aliases = array_remove(bl.aliases, btrim(regexp_replace(lower(btrim(bl.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')),
    updated_at = now()
WHERE btrim(regexp_replace(lower(btrim(bl.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
      <> btrim(regexp_replace(lower(regexp_replace(normalize(bl.name, NFKD), U&'[\0300-\036F]', '', 'g')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
  AND bl.slug <> btrim(regexp_replace(lower(btrim(bl.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
  AND btrim(regexp_replace(lower(btrim(bl.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-') = ANY (bl.aliases)
  AND COALESCE(array_length(array_remove(bl.aliases, btrim(regexp_replace(lower(btrim(bl.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')), 1), 0) >= 1;

UPDATE blenders bd
SET aliases = array_remove(bd.aliases, btrim(regexp_replace(lower(btrim(bd.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')),
    updated_at = now()
WHERE btrim(regexp_replace(lower(btrim(bd.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
      <> btrim(regexp_replace(lower(regexp_replace(normalize(bd.name, NFKD), U&'[\0300-\036F]', '', 'g')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
  AND bd.slug <> btrim(regexp_replace(lower(btrim(bd.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')
  AND btrim(regexp_replace(lower(btrim(bd.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-') = ANY (bd.aliases)
  AND COALESCE(array_length(array_remove(bd.aliases, btrim(regexp_replace(lower(btrim(bd.name)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')), 1), 0) >= 1;


-- ---------------------------------------------------------------------------
-- PART 2 — PADRÓN GETS ITS SLUG BACK
--
-- `Padrón` was minted by 0026, before the mint folded, so its slug is the
-- transcription `padr-n` and `/cigars/brands/padr-n` is the marca's live URL —
-- unreadable, unguessable, and the only brand address in the catalog that is.
-- Every marca minted since #220 already has the clean key; this gives the one
-- that predates it the same.
--
-- SCOPED TO ONE ROW, NOT TO THE COHORT. The Wave 5 rename+redirect owns the
-- general case, and a slug rename is the one edit here that can strand a URL, so
-- it is spelled out rather than derived: `padr-n` is matched literally, the name
-- is checked, and the target slug must be free. Production has exactly one row
-- in this cohort today, so a general rule and this one would do the same work —
-- which is precisely why the general rule buys nothing and the narrow one cannot
-- surprise anyone.
--
-- `padr-n` STAYS IN `aliases`. That is what keeps the old URL alive: part 1's
-- retained list spares it, and `brandSlugMatch` (packages/domain/src/
-- catalog-hierarchy.ts) resolves `?brand=padr-n` — where `/cigars/brands/padr-n`
-- 307s to — through the alias when no brand owns that slug. It also carries
-- `?brand=Padrón`, the pre-wave DESIGN-003 name link, since the stored slug rule
-- turns that spelling into `padr-n` too. After this migration the key is no
-- longer derived from the row's name, so it is an ordinary alias the curation
-- tools may edit; before this PR's `aliasKeysFor` fix it would have been treated
-- as identity and refused removal.
--
-- `brand_images.brand_slug` is NOT touched and does not need to be: it is keyed
-- on brandSlug() of the free-text `cigars.brand` column, joined to the registry
-- by `brand_id` since 0026, so the poster tile follows the row rather than its
-- slug.
--
-- Idempotent: the second run finds no row at slug `padr-n`. Safe where the brand
-- does not exist, and safe where something else already owns `padron` — the NOT
-- EXISTS makes the migration a no-op instead of violating `brands_slug_key` and
-- rolling the deploy back.

UPDATE brands
SET slug = 'padron',
    updated_at = now()
WHERE slug = 'padr-n'
  AND name = 'Padrón'
  AND NOT EXISTS (SELECT 1 FROM brands other WHERE other.slug = 'padron');
