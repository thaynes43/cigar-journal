# Security and Observability

Lightweight threat model for a small multi-tenant app whose primary client is
an LLM. The MCP adapter never treats the model as an authorization authority.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Model-supplied identity / mass assignment | No tool or API accepts a user reference; principal derives from token/session only (ADR-004); a `userId` in any payload is rejected as unknown input. Updates use explicit change operations (no generic patch); ownership checked per mutation. Provenance `client` is taken from the OAuth client record, never from arguments. |
| Cross-user reads (BOLA) | Every query scoped by owner id; visibility flag checked on public paths; authz tests cover cross-user + both visibility states (PRD NFR). |
| Prompt injection via stored content | Journal text and catalog fields returned to LLMs are data the *user* (or a crawl) wrote. Tool results carry no instructions; crawled text is normalized fields, not raw HTML. Residual risk accepted: a user can only injection-attack their own journal until journals are shared. |
| Stored XSS in journal prose | Prose rendered as escaped text/sanitized markdown; no raw HTML from any journal or catalog field, especially on public pages. |
| SSO account takeover via email match | Account linking is explicit-only (ADR-010): `disableImplicitLinking` removes linking from the sign-in path, so an identity attaches only via `/api/auth/link-social`, which requires a live session for that exact account. `requireLocalEmailVerified` and `allowDifferentEmails` keep their safe defaults — this Authentik asserts `email_verified: false` for every identity, so a matching email proves nothing. OIDC can never create a user (`disableSignUp`). Residual: an owner-controlled IdP is trusted for exclusivity, but exploiting that needs an Authentik account **and** a cigar-journal session for the victim. |
| Privilege escalation via invite | `invites` has no role column, so there is no input to tamper with; redemption never writes `users.role`; the auth create-hook returns a hard `role: "user"` and the Better Auth field is `input: false`. The only writer of `admin` is the env-driven session-create hook, which no invite can reach. |
| Invite link theft / replay | SHA-256 hash stored, never the raw token (as with `photo_upload_tokens`); bound to one address; single use enforced by an atomic conditional UPDATE; 7-day expiry. Unknown/expired/spent/revoked collapse to one message — no probing oracle. Residual: the token rides the URL path, so it reaches access logs and `Referer` — same accepted trade-off as `/u/<token>`. |
| Lockout via a broken SSO config | The OIDC plugin is constructed only when all three env vars are present and the discovery URL parses, and `accountIssuer` is set explicitly so an IdP outage cannot throw out of plugin init. Local email+password sign-in is never gated on any of it; a test pins that fallback. |
| OAuth token leakage / replay | Short-lived audience-bound access tokens (RFC 8707); PKCE + state; revocation via connector disconnect and a connected-apps page; tokens never logged. |
| Long-lived service-token leakage (ADR-011) | The one exception to short lifetimes: an operator-minted token for a browserless client lives up to a year — 90 days if it carries `curation:*`, because the widest credential must not also be the longest-lived. Compensating controls — a mintable-scope allowlist and those TTL ceilings enforced in the mint (`curation:*` sits outside the default allowlist and is admitted only by an explicit `--allow-curation` flag for an admin subject, checked at mint time and recorded on the audit row — owner override 2026-08-30; `offline_access` is refused unconditionally), the same RFC 8707 audience binding, one client per consumer, per-request validation with no cache so a revoke bites on the next call, and every mint/revoke audited under a per-run id. Per-consumer attribution is what makes a leak separable rather than merely revocable, so the write side carries it too: every curation audit row stamps the `client_id` of the credential that drove it (migration 0023), server-derived from the token row, so a stolen curation token walking the triage queue is distinguishable afterwards from the daily lane's own work. Delivery is the control that keeps it out of a log sink: the mint refuses to run unless stdout is an interactive terminal, so it exists only on an operator's `kubectl exec -it` stream and never in a container log or Loki. Residual risk: a thief using the lane's *own* token is still indistinguishable from the lane (bearer credentials cannot separate holders — that is what revoke-and-re-mint is for); journal-scoped writes outside `audit_log`'s curation surface do not yet record a client (issue #183); and no refresh-rotation heartbeat would reveal theft, so expiry is watched by the daily credential-expiry CronJob. |
| Over-permissioned tools / scope leakage | Six tools, three scopes; no delete via MCP; catalog writes only as a side effect of `save_smoke`; responses are scope-bounded — catalog tools omit personal fields without `journal:read`. |
| Duplicate/replayed writes | Envelope on every mutation: unique-constrained keys with request fingerprints, same-transaction; conflicting key reuse rejected (flow 004). |
| SQL injection | Drizzle parameterized queries only; no string-built SQL (raw migrations are static files). |
| CSRF / session fixation (web) | Better Auth defaults: same-site cookies, CSRF protection on auth routes. |
| Crawler abuse surface | Adapters fetch only configured vendor domains (no user-supplied URLs → no SSRF path); rate-limited; robots-respecting. |
| Secrets / private data in logs | No journal prose, tokens, or credentials in logs; ExternalSecrets for config; log fields are ids + codes. |

## Observability

- **Correlation:** one id minted at the MCP request (or web request), carried
  through application command, audit row, and DB error logs —
  `MCP request → command → transaction` is one grep.
- **Metrics (Prometheus):** per-tool call count/latency/error-code counts,
  save failures, idempotency replays, cigar-resolution outcomes
  (single/multiple/none), OAuth failures, crawler run results + freshness
  per vendor, match-queue depth.
- **Logs (Loki):** structured; tool name + error code + correlation id, never
  payload prose. Auth events logged at grant/revoke.
- **Photo intake — shapes, never values (2026-08-30).** `add_smoke_photo` emits
  `photo_intake` (per call, from the handler) and `photo_intake_request` (per
  `/mcp` POST, from the HTTP layer after bearer auth) so a failed attachment is
  diagnosable: *nothing delivered* / *delivered without a usable URL, and these are
  the keys it carried* / *URL present but unfetchable* / *success*. The rule that
  makes this safe: a host file handle's `download_url` is a **short-lived signed
  credential** — its path and query *are* the credential — so **no value from a
  file handle is ever logged**. The record carries key NAMES, the JSON type of each
  value, and a per-key "is a non-empty string" flag, nothing else; key names are
  capped at 20 per record and truncated to 64 characters so a hostile handle keyed
  by an identifier cannot smuggle data in or grow the line without bound. One
  deliberate exception: `fetch.host` (hostname only, never path/query/fragment) is
  recorded, because it is the only way to tell an egress block from an upstream
  403 and a hostname is not the credential. `photo_intake_request` sits **after**
  auth on purpose — before it, an unauthenticated caller could write arbitrary key
  names into Loki — and is wrapped in try/catch so a diagnostic can never become an
  outage.
- **Probes:** `/api/health` (process-only, house pattern) for k8s; Gatus for
  the web origin and `/mcp` reachability; crawler CronJobs alert on repeated
  failure, not single misses.
- **Credential expiry:** long-lived OAuth access tokens (lead 7 days) and
  `RELEASE_PLEASE_TOKEN` (lead 14 days) are counted down daily from haynes-ops
  (`kubernetes/main/apps/frontend/cigar-journal/app/credential-expiry-cronjob.yaml`).
  Both expiries are read from their source of truth — `oauth_access_token` and
  GitHub's token-expiration response header — never from a copied constant. The
  job's terminal failure pages via `severity=critical`. The OAuth half currently
  names one client id; haynes-ops#2681 re-points it at every live token whose
  lifetime exceeds 24h, so it follows an ADR-011 re-mint under a new client
  instead of watching a retired one.
- **Diagnosable by design:** every failure class in the PRD (connection,
  auth, validation, save, resolution) is distinguishable from metrics + one
  log line without reading journal content.
