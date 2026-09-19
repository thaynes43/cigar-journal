# ADR-011: Operator-minted service tokens for non-interactive MCP clients

- **Status:** accepted
- **Date:** 2026-08-29 (amended 2026-08-30 — see "Curation scopes: the owner
  override"; amended 2026-09-19 — see "No expiry: the owner override")

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
a year** — or, since the 2026-09-19 amendment below, not to expire at all.
Validation, the grants, `/oauth/token`, and every route adapter are untouched.
What is added is a supported, audited, server-side *writer* for such a row,
replacing the hand-INSERT.

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
  `redirect_uris: []`, `grant_types: []`, `response_types: []`, no secret.
  Two independent closures, both enforced: the empty redirect set means
  `resolveAuthorizationClient` rejects every `redirect_uri`, so the browser
  flow cannot start; and `grant_types` is now checked at issuance
  (`exchangeAuthorizationCode` / `exchangeRefreshToken` throw
  `unauthorized_client` for a grant the client did not register), so the
  empty set closes `/oauth/token` for this client even if a redirect-less
  grant is added later. Registration keeps defaulting to
  `["authorization_code","refresh_token"]`, so no existing client changes
  behavior. One client per consumer makes a leak attributable and revocable
  in isolation.
- **The principal is a real user, resolved by `--user-email`.**
  `validateAccessToken` joins `users` for the role at validation time, so a
  synthetic service user would own its own empty journal — the opposite of
  what a journal-writing agent needs. The honest consequence: the token acts
  as that user and is in-domain indistinguishable from their own session,
  bounded by explicit scopes, the `/mcp` audience, and the per-consumer
  `client_id` on every audit row.
- **No refresh chain.** `offline_access` is refused; `family_id` is NULL. That
  is both correct (nothing to rotate) and a durable marker that no grant
  issued the row. Since migration 0041 a CHECK makes it load-bearing: a row
  with no expiry must have no family, so an immortal token can never be issued
  from inside a grant.
- **Audited.** `oauth.service_client.create`, `oauth.service_token.mint`, and
  `oauth.service_token.revoke` write `audit_log` rows (actor `system`) in the
  mint/revoke transaction, carrying the reason and the `tokenId` join key —
  never token material or a hash.
- **Scopes and TTL are bounded in the mint, not by the caller's arguments.**
  `catalog:read`, `journal:read` and `journal:write` are mintable by default;
  `offline_access` is refused unconditionally (no refresh chain). `curation:*`
  is off by default and reachable only through the explicit elevation below.
  A **dated** mint defaults to 365 days **and caps there**, so `--ttl-days` can
  only shorten — 90 days for a curation-elevated mint, see the override below.
  `--no-expiry` is the one way out of those ceilings, and it is an explicit
  opt-out rather than a widening of what `--ttl-days` may ask for: the two
  flags are mutually exclusive (usage error), see "No expiry: the owner
  override".
- **One delivery path, and no other is possible.** `mint --yes` refuses to run
  unless stdout is an interactive terminal, and refuses before writing
  anything. A container's stdout is collected into Loki for the whole
  retention window, so a Job or CronJob mint would put the credential in a log
  sink; `kubectl exec -it` allocates a pty whose stream the API server proxies
  to the operator and which never becomes a log line. There is no override
  flag and no Job manifest — a second delivery path is a second copy of the
  secret. `--yes` still gates every write.
- **Both dry runs read the database.** `mint` without `--yes` runs the same
  scope, TTL, audience and principal checks the apply runs, and `revoke`
  without `--yes` resolves ids exactly as the revoke does (any token row, not
  only long-lived ones). A rehearsal that confirms nothing is not a rehearsal.

This is not the ADR-004 anti-goal: the credential is user-bound,
audience-bound (RFC 8707), scope-limited, per-consumer, revocable, and never
accepted or issued at `/oauth/token`.

## Curation scopes: the owner override (2026-08-30)

The original decision refused `curation:*` outright. **The owner overrode that
refusal on 2026-08-30.** The reasoning behind it — a browserless holder can
mutate the *shared* catalog under the subject's admin role for the token's
whole life — is unchanged and still true; what changed is the cost of the
alternative.

The daily curation lane ran on a rotating refresh token, and that model kept
failing. The final failure (`wo-cigar-curate-20260830`) is the shape of all of
them: the session-start refresh returned HTTP 200, the agent lost the rotated
`refresh_token` without writing it back, and both the access token and its
replacement were gone. It behaved correctly from there — replaying the stale
refresh token would have tripped reuse detection and revoked the whole family,
so it parked the credential as `token.json.consumed-20260830` and made zero
catalog writes. Every such failure costs the owner a manual browser
re-consent, and the lane produces nothing until he does it.

Against that, a minted token has **no rotation to lose**. It is also revocable
in isolation (one client per consumer), audited per mint, and already covered
by the daily `cigar-journal-credential-expiry` monitor, which selects by token
*lifetime* rather than `client_id` and so picks up a new one with no edit.

The elevation is **narrow and explicit**, not a widening of the default set:

- `MINTABLE_SERVICE_SCOPES` keeps its meaning — the scopes mintable with no
  flag — and `curation:*` is still not in it. The elevation is a separate set,
  `CURATION_SERVICE_SCOPES`, admitted only at mint time.
- **An explicit operator flag, `--allow-curation`.** Never inferred from the
  scope list; an unknown argument is a usage error, so a typo cannot produce
  it. Without the flag the refusal stands, and its message now names the flag
  so the refusal reads as a decision rather than a typo.
- **The subject must be an admin, checked at mint time** against `users.role`
  in the same transaction as the insert. The curation tools already re-check
  the role on every call (`assertAdmin` in `@cj/mcp`), so this adds no
  authorization — it makes an *ineffective* token unmintable instead of
  mintable-but-inert. A non-admin subject is an operational failure (exit 1,
  `subject_not_admin`), not a usage error: the fix is in the data.
- **The elevation is visible after the fact.** The mint's audit row carries
  `curationElevated` and the `subjectRole` read at mint time — on every mint,
  so a present-and-false value means "ordinary", where a missing field would
  only mean "some older code did not write one". The CLI prints a named
  `curation ELEVATED …` line in both the dry-run plan and the mint report, so
  the elevation is never something you discover by decoding a scope list.
- **A shorter TTL ceiling, not the ordinary one.** An elevated mint is capped
  at **90 days** and defaults to 90, where an ordinary one is capped at and
  defaults to 365 (`CURATION_SERVICE_TOKEN_TTL_DAYS`). The widest credential
  the system can issue must not also be the longest-lived: this one rewrites
  the shared catalog, where the others reach one subject's own journal. It
  costs nothing the elevation was bought for — the failure being replaced was
  losing a *rotated* refresh token mid-run, and a re-mint is not rotation but
  one `kubectl exec -it` at a moment the operator picks, with the old token
  live until he revokes it. The expiry cliff is already watched: the daily
  `cigar-journal-credential-expiry` CronJob selects by lifetime (> 24h), so a
  90-day token is covered with no edit. *(Amended 2026-09-19: this ceiling
  still governs every **dated** elevated mint, but the owner extended
  `--no-expiry` to the curation token as well — see the next section.)*
- **Audited writes name the credential that made them.** `audit_log.client_id`
  (migration 0024) records the OAuth client of the calling token on every audit
  row the application writes — curation, journal, inventory, photos, settings,
  invites (#183) — taken off the server-derived `Principal` and never from a tool
  argument. One shared `auditActor` helper assembles it, so a new audit insert
  cannot quietly opt out; a source-scanning test fails the suite if one does. Without it the "one client per consumer, so a leak is
  attributable" control was untrue on the write side for exactly the scopes
  this override opens: a stolen token calling `get_curation_queue` and walking
  `set_listing_match_status` across the triage queue left history identical to
  the lane's own. It is not a substitute for revoking — a thief using the
  lane's own token still looks like the lane — but it separates credentials,
  which is what per-consumer clients promise.
- **Every other guarantee is untouched:** `offline_access` is still refused in
  every combination (and is now swept for first, so pairing it with a curation
  scope cannot blame curation and imply a flag would help), the RFC 8707
  audience binding, one service client per consumer, stdout-only delivery gated
  on an interactive TTY, and no change whatsoever to the `authorization_code`
  or `refresh_token` grants.

What we accept, on top of the bearer already accepted below: for the curation
lane's token specifically, that bearer can curate the shared catalog for its
whole life without a consent screen. It is bounded by the same revocation,
audience, per-consumer attribution and per-request validation as every other
service token, by a 90-day rather than a 365-day life (or, under the
2026-09-19 override, by revocation alone), and the curation tools' own
`assertAdmin` still gates each call. The attribution is per *credential*,
not per holder: a leak of the lane's own token is indistinguishable from the
lane until it is revoked, and revoke-by-id is the response — **not** demoting
the subject, which in this deployment is the owner himself and is undone by his
next sign-in (`packages/auth/src/auth.ts` re-asserts admin on session create).

## No expiry: the owner override (2026-09-19)

The decision above bounds every service token by a TTL — 365 days, 90 for a
curation elevation. **The owner overrode that on 2026-09-19, for both.** A
service token may now be minted with `--no-expiry`: `expires_at` NULL, valid
until revoked.

The trigger was the 7-days-left page firing for the dev-env pod's token. Each
expiry is not a rotation the system performs; it is a ceremony the owner
performs — an interactive `kubectl exec -it` re-mint, a 1Password field edit,
an ESO sync, and a pod restart that kills whatever agent session was running
in it. His standing precedent for that hands-off pod is non-expiring machine
credentials: the release-please PAT, the GCP service-account key, the Claude
setup token. A credential whose renewal reliably costs a human interruption
and whose absence stalls the consumer is, in his judgement, worse than one
that persists.

**What is given up.** The forced rotation that bounded an undetected theft.
The Decision above argues that "the widest credential the system can issue
must not also be the longest-lived", and the curation elevation was capped at
90 days on exactly that reasoning. The owner overrode it. The argument has not
become wrong and is not retracted here: a stolen no-expiry token works until
someone notices and revokes it, with no deadline that would end it on its own,
and that is a real reduction in the system's defence in depth. It was traded
knowingly for a credential the operator does not have to re-issue.

**What still bounds the credential**, unchanged by this amendment:

- explicit scopes, enforced in the mint (`offline_access` still refused in
  every combination; `curation:*` still behind `--allow-curation` and an admin
  subject checked at mint time);
- the RFC 8707 audience — the token is valid at this server's `/mcp` and
  nowhere else;
- one service client per consumer, so a leak is attributable and revocable
  without touching any other credential;
- per-request validation with no cache, so **a revoke bites on the next call**
  — revocation, not expiry, is the kill switch, and it always was;
- revoke-by-id, and `client_id` on every audit row the credential writes
  (migration 0024), so its activity is separable after the fact.

**The durable marker is NULL `expires_at` alongside NULL `family_id`.**
Migration 0041 makes `expires_at` nullable on `oauth_access_token` only — the
authorization codes, refresh tokens and authorization transactions keep NOT
NULL, each being a step in a flow that must time out — and adds a CHECK,
`expires_at IS NOT NULL OR family_id IS NULL`. No existing row can violate it
(the grants set a date on every token they issue), and it forecloses the
future mistake: a refresh rotation that dropped the expiry would mint an
immortal token from inside a grant, which is the one credential this system
does not issue. Every read that filters on expiry admits NULL explicitly,
because `expires_at > now()` silently drops it.

`--no-expiry` is an explicit per-mint opt-out, not a new default and not a
widening of `--ttl-days`:

- the two flags are **mutually exclusive** (usage error, exit 2, refused in
  the mint as well as at argv) — two lifetimes in one command, one of them
  immortal, is not something to resolve by precedence;
- without the flag nothing changes: 365 default and cap, 90 for an elevated
  mint, `--ttl-days` only ever shortening;
- the dry-run plan prints `ttl  none — valid until revoked` and the mint
  report `expires  never — valid until revoked`, so the operator cannot
  discover it by noticing an absent date;
- the mint's audit row records `noExpiry` on **every** mint — present-and-false
  on a dated one — alongside `ttlDays: null` and `expiresAt: null`, the same
  reasoning as `curationElevated`;
- `list` shows `never` in EXPIRES and `-` in DAYS, and such a row is included
  by the default listing and by `--all-clients`.

## Consequences

Rotation is overlap-safe — two independent rows are simultaneously valid — so
the runbook can mint, cut over, verify, then revoke. Revocation bites on the
next MCP call: `packages/mcp/src/auth.ts` validates per request with no cache.
`listServiceTokens --all-clients` surfaces every token whose lifetime exceeds
24h regardless of client, which doubles as a detector for the legacy row and
any future hand-INSERT.

What we accept: a year-long bearer — or, since 2026-09-19, a non-expiring one
— that acts as its user, with no refresh-rotation heartbeat that would reveal
theft, held by whoever can read the secret store or the pod env. For a **dated**
token, expiry is a cliff rather than a gradual failure: `list` reports
days-remaining, but that is a pull; the alert is the daily
`cigar-journal-credential-expiry` CronJob in haynes-ops, re-pointed by
haynes-ops#2681 at every live token whose lifetime exceeds 24h, so it follows
the credential across a re-mint with no edit. A **no-expiry** token has no
cliff to watch, so the monitor must list it as such rather than count it down,
and must not read "no dated token is near expiry" as "no credential exists" —
otherwise the job that was meant to fail loudly when the credential is missing
starts failing because it is permanent.

Containment of the mint is enforced three ways: it is absent from
`index.ts`, the package's `exports` map blocks subpath imports, and an
ESLint `no-restricted-imports` rule refuses a relative path into
`packages/oauth/src/service-tokens*` from anywhere outside `@cj/oauth`.

And when the connected-apps page ADR-004 promises arrives, it must
decide explicitly whether service clients appear: invisible means the owner
cannot revoke them from the UI, naively listed means a "disconnect" could kill
a production credential. Recommended: shown, read-only, admin-revocable.

## Alternatives considered

- Reuse the existing `dev-env-cli` client row — the audit trail could never
  separate flow-issued from operator-minted on client identity alone.
- A synthetic service user — owns its own empty journal, and `curation:*`
  would need it promoted to admin; the agent must write as the owner. The
  2026-08-30 override does not revive this: the admin check makes the *real*
  owner the only viable curation subject, which is what the lane wants anyway.
- Keeping the rotating refresh token and hardening the write-back — the agent
  is not the only consumer that can lose a rotated token, and each loss is a
  manual re-consent. The owner ruled that out explicitly; he does not want to
  keep doing it.
- Widening `MINTABLE_SERVICE_SCOPES` to include `curation:*` — one line, and
  every future mint silently reaches the shared catalog. The whole point of
  the flag is that the elevation is per-mint and recorded.
- Letting an elevated mint keep the ordinary 365-day ceiling — the stated
  benefit of the elevation is "no rotation to lose", and a shorter ceiling
  preserves that benefit exactly (a re-mint is an operator action, not an
  in-band token exchange that can be dropped). Keeping 365 would have made the
  widest credential in the system the longest-lived for no gain beyond three
  fewer interactive execs a year. Rejected; 90 days it is. The trade accepted:
  a forgotten re-mint stalls the lane, which is why the expiry CronJob's
  lifetime-based selector (haynes-ops#2681) is a precondition and not a
  nice-to-have.
- Keeping the ceilings and automating the re-mint instead (2026-09-19) — the
  mint has exactly one delivery path, an interactive TTY, precisely so the
  credential never reaches a log sink. Automating it means a second delivery
  path, which is a second copy of the secret; that trade is worse than the one
  the override makes. A shorter TTL with a louder alert was also rejected: the
  alert already fires correctly, and the cost it surfaces is the owner's time,
  not a system failure.
- A very long TTL (say 10 years) instead of NULL — the same exposure with none
  of the honesty. A far-off date reads as a bound in `list`, in the monitor and
  in the ADR while being one in name only, and it still ends abruptly on a day
  nobody planned for. NULL says what is true.
- Recording the credential in the audit row's `after` JSONB instead of a
  column — no migration, but the incident query ("what did this credential
  write") becomes a JSONB probe over every row, and the field would be mixed
  into a snapshot whose keys are the *entity's*, not the caller's.
- A `client_credentials` grant at `/oauth/token` — a real network-reachable
  mint, new grant code on the AS, and a client secret that is itself a static
  bearer. Rejected as strictly more surface for the same capability.
- An `if (client.isService) throw` guard in `resolveAuthorizationClient` — a
  behavior change on the authorization-code path for no gain; the empty
  redirect set already closes the flow.
- A separate `@cj/service-tokens` package — forks the AS invariants across a
  package boundary; not exporting from `index.ts` gives the same containment.
