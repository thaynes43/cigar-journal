-- 0002_auth — Better Auth identity substrate (ADR-004). Aligns Better Auth onto
-- the existing users table and adds its session/account/verification tables plus
-- DB-backed rate-limit storage. Postgres owns every UUID (Better Auth runs with
-- generateId:false), and every timestamp is timestamptz — same conventions as 0001.

-- users -----------------------------------------------------------------------
-- Columns Better Auth requires beyond the Phase-1 minimum. `name` maps to the
-- existing display_name; nothing is renamed.
ALTER TABLE users
  ADD COLUMN email_verified boolean     NOT NULL DEFAULT false,
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

-- session ---------------------------------------------------------------------
-- DB-backed sessions (~30d cookie). Cascade so deleting a user clears sessions.
CREATE TABLE session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  token      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX session_user_idx ON session (user_id);

-- account ---------------------------------------------------------------------
-- One row per linked identity. Local email+password keeps its hash in `password`
-- (provider_id = 'credential'); future OAuth links reuse this table.
CREATE TABLE account (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer                   text NOT NULL,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, account_id)
);

CREATE INDEX account_user_idx ON account (user_id);

-- verification ----------------------------------------------------------------
-- Email-verify / password-reset tokens. Required by Better Auth; unused until
-- those flows land.
CREATE TABLE verification (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX verification_identifier_idx ON verification (identifier);

-- rate_limit ------------------------------------------------------------------
-- DB-backed limiter storage — replica-safe, no in-memory auth state.
-- last_request is epoch milliseconds.
CREATE TABLE rate_limit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  count        integer NOT NULL,
  last_request bigint NOT NULL
);
