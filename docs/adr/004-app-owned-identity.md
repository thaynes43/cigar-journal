# ADR-004: App-owned identity; the app is the OAuth server for MCP

- **Status:** accepted
- **Date:** 2026-08-26

## Context

Requirements: local users and OIDC (owner, 2026-08-26); open registration
someday (owner, 2026-08-26) — so future users cannot be provisioned in the
home-lab Authentik; MCP clients (ChatGPT) must authorize as a specific user
with no model-supplied identity trusted, via OAuth 2.1 discovery (ADR-005).

## Decision

**Better Auth in the app database owns identity.** One `users` row per
person; multiple identities link to it:

- **Local:** email + password, invite-gated at launch (todos-for-dues
  pattern); the future open-registration path.
- **Authentik OIDC:** `genericOAuth` sign-in option for the owner/operators;
  account linking ties it to the same user.
- **MCP:** the app itself is the **OAuth 2.1 authorization server** (Better
  Auth's OAuth/MCP provider plugin or equivalent). ChatGPT discovers it via
  RFC 9728/8414 metadata on the app origin, registers via DCR/CIMD, and runs
  authorization-code + PKCE; the user signs in with any linked identity and
  consents. Tokens are audience-bound to the MCP resource (RFC 8707) with
  scopes `journal:read`, `journal:write`, `catalog:read`. Lazy catalog
  creation inside `save_smoke` is covered by `journal:write` — MCP clients
  get no direct catalog-write scope. Responses are scope-bounded: catalog
  tools return personal journal fields only when `journal:read` is present.
  **Token lifetimes:** short-lived access tokens (~1h) with rotating refresh
  tokens under `offline_access`, so a linked client stays authorized for
  months without reauthentication; revocation via connector disconnect or
  the site's connected-apps page invalidates the refresh chain.

**The principal is always server-derived.** Sessions (web) and access tokens
(MCP) resolve to a user id server-side; no API or tool accepts a user
reference for authorization. Roles: `user` and `admin` (curation, invites,
match queue) as a role column; no RBAC framework.

## Consequences

Consent, token, and client tables live in our Postgres — we operate a small
authorization server (rotation, revocation, token TTLs are ours). In
exchange: MCP works identically for users who have never touched Authentik,
which open registration requires, and losing Authentik never locks anyone
out. Client-side refresh behavior (ChatGPT especially) is UNVERIFIED — the
Phase 0 spike validates real reconnect/refresh behavior before the token
lifetimes freeze.

## Alternatives considered

- Authentik as the authorization server — every future user would need a
  home-lab IdP account; DCR open on Authentik; rejected on the
  open-registration requirement.
- Authentik-only identity (haynesnetwork pattern) — same flaw; right for an
  internal front door, wrong for a would-be public product.
- Static bearer token for MCP — single-user dead end, explicit anti-goal.
