-- 0005_smoke_photos — review-bound smoke photos (ADR-007, issue #44 part 1).
-- One store, two bindings: this is the SmokePhoto binding — 1→N per smoke, owned
-- by the smoke's user, with a `kind` and optional caption. Object/thumb keys are
-- unguessable and unique; authorization is enforced at the serving route, not by
-- key secrecy (ADR-007). Only pipeline output (normalized JPEG, EXIF stripped)
-- reaches the bucket. Applied by the advisory-locked migrate runner (ADR-003),
-- never drizzle-kit push. ProductPhoto arrives later with the crawler.

CREATE TABLE smoke_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  smoke_id     uuid NOT NULL REFERENCES smokes (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id),
  kind         text NOT NULL DEFAULT 'other'
                 CHECK (kind IN ('cigar', 'band', 'construction', 'burn', 'other')),
  caption      text,
  object_key   text NOT NULL UNIQUE,
  thumb_key    text NOT NULL UNIQUE,
  content_type text NOT NULL,
  width        integer NOT NULL,
  height       integer NOT NULL,
  bytes        integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX smoke_photos_smoke_idx ON smoke_photos (smoke_id, created_at);
