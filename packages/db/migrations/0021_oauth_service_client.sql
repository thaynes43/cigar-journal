-- 0021_oauth_service_client — mark an oauth_client as an OPERATOR-MINTED service
-- client (ADR-011). A service token is an ordinary long-lived
-- `oauth_access_token` row; nothing about validation or the grants changes. What
-- this column buys is the ability to answer "which clients exist because an
-- operator minted a credential, not because a browser flow registered one?" —
-- `registerClient` (DCR) never sets it, so every flow-registered client stays
-- false and the service-token CLI's `list` has an honest filter.
ALTER TABLE oauth_client
  ADD COLUMN is_service boolean NOT NULL DEFAULT false;

-- One service client per consumer name, enforced by the database rather than by
-- CLI convention: a rotation must reuse the consumer's client_id so a leak stays
-- attributable and revocable in isolation. Partial, so DCR clients (which may
-- share a client_name — "ChatGPT" registers repeatedly) are unaffected. Covers
-- zero existing rows, so it builds instantly; ADD COLUMN ... NOT NULL DEFAULT is
-- rewrite-free on PG 11+.
CREATE UNIQUE INDEX oauth_client_service_name_idx
  ON oauth_client (client_name) WHERE is_service;
