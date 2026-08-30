# Flow: SSO linking and invite redemption

- **Trigger:** a signed-in user links Authentik from `/settings`, or an invited
  person opens `/invite/<token>` (ADR-010, issue #46).

## Linking an Authentik identity

Linking is the *only* way an identity is ever attached, and it always starts
from a live session for the account being linked.

```mermaid
sequenceDiagram
    actor U as User (signed in)
    participant W as /settings
    participant BA as Better Auth
    participant AK as Authentik
    U->>W: Link (Sign-in section)
    W->>BA: POST /api/auth/link-social {provider: authentik}
    BA->>BA: session required; stamp {link: {userId, email}} into state
    BA-->>U: redirect to Authentik authorize (PKCE + state)
    U->>AK: sign in + consent
    AK-->>BA: GET /api/auth/callback/authentik?code&state
    BA->>AK: token exchange, then userinfo
    BA->>BA: trusted provider? email == link.email? (issuer, account_id) free?
    BA->>BA: INSERT account (provider_id 'authentik')
    BA-->>W: redirect /settings?linked=authentik
```

Sign-in with an already-linked identity takes the same round trip through
`/api/auth/sign-in/social` and ends at a session for the bound user.

## Redeeming an invite

```mermaid
sequenceDiagram
    actor A as Admin
    actor I as Invitee
    participant S as /settings
    participant D as @cj/domain
    participant P as /invite/[token]
    participant BA as Better Auth
    A->>S: Create invite (email)
    S->>D: createInvite
    D->>D: INSERT invites (sha256(token), email, expires_at) + audit
    D-->>A: raw link, shown ONCE
    A-->>I: sends the link out of band
    I->>P: GET /invite/<token>
    P->>D: describeOpenInvite (read-only; bound email + expiry)
    I->>P: display name + password
    P->>D: reserveInvite — atomic burn (redeemed_at)
    P->>BA: signUpEmail (email from the INVITE ROW)
    BA->>D: hasReservedInvite(email)? -> role 'user'
    P->>D: claimInvite (redeemed_by) / releaseInvite on failure
    P-->>I: signed in at /
```

## Aggregates and invariants

- **Invite.** Bound to one address, single use, expiring. Only the SHA-256 hash
  is stored. No role column — an invite has no role field to escalate. At most
  one *open* invite per address (partial unique index).
- **User.** Created only by a reserved invite, or by the first-run bootstrap
  against an empty `users` table. `role` is never written by either path except
  that first bootstrap admin.
- **Account.** `(issuer, account_id)` is unique, so one Authentik identity binds
  to at most one user. `credential` is never offered for removal.

## Failure modes

- Unknown / expired / spent / revoked invite → one indistinguishable invalid
  state. No oracle for probing tokens.
- Sign-up fails after the burn (weak password, address already registered) →
  the reservation is released and the link works again. A crash between the two
  leaves the invite spent: fails closed, and the invitee needs a fresh link.
- Unlinked Authentik identity, email matches a user → `account_not_linked`;
  `/signin` says to sign in with a password and link from Settings.
- Authentik identity matching no user → `signup_disabled`; nothing is created.
- Link with a mismatched email → `email_does_not_match`. Identity already bound
  elsewhere → `account_already_linked_to_different_user`.
- Unlink on a session older than 24h → `SESSION_NOT_FRESH`, surfaced as
  "Sign in again to unlink."
- SSO unconfigured or Authentik unreachable → the SSO affordances are absent or
  inert; local email+password sign-in is untouched.
