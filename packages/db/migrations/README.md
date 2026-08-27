# Migrations

Numbered raw-SQL migrations, applied in order by the advisory-locked `migrate`
init container at startup (ADR-003).

- `0001_init.sql` — extensions, core tables, indexes for the Cigar Journal.
- `0002_auth.sql` — Better Auth identity substrate (ADR-004): session, account,
  verification, and rate-limit tables, plus the columns Better Auth adds to
  `users`.
- `0003_oauth.sql` — OAuth 2.1 authorization-server storage (ADR-004/005): DCR
  clients, authorization transactions + single-use PKCE codes, audience-bound
  access tokens, and rotating refresh tokens with revocation chains. Tokens are
  stored only as SHA-256 hashes so the out-of-process MCP resource server can
  validate via `@cj/db` alone.
