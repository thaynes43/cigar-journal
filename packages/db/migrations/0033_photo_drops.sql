-- 0033_photo_drops — a smoke's photos are collected before the smoke exists
-- (ADR-014). `add_smoke_photo` binds to a smokeId, but a live smoke is journaled
-- as ONE save_smoke at the end, so until that save there is nothing to attach to
-- and every photo taken during the smoke has to be re-sent afterwards.
--
-- A photo drop is a link bound to the USER's smoke in progress: opened when the
-- first photo appears, multi-use for its 48 hours, claimed by the save that
-- follows. `photo_drops` holds the SHA-256 of its URL token (the raw token is
-- never stored, so re-opening rotates it and the earlier link dies — the same
-- at-rest discipline as photo_upload_tokens/invites), plus `smoke_id` +
-- `claimed_at` once a save has claimed it. `staged_smoke_photos` is shaped
-- exactly like smoke_photos but bound to a drop; the claim MOVES rows across,
-- keeping the id and the keys, so a claimed photo's object_key carries a `drop/`
-- prefix (keys were never load-bearing — authorization is at the route, ADR-007).
--
-- Two FK rules carry the lifecycle. `photo_drops.user_id` cascades: a deleted
-- account leaves no drops. `photo_drops.smoke_id` is ON DELETE SET NULL, which is
-- what CLOSES a claimed drop when its smoke is deleted — uploads refused, the
-- remainder swept — rather than deleting the record of the claim. Applied by the
-- advisory-locked migrate runner (ADR-003), never drizzle-kit push.

CREATE TABLE photo_drops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  smoke_id    uuid REFERENCES smokes (id) ON DELETE SET NULL,
  claimed_at  timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One open drop per user is a read, not a constraint: the newest unclaimed,
-- unexpired drop is what `open_photo_drop` hands back, so this index serves the
-- predicate that decides between reuse and a fresh insert.
CREATE INDEX photo_drops_user_open_idx ON photo_drops (user_id, created_at DESC)
  WHERE claimed_at IS NULL;
CREATE INDEX photo_drops_smoke_idx ON photo_drops (smoke_id) WHERE smoke_id IS NOT NULL;

CREATE TABLE staged_smoke_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id      uuid NOT NULL REFERENCES photo_drops (id) ON DELETE CASCADE,
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

-- The drop's page and the claim both read a drop's staged photos oldest first.
CREATE INDEX staged_smoke_photos_drop_idx ON staged_smoke_photos (drop_id, created_at);
