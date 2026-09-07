-- 0040_photo_drop_tokens — a drop holds a bounded SET of valid token hashes, not
-- one (ADR-014 as amended 2026-09-07, issue #316). Every open of a live drop
-- overwrote `photo_drops.token_hash`, so the page the user still had open died
-- the moment the model opened the drop again: on 2026-09-07 the re-open landed 64
-- seconds after that phone had uploaded through the link, and its next photo
-- 410'd. The link the model relays sits in the chat transcript regardless, so
-- rotating it shrinks nothing — it only cuts off the page.
--
-- `photo_drop_tokens` is that set: one row per link the drop has handed out,
-- cascading with the drop so expiry and the retention sweep still take every link
-- with it. The at-rest discipline is unchanged — only the SHA-256 is stored, never
-- the raw token (photo_upload_tokens/invites discipline) — which is exactly WHY a
-- continue hands out ANOTHER link rather than the same one: the earlier raw token
-- is not re-derivable. The ceiling lives in @cj/domain
-- (`PHOTO_DROP_TOKENS_MAX`), whose prune runs in the same transaction as the
-- mint; a set with no bound would let one long session accumulate live links
-- without limit.
--
-- The backfill is one row per existing drop carrying the hash it already answers
-- to, stamped with `last_opened_at` (when that link was minted) and falling back
-- to `created_at`, so every link in a user's hand survives the deploy. Then
-- `token_hash` leaves `photo_drops`: a column that meant "the drop's one valid
-- hash" cannot also mean "one of its valid hashes", and leaving it would give the
-- lookup two places to read. Applied by the advisory-locked migrate runner
-- (ADR-003), never drizzle-kit push.

CREATE TABLE photo_drop_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_drop_id uuid NOT NULL REFERENCES photo_drops (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  issued_at     timestamptz NOT NULL DEFAULT now()
);

-- The two reads this table serves: resolve one link (the UNIQUE above), and order
-- a drop's own hashes oldest first, which is the order the prune drops them in.
CREATE INDEX photo_drop_tokens_drop_idx ON photo_drop_tokens (photo_drop_id, issued_at);

INSERT INTO photo_drop_tokens (photo_drop_id, token_hash, issued_at)
SELECT id, token_hash, coalesce(last_opened_at, created_at)
FROM photo_drops;

ALTER TABLE photo_drops DROP COLUMN token_hash;
