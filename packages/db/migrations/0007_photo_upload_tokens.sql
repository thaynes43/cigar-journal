-- 0007_photo_upload_tokens — single-use MCP photo upload links (ADR-007, issue
-- #44 part 2). When the model calls add_smoke_photo without an attached image it
-- mints one of these and hands the URL to the user — the portable fallback for a
-- phone, where in-chat photo attachment is unreliable. The link is bound to
-- (user, smoke, kind?, caption?); only the SHA-256 hash of the token is stored,
-- never the raw token (same at-rest discipline as OAuth tokens in 0003). Single
-- use is enforced by a conditional UPDATE that stamps `used_at`. Rows cascade
-- with the owning user and smoke. Applied by the advisory-locked migrate runner
-- (ADR-003), never drizzle-kit push. Handle names track the MCP file-upload
-- drafts SEP-2356/1306 so the eventual standard swap is mechanical.

CREATE TABLE photo_upload_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,           -- sha256 of the url token; raw token never stored
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  smoke_id    uuid NOT NULL REFERENCES smokes (id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'other'
                CHECK (kind IN ('cigar', 'band', 'construction', 'burn', 'other')),
  caption     text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
