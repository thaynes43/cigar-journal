# ADR-010: Operator-minted service tokens for non-interactive MCP clients

- **Status:** accepted
- **Date:** 2026-08-29

## Context

Some MCP clients have no browser. The dev-env pod's agent is the standing
example: it must call `/mcp` unattended, so it cannot run the
authorize→consent→code leg that ADR-004/005 assume. It currently holds a
30-day access token that was hand-INSERTed into `oauth_access_token` against
a forged client row (`grant_types: ["authorization_code"]`,
`redirect_uris: ["http://localhost:1/unused"]` — neither true). That token
expires 2026-09-26 (issue #129) and there is no supported way to replace it.

ADR-004 lists "static bearer token for MCP" as an explicit anti-goal. That
anti-goal is about *identity*: a shared secret that IS the authorization, with
no user behind it, no audience, and no way to revoke one holder. The need here
is different — a real user's credential, issued out-of-band because the
consumer cannot render a consent screen.

## Decision

**A service token is an ordinary `oauth_access_token` row that happens to live
a year.** Validation, the grants, `/oauth/token`, and every route adapter are
untouched. What is added is a supported, audited, server-side *writer* for
such a row, replacing the hand-INSERT.

- **`packages/oauth/src/service-tokens.ts`** — `mintServiceToken`,
  `listServiceTokens`, `revokeServiceToken`. The mint sits beside the
  authorization-server invariants it depends on (`hashToken`, `mcpResource`,
  `SUPPORTED_SCOPES`, the `oauthAccessToken` schema) so they cannot fork
  across a package boundary.
- **INVARIANT: the mint is never reachable over the network.** These functions
  are deliberately not re-exported from `packages/oauth/src/index.ts`, so the
  surface `apps/web` and `@cj/mcp` import contains no mint. The only callers
  are `packages/oauth/src/cli.ts` — the one-shot `token` role on the app image
  (ADR-001) — and its colocated test.
- **A dedicated service client per consumer** (`oauth_client.is_service`,
  migration 0021, unique per `client_name`). Registered with
  `redirect_uris: []`, `grant_types: []`, `response_types: []`, no secret. The
  empty redirect set is what closes the browser flow:
  `resolveAuthorizationClient` exact-matches against the registered set, so
  every `redirect_uri` is rejected — no authorization-server code changes.
  One client per consumer makes a leak attributable and revocable in isolation.
- **The principal is a real user, resolved by `--user-email`.**
  `validateAccessToken` joins `users` for the role at validation time, so a
  synthetic service user would own its own empty journal — the opposite of
  what a journal-writing agent needs. The honest consequence: the token acts
  as that user and is in-domain indistinguishable from their own session,
  bounded by explicit scopes, the `/mcp` audience, and the per-consumer
  `client_id` on every audit row.
- **No refresh chain.** `offline_access` is refused; `family_id` is NULL. That
  is both correct (nothing to rotate) and a durable marker that no grant
  issued the row.
- **Audited.** `oauth.service_client.create`, `oauth.service_token.mint`, and
  `oauth.service_token.revoke` write `audit_log` rows (actor `system`) in the
  mint/revoke transaction, carrying the reason and the `tokenId` join key —
  never token material or a hash.
- **Default TTL 365 days, max 730**; `--yes` gates every write; `mint --yes`
  prints the token to stdout exactly once and nowhere else.

This is not the ADR-004 anti-goal: the credential is user-bound,
audience-bound (RFC 8707), scope-limited, per-consumer, revocable, and never
accepted or issued at `/oauth/token`.

## Consequences

Rotation is overlap-safe — two independent rows are simultaneously valid — so
the runbook can mint, cut over, verify, then revoke. Revocation bites on the
next MCP call: `packages/mcp/src/auth.ts` validates per request with no cache.
`listServiceTokens --all-clients` surfaces every token whose lifetime exceeds
24h regardless of client, which doubles as a detector for the legacy row and
any future hand-INSERT.

What we accept: a year-long bearer that acts as its user, with no
refresh-rotation heartbeat that would reveal theft, held by whoever can read
the secret store, the pod env, or a mint Job's log. Expiry is a cliff, not a
gradual failure — `list` reports days-remaining, but that is a pull, not an
alert (follow-up: a `--json` mode polled by the dev-env-ops cron).
`grant_types: []` is documentation, not enforcement — the token route never
consults it — so if a redirect-less grant (client credentials, device code)
ever lands, a service client would silently become usable at `/oauth/token`;
enforcing `grant_types` at the token endpoint is the real fix when that day
comes. And when the connected-apps page ADR-004 promises arrives, it must
decide explicitly whether service clients appear: invisible means the owner
cannot revoke them from the UI, naively listed means a "disconnect" could kill
a production credential. Recommended: shown, read-only, admin-revocable.

## Alternatives considered

- Reuse the existing `dev-env-cli` client row — the audit trail could never
  separate flow-issued from operator-minted on client identity alone.
- A synthetic service user — owns its own empty journal, and `curation:*`
  would need it promoted to admin; the agent must write as the owner.
- A `client_credentials` grant at `/oauth/token` — a real network-reachable
  mint, new grant code on the AS, and a client secret that is itself a static
  bearer. Rejected as strictly more surface for the same capability.
- An `if (client.isService) throw` guard in `resolveAuthorizationClient` — a
  behavior change on the authorization-code path for no gain; the empty
  redirect set already closes the flow.
- A separate `@cj/service-tokens` package — forks the AS invariants across a
  package boundary; not exporting from `index.ts` gives the same containment.
