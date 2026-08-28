-- 0006_market_substrate — shared schema for the market/crawler track (ADR-006)
-- and the conversational gap-fill flow (owner, 2026-08-28): product photos
-- (ADR-007 product tier), durable crawl-run audit, and the enrichment queue
-- that MCP writes and the crawler drains. Purchases gain a provenance source
-- so conversational rows (including negative-quantity corrections — the
-- ledger is append-only, holdings stay derived) are distinguishable from the
-- ledger import.

CREATE TABLE product_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cigar_id     uuid NOT NULL UNIQUE REFERENCES cigars (id) ON DELETE CASCADE,
  vendor_id    uuid REFERENCES vendors (id),
  source_url   text,
  object_key   text NOT NULL UNIQUE,
  thumb_key    text NOT NULL UNIQUE,
  content_type text NOT NULL,
  width        integer NOT NULL,
  height       integer NOT NULL,
  bytes        integer NOT NULL,
  -- Display gating for future public pages (ADR-007). The authed catalog may
  -- show pending photos; public surfaces require approved.
  rights       text NOT NULL DEFAULT 'pending'
                 CHECK (rights IN ('pending', 'approved', 'suppressed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crawl_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   uuid NOT NULL REFERENCES vendors (id),
  kind        text NOT NULL CHECK (kind IN ('seed', 'offers', 'enrich')),
  status      text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'succeeded', 'failed')),
  stats       jsonb,
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE enrichment_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cigar_id     uuid NOT NULL REFERENCES cigars (id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users (id),
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'in_progress', 'fulfilled', 'exhausted')),
  attempts     integer NOT NULL DEFAULT 0,
  note         text,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enrichment_requests_status_idx ON enrichment_requests (status, created_at);

ALTER TABLE purchases ADD COLUMN source text;
