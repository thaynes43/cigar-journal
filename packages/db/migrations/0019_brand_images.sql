-- 0019_brand_images — the third photo binding of ADR-007: a brand-level image
-- sourced from Wikidata/Wikimedia Commons, used ONLY as a wall-cover fallback
-- where no member cigar has a servable product photo (issue #127, DESIGN-003
-- §Images item 5).
--
-- Keyed on `brand_slug` = brandSlug(brand), the same derived key the URL contract
-- and getBrand already resolve through. Brand is free text with no brands table
-- and this migration deliberately does not create one — the slug IS the join key.
--
-- Two axes are kept separate on purpose:
--   status — the LOOKUP outcome (did we find and download an image?)
--   rights — the DISPLAY gate, the same three values as product_photos
-- One row per slug, so the table doubles as the negative cache: a `no_match` row
-- stops the job re-querying Wikidata for 30 days, and a `suppressed` row is a
-- tombstone the job must never resurrect.
--
-- The servable-complete CHECK makes "bytes with no attribution" unrepresentable:
-- a Wikimedia image may only be stored alongside the credit the UI must render
-- with it. Enforced by shape rather than by convention, since the attribution is
-- a licence condition, not a nicety.

CREATE TABLE brand_images (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_slug           text NOT NULL UNIQUE,
  -- The member spelling the job resolved from, for the review UI (the slug alone
  -- reads badly in a curator list).
  brand_name           text NOT NULL,
  status               text NOT NULL DEFAULT 'no_match'
    CHECK (status IN ('resolved', 'ambiguous', 'no_match', 'no_image', 'blocked', 'error')),
  rights               text NOT NULL DEFAULT 'pending'
    CHECK (rights IN ('pending', 'approved', 'suppressed')),
  -- Provenance + attribution as first-class columns, not a blob: every one of
  -- these is read by a serving surface or the curator console.
  wikidata_qid         text,
  entity_url           text,
  commons_file         text,
  -- The Commons FILE DESCRIPTION page — the link a CC-BY credit points at, not
  -- the raw upload URL.
  source_url           text,
  license_code         text,
  license_name         text,
  license_url          text,
  artist               text,
  -- The exact one-liner the UI renders, computed once at write time so no surface
  -- re-derives it (and so a later format change cannot silently drop the author).
  credit_line          text,
  attribution_required boolean NOT NULL DEFAULT true,
  object_key           text UNIQUE,
  thumb_key            text UNIQUE,
  content_type         text,
  width                integer,
  height               integer,
  bytes                integer,
  -- Every candidate entity considered when the lookup was ambiguous: qid, label,
  -- description, P18 filename, score, reasons. The curator picks from this.
  candidates           jsonb,
  note                 text,
  -- The crawl-pod run that last touched the row. No crawl_runs row exists for
  -- this job (crawl_runs.vendor_id is NOT NULL and Wikidata is not a vendor —
  -- ADR-006); grouping on this text id is the run history if one is ever wanted.
  run_id               text,
  checked_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_images_servable_complete CHECK (
    object_key IS NULL OR (
      thumb_key IS NOT NULL
      AND content_type IS NOT NULL
      AND source_url IS NOT NULL
      AND license_name IS NOT NULL
      AND status = 'resolved'
    )
  )
);

-- The job's work-list read: "rows whose status is stale enough to re-check".
CREATE INDEX brand_images_status_idx ON brand_images (status, checked_at);
