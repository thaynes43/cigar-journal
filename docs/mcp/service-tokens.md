# Service tokens — operator runbook

Long-lived MCP credentials for clients that have no browser (ADR-011). The
mint is the `token` role on the app image; it is never reachable over HTTP.

```
service-token mint   --client-name <name> --user-email <email> --scope <s>... --reason <text>
                     [--ttl-days N] [--resource <url>] [--yes]
service-token list   [--include-expired] [--include-revoked] [--all-clients]
service-token revoke --id <uuid> [--reason <text>] [--yes]
```

`mint` and `revoke` are dry-run without `--yes`; both dry runs read the
database and run the same validators as the apply. Exit codes: `0` ok, `1`
operational failure (unknown user, unknown token id), `2` usage, env, or a
refused delivery.

## Precondition

The `token` role ships in the app image, so it exists only from the release
that contains ADR-011 onward. Check before anything else:

```sh
kubectl -n frontend exec deploy/cigar-journal-main -c app -- ls /app
```

`token` must appear in that listing. It does not in `v0.26.1` (the tag
deployed on 2026-08-30) — that image predates the role, and the exec below
fails with `can't cd to /app/token`. The fix is the ordinary release path:
release-please cuts a release, `publish-image` ships the tag, the
haynes-ops HelmRelease bump deploys it.

## Running it

**`kubectl exec -it` into the running web pod is the only way to mint.**

```sh
kubectl -n frontend exec -it deploy/cigar-journal-main -c app -- \
  sh -c 'cd /app/token && node --import tsx src/cli.ts list'
```

`mint --yes` refuses to run unless its stdout is an interactive terminal, and
it refuses *before* writing anything. That is not a preference: a container's
stdout is collected into Loki for the whole retention window, so a Job or
CronJob mint would put the credential in a log sink. `kubectl exec -it`
allocates a pty and the API server proxies the stream straight to the
operator's terminal, where no collector can reach it. There is no flag to
override this and no Job manifest to fall back to — a second delivery path
would be a second copy of the secret.

The same applies to a pipe or a redirect: `… mint … --yes > token.txt` is
refused. Read the value off the terminal and paste it into 1Password.

`list` and `revoke` hold no secret material and run anywhere, `-it` or not.

The web pod's env supplies both `DATABASE_URL` and `BETTER_AUTH_URL` (from
`cigar-journal-secret`). `BETTER_AUTH_URL` is the RFC 8707 audience, so a
wrong origin fails fast instead of minting a token `/mcp` will reject.

## Mint

```sh
… mint --client-name dev-env-pod --user-email <owner> \
    --scope catalog:read --scope journal:read --scope journal:write \
    --ttl-days 365 --reason "dev-env pod MCP client" --yes
```

Run it once without `--yes` first. The dry run resolves the principal, finds
or reports the client, and applies the scope, TTL and audience checks against
the same database — so a clean plan means the apply will not fail on any of
them.

The token is printed once and is not recoverable. Capture it before the
terminal scrolls.

Only `catalog:read`, `journal:read` and `journal:write` are mintable.
`offline_access` is refused (there is no refresh chain) and so is
`curation:*` — it would let a browserless holder mutate the shared catalog
under the subject's admin role for the token's whole life. Both refusals are
enforced in the mint, not left to the caller's arguments. `--ttl-days` caps at
365 and can only shorten.

The mint is **not idempotent** — every run creates new material. Use `list` to
find an orphan and `revoke --id` to kill it.

## Rotate (overlap-safe)

Service tokens are independent rows with no refresh chain, so two are valid at
once. That is what makes this sequence safe:

1. `list` — note the active token id for the client and its days remaining.
2. `mint --client-name <same-name> … --yes` — capture the value. The client row
   is reused; both tokens are now valid.
3. Update the `CIGAR_JOURNAL_TOKEN` field on the 1Password `dev-env` item.
4. Force an ESO sync (or wait for `refreshInterval`):
   `kubectl -n dev annotate externalsecret dev-env-cigar force-sync=$(date +%s) --overwrite`.
   The consumer restarts on the new value.
5. Verify the consumer actually works on the new credential — an MCP
   `tools/list` is enough.
6. `revoke --id <old-token-id> --reason "rotated" --yes`.
7. `list` — exactly one active token for the client.

## First cutover (issue #129)

The dev-env pod runs on a hand-INSERTed token under the `dev-env-cli` client
that expires **2026-09-26**. Moving it to a minted one is the rotate sequence
above with two differences: step 2 uses a new `--client-name` (`dev-env-pod`),
so a client row is created rather than reused; and at step 6 the legacy
token's client row is deliberately left in place, because the audit trail
points at it.

Two preconditions, both outside this repo: the release carrying the `token`
role must be deployed (see Precondition), and haynes-ops#2681 must have landed
so the expiry monitor is not still pinned to `dev-env-cli`.

## Revoke

```sh
… revoke --id <uuid> --reason "rotated" --yes
```

By id only. A repeat is a no-op success. The dry run resolves ids exactly as
the apply does — including ordinary short-lived flow tokens, which is the id
you reach for when a connector's credential leaks. Revocation bites on the
**next** MCP call — `packages/mcp/src/auth.ts` validates per request with no
cache — so there is no propagation window. A flow-issued token takes its
refresh chain with it.

Emergency: step 6 alone. Nuclear: deleting the user cascades every token.

`list --all-clients` widens to every access token whose lifetime exceeds 24h
regardless of client, which is exactly "every token the 1h grant did not
issue" — use it to find hand-INSERTed rows.

## Deployment wiring

The credential reaches the dev-env pod as `CIGAR_JOURNAL_TOKEN`:

1. 1Password item `dev-env`, top-level field `CIGAR_JOURNAL_TOKEN`.
2. haynes-ops ExternalSecret `dev-env-cigar` → Secret `dev-env-cigar-secret`
   (haynes-ops#2673, a held draft).
3. The dev-env HelmRelease mounts that Secret `envFrom`, and `dev-init.sh`'s
   `envsubst` expands `Bearer ${CIGAR_JOURNAL_TOKEN}` into the registered MCP
   header.

Merging that HelmRelease change **restarts the dev-env pod**, so it lands as a
held draft at a natural break, and only after the 1Password field holds the
new value.

## Exposure

Anyone who can read the 1Password item, the Secret, or the pod env holds a
credential that acts as its user at `/mcp` for its whole life, with no consent
screen and no refresh heartbeat that would reveal theft. What bounds it:
explicit per-consumer scopes, audience binding, one client per consumer (so a
leak is attributable and revocable in isolation), per-request validation, a
delivery path no log collector can read, and rotation cheap enough to actually
do.

Expiry is a cliff. The daily `cigar-journal-credential-expiry` CronJob in
haynes-ops is the alert: a failing Job pages. Today it watches one pinned
`client_id`, so it must land haynes-ops#2681 — which selects every live token
whose lifetime exceeds 24h instead, and so follows a re-mint under a new
client with no edit — before this cutover, or it will report the retired
client as expired every morning. `list` remains the pull-based view.
