-- 0041_service_token_no_expiry — `oauth_access_token.expires_at` becomes
-- nullable; NULL means "no expiry — valid until revoked" (ADR-011 amendment,
-- owner ruling 2026-09-19).
--
-- THE DEFECT. Every expiry on an operator-minted service token is a manual
-- ceremony: an interactive `kubectl exec -it` re-mint, a 1Password edit, an ESO
-- sync and a pod restart that kills whatever session was running in it. The
-- 7-days-left page fired for the dev-env pod's token on 2026-09-19 and bought
-- nothing — the owner's standing precedent for that hands-off pod is
-- non-expiring machine credentials (the release-please PAT, the GCP service
-- account key, the Claude setup token). The forced rotation that bounded an
-- undetected theft is what is given up; the ADR says so plainly rather than
-- pretending the argument vanished.
--
-- ONLY THIS TABLE. Authorization codes, refresh tokens and authorization
-- transactions keep NOT NULL: each is a step in a flow that must time out, and
-- none of them is ever operator-minted.
--
-- THE CHECK IS THE INVARIANT. A row with no expiry must never belong to a
-- refresh family. `family_id IS NULL` is already the durable marker that no
-- grant issued a row (ADR-011), and the grants set `expires_at` on every token
-- they write (`packages/oauth/src/provider.ts`), so no flow-issued row can
-- violate this — existing rows included, since every one of them predates the
-- nullable column. What the constraint forecloses is the future mistake: a
-- refresh rotation that dropped the expiry would mint an immortal token from
-- inside a grant, which is precisely the credential this system does not issue.
--
-- The `oauth_access_token_expires_idx` btree keeps working: Postgres indexes
-- NULLs, and the reads that filter on expiry are written to admit them
-- (`expires_at IS NULL OR expires_at > now()`).

ALTER TABLE oauth_access_token ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE oauth_access_token
  ADD CONSTRAINT oauth_access_token_no_expiry_shape
    CHECK (expires_at IS NOT NULL OR family_id IS NULL);
