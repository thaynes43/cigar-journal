# ADR-010: Explicit-only SSO linking; invites are the registration gate

- **Status:** accepted
- **Date:** 2026-08-29 (amended 2026-08-31 — a factual correction to the photo-link
  TTL cited under "Consequences"; no decision changed)

## Context

ADR-004 chose app-owned identity with Authentik OIDC as a sign-in option and
invite-gated local accounts, and left both unbuilt (issue #46). Two facts,
both read from the live cluster before writing any code, decide the shape:

1. **This Authentik asserts `email_verified: false` for every identity.** Its
   managed email scope mapping (`/blueprints/system/providers-oauth2.yaml`,
   the `goauthentik.io/providers/oauth2/scope-email` mapping) returns
   `{"email": …, "email_verified": False}` literally. No configuration in this
   app changes that.
2. **The owner's local row is `email_verified = false` too** — nothing in the
   app has ever verified an address, because no email is sent.

The sibling app haynesnetwork sets `requireLocalEmailVerified: false` together
with `trustedProviders`, and `.agents/reference/related-services.md` says to
follow the house pattern unless an ADR decides otherwise. Copied here, that
pair is an account-takeover configuration: any Authentik identity whose email
matches a local account would silently absorb that account on first sign-in.

The registration allowlist (`BOOTSTRAP_ADMIN_EMAILS`) is the other half: today
any allowlisted address may register at any time, and lands as `admin`.

## Decision

**Account linking is explicit-only.** An Authentik identity binds to a local
account only when all five hold:

1. The request carries a **live session for that exact user** — the link starts
   at `/settings` and runs `POST /api/auth/link-social`. This is the
   load-bearing condition.
2. The identity's email equals the session user's email, case-insensitively
   (`allowDifferentEmails` stays `false`).
3. That `(issuer, account_id)` is not already bound to another user.
4. `authentik` is in `trustedProviders` — **required**, because the IdP asserts
   `email_verified: false` and there is no verified-email claim to rely on.
5. `disableImplicitLinking: true`, so condition 1 cannot be bypassed by merely
   signing in with SSO.

`requireLocalEmailVerified` keeps its `true` default. It is deliberately not
set to `false` here, and a future agent must not "restore" the sibling's
pattern: with `trustedProviders` set, that single flag re-opens the takeover.

The property this buys: *possession of an Authentik account whose email happens
to equal a cigar-journal account's email grants nothing.* The attacker must
already hold a session for the target account, at which point they are it.

**OIDC can never create a user** (`disableSignUp: true`), preserving ADR-004's
core promise that future users need no home-lab IdP account. An invite creates
a local email+password account; the invitee may link Authentik afterwards, and
only if one has also been provisioned for them.

**SSO fails closed to local sign-in.** The plugin is constructed only when
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_DISCOVERY_URL` are all present
and the discovery URL parses; a bad value degrades to "SSO is off", never a
module-eval throw. `accountIssuer` is passed explicitly because better-auth's
generic-oauth plugin throws out of plugin init when discovery is unreachable
and no issuer is configured — which would take `/signin` down with it.

**Invites replace the registration allowlist.** `invites` (migration 0022)
binds one email to a SHA-256-hashed token with a 7-day expiry. Redemption is
two-phase: an atomic conditional UPDATE burns the token (`redeemed_at`), then
`redeemed_by` is stamped once sign-up succeeded, and an unclaimed reservation is
released if it failed. The reserved row is the registration authorization the
auth create-hook reads — state in the database, not a request-scoped flag.

**An invite cannot escalate, because it has no role field.** There is no `role`
column on `invites` (stronger than the todos-for-dues CHECK constraint on one:
you cannot tamper with an input that does not exist). Redemption never writes
`users.role`, the create-hook returns a hard `role: "user"`, the Better Auth
`role` field is `input: false`, and the only writer of `role = 'admin'` in the
codebase remains the env-driven session-create hook.

**`BOOTSTRAP_ADMIN_EMAILS` narrows to two things** and is no longer a standing
registration gate:

- **First-run bootstrap** — an allowlisted address may register only while the
  `users` table is empty, so a virgin deployment and the e2e harness can mint a
  first admin without raw SQL.
- **Idempotent admin re-assert on session create** — kept exactly as it was.
  It is the break-glass that makes it impossible for the owner to end up
  permanently non-admin, at the cost of one indexed read per sign-in.

## Consequences

Linking requires two accounts and a deliberate act, which is the point; there
is no one-click "sign in with Authentik" onboarding, by design. Unlinking hits
Better Auth's `freshAge` (24h, while sessions run 30 days), so a long-lived
session is told to sign in again rather than being given a weakened freshness
rule. The first-run bootstrap has a theoretical race — two concurrent
allowlisted sign-ups against an empty table — accepted, since both would have to
be allowlisted and it can only ever happen on a virgin database.

A crash between reserve and claim burns the invite: the invitee sees the invalid
state and needs a fresh link. That is the fail-closed direction, chosen over a
release-on-crash that would fail open. The stranded reservation it leaves behind
would otherwise keep authorizing registration for that one address forever — the
single fail-open edge in the design — so a reservation only authorizes for five
minutes (`RESERVATION_WINDOW_SECONDS`). The invite stays spent either way.

The invite token travels in the URL path (`/invite/<token>`), so it reaches
ingress access logs and `Referer` headers — the same accepted trade-off as the
shipped `/u/<token>` photo links. The invite is bounded by a 7-day TTL, single use,
hash-only storage, and the email binding. Do not lengthen the TTL without
revisiting.

*Amended 2026-08-31.* This paragraph read as though the 7-day TTL covered the photo
links too. It never did: they shipped at 900 seconds and are now 24 hours
(`packages/domain/src/photo-upload-tokens.ts`). The two tokens share the URL-path
trade-off and the hash-only storage, not a TTL — and they should not, since an
invite is addressed to a person by email while a photo link is single-use and bound
to one smoke. Correction of record only; nothing decided here changes.

Redemption runs through a server action rather than `/api/auth/*`, so Better
Auth's DB-backed limiter does not cover it; guessing a 256-bit token is
infeasible and the bound email caps the damage of a leaked link to one address,
so no separate limiter is added.

Turning SSO on or off is one 1Password field. That reversibility is the
property that matters before the go-live walkthrough.

## Alternatives considered

- Copy haynesnetwork's `requireLocalEmailVerified: false` + `trustedProviders`
  — the takeover configuration described above; rejected on evidence.
- Implicit linking gated on `email_verified` — this IdP never asserts it, so
  the gate would be permanently closed (or permanently open if forced).
- Unbound invite tokens (todos-for-dues) — friendlier to share, but any address
  could redeem and the admin list could not say who an invite is for.
- Role-carrying invites (todos-for-dues `preselected_role` + CHECK) — a field
  that must be constrained is weaker than no field at all.
- Full removal of `BOOTSTRAP_ADMIN_EMAILS` — leaves a fresh deployment with no
  path to a first admin except raw SQL, and removes the owner's break-glass.
