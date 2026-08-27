-- 0003_oauth — OAuth 2.1 authorization-server storage (ADR-004/005). The app is
-- the authorization server for MCP: dynamically-registered clients (RFC 7591),
-- authorization transactions + single-use PKCE codes, short-lived audience-bound
-- access tokens (RFC 8707), and rotating refresh tokens with revocation chains.
-- Tokens (access, refresh, codes) are stored ONLY as SHA-256 hashes — no
-- plaintext at rest — so an out-of-process resource server (the MCP adapter)
-- validates a bearer token via @cj/db alone. Same conventions as 0001/0002:
-- gen_random_uuid ids, timestamptz throughout, snake_case columns.

-- oauth_client ----------------------------------------------------------------
-- One row per DCR-registered client. client_id is the public handle; a
-- client_secret is stored hashed and only for confidential clients. Public PKCE
-- clients (ChatGPT, Claude Code, Codex) register with auth method 'none' and
-- carry no secret. redirect_uris are exact-match validated at /authorize.
CREATE TABLE oauth_client (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  text NOT NULL UNIQUE,
  client_secret_hash         text,
  client_name                text,
  redirect_uris              jsonb NOT NULL,
  grant_types                jsonb NOT NULL,
  response_types             jsonb NOT NULL,
  scope                      text,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  created_at                 timestamptz NOT NULL DEFAULT now()
);

-- oauth_authorization ---------------------------------------------------------
-- A pending authorization request awaiting consent. Created by /authorize ONLY
-- for an authenticated session — the user_id is captured server-side here, never
-- from a request argument (ADR-004). Consumed by the consent decision; short-lived.
CREATE TABLE oauth_authorization (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             text NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  scopes                jsonb NOT NULL,
  resource              text NOT NULL,
  state                 text,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL,
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_authorization_expires_idx ON oauth_authorization (expires_at);

-- oauth_authorization_code ----------------------------------------------------
-- Single-use authorization codes (RFC 6749 + PKCE S256). Stored as a hash;
-- consumed exactly once at /token — consumed_at is set on first exchange so a
-- replayed code is detectable and rejected.
CREATE TABLE oauth_authorization_code (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             text NOT NULL UNIQUE,
  client_id             text NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  scopes                jsonb NOT NULL,
  resource              text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL,
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- oauth_refresh_token ---------------------------------------------------------
-- Rotating refresh tokens (offline_access). A rotation chain shares family_id;
-- rotated_at marks a token already spent — presenting it again is reuse, which
-- revokes the whole family (theft detection). revoked_at kills an individual
-- token; revoking a family kills the chain (connector disconnect / connected-apps).
CREATE TABLE oauth_refresh_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  family_id    uuid NOT NULL,
  parent_id    uuid REFERENCES oauth_refresh_token (id) ON DELETE SET NULL,
  client_id    text NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scopes       jsonb NOT NULL,
  resource     text NOT NULL,
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_refresh_token_family_idx ON oauth_refresh_token (family_id);
CREATE INDEX oauth_refresh_token_client_user_idx ON oauth_refresh_token (client_id, user_id);

-- oauth_access_token ----------------------------------------------------------
-- Short-lived (~1h) audience-bound access tokens. Opaque to clients; validated
-- by hash lookup from any process. Linked to the refresh family so revoking the
-- chain invalidates outstanding access tokens alongside the refresh tokens.
CREATE TABLE oauth_access_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  family_id    uuid,
  client_id    text NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scopes       jsonb NOT NULL,
  resource     text NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_access_token_family_idx ON oauth_access_token (family_id);
CREATE INDEX oauth_access_token_expires_idx ON oauth_access_token (expires_at);
