-- 0022_invites — invite-gated registration (ADR-010). Replaces
-- BOOTSTRAP_ADMIN_EMAILS as the standing registration gate; the allowlist
-- narrows to a first-run-only bootstrap plus the session-create admin re-assert.
-- Only the SHA-256 hash of the invite token is stored, never the raw token (same
-- at-rest discipline as photo_upload_tokens/0007 and OAuth tokens/0003).
-- There is DELIBERATELY no role column: an invite has no role field to escalate.
-- Redemption never writes users.role, so the users.role DEFAULT 'user' applies.
-- `email` is citext (as users.email is, since 0001), so invite→user matching is
-- case-insensitive by construction.
CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text        NOT NULL UNIQUE,  -- sha256 of the link token; raw token never stored
  email       citext      NOT NULL,         -- the invite is bound to one address
  invited_by  uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  -- Two-phase redemption: redeemed_at is stamped by the atomic burn, redeemed_by
  -- only after sign-up succeeds. (redeemed_at NOT NULL, redeemed_by NULL) means
  -- in flight; a crash there leaves the invite spent — fails closed, never
  -- reusable. Hence no (redeemed_at IS NULL) = (redeemed_by IS NULL) CHECK.
  redeemed_at timestamptz,
  redeemed_by uuid        REFERENCES users (id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invites_invited_by_idx ON invites (invited_by);

-- At most one live invite per address, so /settings never lists rival links.
CREATE UNIQUE INDEX invites_open_email_uniq ON invites (email)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;
