# Service tokens — operator runbook

Long-lived MCP credentials for clients that have no browser (ADR-010). The
mint is the `token` role on the app image; it is never reachable over HTTP.

```
service-token mint   --client-name <name> --user-email <email> --scope <s>... --reason <text>
                     [--ttl-days N] [--resource <url>] [--yes]
service-token list   [--include-expired] [--include-revoked] [--all-clients]
service-token revoke --id <uuid> [--reason <text>] [--yes]
```

`mint` and `revoke` are dry-run without `--yes`. Exit codes: `0` ok, `1`
operational failure (unknown user, unknown token id), `2` usage or env error.

## Running it

**Preferred — `kubectl exec` into the running web pod.** The token appears on
the operator's terminal and is never collected into Loki.

```sh
kubectl -n frontend exec -it deploy/cigar-journal-main -c app -- \
  sh -c 'cd /app/token && node --import tsx src/cli.ts list'
```

**Fallback — the one-shot Job**
(`kubernetes/main/apps/frontend/cigar-journal/app/service-token-job.yaml` in
haynes-ops, suspended/on-demand). Use it when exec is unavailable. The Job's
stdout — which on a mint IS the token — lands in the container log and
therefore in Loki for the whole retention window. If you mint this way:
`kubectl logs` it, capture, then `kubectl delete job` immediately, and treat
the credential as on a clock.

Either path needs `DATABASE_URL`, and `mint` additionally needs
`BETTER_AUTH_URL` — it is the RFC 8707 audience, so a wrong origin fails fast
instead of minting a token `/mcp` will reject.

## Mint

```sh
… mint --client-name dev-env-pod --user-email <owner> \
    --scope catalog:read --scope journal:read --scope journal:write \
    --ttl-days 365 --reason "dev-env pod MCP client" --yes
```

**stdout is exactly the token, one line.** The report goes to stderr. The
value is not recoverable — capture it into 1Password before the terminal
scrolls.

Mint the minimum scope set. `curation:read`/`curation:write` let the holder
mutate the shared catalog under the subject's admin role for the token's whole
life; the dev-env pod does not need them.

The mint is **not idempotent** — every run creates new material. A Job that
dies after the INSERT but before capture leaves a live token nobody holds; run
with `backoffLimit: 0` / `restartPolicy: Never`, and use `list` to find
orphans.

## Rotate (overlap-safe)

Service tokens are independent rows with no refresh chain, so two are valid at
once. That is what makes this sequence safe:

1. `list` — note the active token id for the client and its days remaining.
2. `mint --client-name <same-name> … --yes` — capture stdout. The client row
   is reused; both tokens are now valid.
3. Update the 1Password field the ExternalSecret reads.
4. Force an ESO sync (or wait for `refreshInterval`); the consumer restarts on
   the new value.
5. Verify the consumer actually works on the new credential — an MCP
   `tools/list` is enough.
6. `revoke --id <old-token-id> --reason "rotated" --yes`.
7. `list` — exactly one active token for the client.

## Revoke

```sh
… revoke --id <uuid> --reason "rotated" --yes
```

By id only. A repeat is a no-op success. Revocation bites on the **next** MCP
call — `packages/mcp/src/auth.ts` validates per request with no cache — so
there is no propagation window. A flow-issued token takes its refresh chain
with it.

Emergency: step 6 alone. Nuclear: deleting the user cascades every token.

`list --all-clients` widens to every access token whose lifetime exceeds 24h
regardless of client, which is exactly "every token the 1h grant did not
issue" — use it to find hand-INSERTed rows.

## Deployment wiring

The credential reaches the dev-env pod as `CIGAR_JOURNAL_TOKEN`:

1. 1Password item `dev-env`, top-level field `CIGAR_JOURNAL_TOKEN`.
2. haynes-ops ExternalSecret `dev-env-cigar-journal` →
   `dev-env-cigar-journal-secret`.
3. The dev-env HelmRelease mounts it `envFrom`, and `dev-init.sh`'s `envsubst`
   expands `Bearer ${CIGAR_JOURNAL_TOKEN}` into the registered MCP header.

Merging that HelmRelease change **restarts the dev-env pod**, so it lands as a
held draft at a natural break, and only after the 1Password field exists.

## Exposure

Anyone who can read the 1Password item, the Secret, the pod env, or a mint
Job's log holds a credential that acts as its user at `/mcp` for its whole
life, with no consent screen and no refresh heartbeat that would reveal theft.
What bounds it: explicit per-consumer scopes, audience binding, one client per
consumer (so a leak is attributable and revocable in isolation), per-request
validation, and rotation cheap enough to actually do.

Expiry is a cliff. `list` reports days remaining, but that is a pull, not an
alert — put the expiry date on a calendar until the alerting follow-up lands.
