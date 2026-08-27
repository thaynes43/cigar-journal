-- 0001_init — extensions, tables, indexes for the Cigar Journal core.
-- Applied by the advisory-locked migrate runner (ADR-003), never drizzle-kit push.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- users -----------------------------------------------------------------------
-- Minimal now; the auth slice aligns Better Auth onto this table (ADR-004).
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  display_name       text,
  role               text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  journal_visibility text NOT NULL DEFAULT 'private' CHECK (journal_visibility IN ('private', 'public')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- cigars ----------------------------------------------------------------------
-- canonical_name is the required identity; uniqueness is trigram-fuzzy, not a
-- constraint (curator merge reconciles duplicates). tobacco is shapeless JSONB.
CREATE TABLE cigars (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name     text NOT NULL,
  brand              text,
  line               text,
  edition            text,
  vitola_name        text,
  length_inches      numeric,
  ring_gauge         integer,
  type               text CHECK (type IN ('NC', 'CC')),
  manufacturer       text,
  factory            text,
  production_country text,
  tobacco            jsonb,
  blend_notes        text,
  release_year       integer,
  verification       text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('verified', 'unverified')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cigars_canonical_name_trgm ON cigars USING gin (canonical_name gin_trgm_ops);
CREATE INDEX cigars_brand_trgm ON cigars USING gin (brand gin_trgm_ops);

-- smokes ----------------------------------------------------------------------
-- The central aggregate (ADR-002). cigar_id is NOT NULL (catalog invariant).
CREATE TABLE smokes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id),
  cigar_id            uuid NOT NULL REFERENCES cigars (id),
  smoked_at           timestamptz,
  smoked_at_source    text NOT NULL DEFAULT 'unknown'
                        CHECK (smoked_at_source IN ('user', 'system-finalized', 'legacy-document', 'unknown')),
  smoked_at_precision text CHECK (smoked_at_precision IN ('minute', 'approximate', 'day')),
  context             jsonb,
  overall_descriptors text[] NOT NULL DEFAULT '{}',
  draw                text CHECK (draw IN ('excellent', 'good', 'fair', 'poor')),
  burn                text CHECK (burn IN ('excellent', 'good', 'fair', 'poor')),
  smoke_output        text CHECK (smoke_output IN ('low', 'medium', 'high')),
  construction_notes  text,
  strength            text,
  body                text,
  liked               boolean,
  rating              integer CHECK (rating IS NULL OR (rating >= 0 AND rating <= 100)),
  impression          text,
  journal_title       text,
  journal_narrative   text,
  provenance_source   text NOT NULL CHECK (provenance_source IN ('llm-conversation', 'manual', 'legacy-import')),
  provenance_client   text,
  original_markdown   text,
  version             integer NOT NULL DEFAULT 1,
  search              tsvector GENERATED ALWAYS AS
                        (to_tsvector('english', coalesce(journal_narrative, '') || ' ' || coalesce(impression, ''))) STORED,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX smokes_user_idx ON smokes (user_id);
CREATE INDEX smokes_cigar_idx ON smokes (cigar_id);
CREATE INDEX smokes_user_smoked_at_idx ON smokes (user_id, smoked_at DESC);
CREATE INDEX smokes_search_idx ON smokes USING gin (search);
CREATE INDEX smokes_overall_descriptors_idx ON smokes USING gin (overall_descriptors);

-- smoke_progression -----------------------------------------------------------
-- One row per Progression Entry; append-only; ordinal unique per smoke.
CREATE TABLE smoke_progression (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  smoke_id             uuid NOT NULL REFERENCES smokes (id) ON DELETE CASCADE,
  ordinal              integer NOT NULL,
  stage                text,
  approximate_position numeric
                         CHECK (approximate_position IS NULL OR (approximate_position >= 0 AND approximate_position <= 1)),
  descriptors          text[] NOT NULL DEFAULT '{}',
  specific_descriptors text[] NOT NULL DEFAULT '{}',
  verbatim             text,
  UNIQUE (smoke_id, ordinal)
);

CREATE INDEX smoke_progression_smoke_idx ON smoke_progression (smoke_id);
CREATE INDEX smoke_progression_descriptors_idx ON smoke_progression USING gin (descriptors);

-- vendors ---------------------------------------------------------------------
CREATE TABLE vendors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  url             text,
  focus           text CHECK (focus IN ('NC', 'CC', 'both')),
  crawl_enabled   boolean NOT NULL DEFAULT false,
  display_enabled boolean NOT NULL DEFAULT false,
  approval_status text NOT NULL DEFAULT 'unapproved' CHECK (approval_status IN ('owner-added', 'approved', 'unapproved')),
  approval_note   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- listing_matches -------------------------------------------------------------
CREATE TABLE listing_matches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   uuid NOT NULL REFERENCES vendors (id),
  listing_key text NOT NULL,
  cigar_id    uuid REFERENCES cigars (id),
  status      text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('auto', 'confirmed', 'unmatched')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, listing_key)
);

-- offers ----------------------------------------------------------------------
-- Append-only crawl observations; a price/stock time series.
CREATE TABLE offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid NOT NULL REFERENCES vendors (id),
  listing_url      text,
  seen_at          timestamptz NOT NULL DEFAULT now(),
  price            numeric,
  currency         text,
  in_stock         boolean,
  listing_match_id uuid REFERENCES listing_matches (id),
  raw              jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX offers_vendor_idx ON offers (vendor_id);
CREATE INDEX offers_listing_match_idx ON offers (listing_match_id);

-- purchases -------------------------------------------------------------------
CREATE TABLE purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id),
  cigar_id        uuid NOT NULL REFERENCES cigars (id),
  purchased_at    date,
  quantity        integer,
  packaging       text,
  box_date        date,
  humidor_at      date,
  price_per_stick numeric,
  vendor_id       uuid REFERENCES vendors (id),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX purchases_user_idx ON purchases (user_id);
CREATE INDEX purchases_cigar_idx ON purchases (cigar_id);

-- idempotency_keys ------------------------------------------------------------
-- Written in the mutation's own transaction; (user, client_request_id) UNIQUE.
CREATE TABLE idempotency_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id),
  client_request_id   text NOT NULL,
  tool                text NOT NULL,
  request_fingerprint text NOT NULL,
  smoke_id            uuid REFERENCES smokes (id),
  result              jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_request_id)
);

-- audit_log -------------------------------------------------------------------
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES users (id),
  actor          text NOT NULL CHECK (actor IN ('web', 'mcp', 'import', 'system')),
  action         text NOT NULL,
  smoke_id       uuid REFERENCES smokes (id),
  before         jsonb,
  after          jsonb,
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_smoke_idx ON audit_log (smoke_id);
CREATE INDEX audit_log_user_idx ON audit_log (user_id);
