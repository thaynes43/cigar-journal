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
| OAuth token leakage / replay | Short-lived audience-bound access tokens (RFC 8707); PKCE + state; revocation via connector disconnect and a connected-apps page; tokens never logged. |
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
- **Probes:** `/api/health` (process-only, house pattern) for k8s; Gatus for
  the web origin and `/mcp` reachability; crawler CronJobs alert on repeated
  failure, not single misses.
- **Diagnosable by design:** every failure class in the PRD (connection,
  auth, validation, save, resolution) is distinguishable from metrics + one
  log line without reading journal content.
