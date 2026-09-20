# Service tokens — operator runbook

Long-lived MCP credentials for clients that have no browser (ADR-011). The
mint is the `token` role on the app image; it is never reachable over HTTP.

```
service-token mint   --client-name <name> --user-email <email> --scope <s>... --reason <text>
                     [--allow-curation] [--ttl-days N | --no-expiry] [--resource <url>] [--yes]
service-token list   [--include-expired] [--include-revoked] [--all-clients]
service-token revoke --id <uuid> [--reason <text>] [--yes]
```

`mint` and `revoke` are dry-run without `--yes`; both dry runs read the
database and run the same validators as the apply. Exit codes: `0` ok, `1`
operational failure (unknown user, unknown token id, a non-admin subject asked
to carry curation scopes), `2` usage, env, or a refused delivery.

## Precondition

The `token` role ships in the app image, so it exists only from the release
that contains ADR-011 onward. Check before anything else:

```sh
kubectl -n frontend exec deploy/cigar-journal-main -c app -- ls /app
```

`token` must appear in that listing (verified on `v0.45.2`, 2026-09-19). An
image older than `v0.27.0` predates the role, and the exec below fails with
`can't cd to /app/token`.

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
    --no-expiry --reason "dev-env pod MCP client" --yes
```

Run it once without `--yes` first. The dry run resolves the principal, finds
or reports the client, and applies the scope, lifetime and audience checks
against the same database — so a clean plan means the apply will not fail on
any of them.

The token is printed once and is not recoverable. Capture it before the
terminal scrolls.

`catalog:read`, `journal:read` and `journal:write` are mintable with no extra
flag. `offline_access` is refused unconditionally — there is no refresh chain,
so no flag admits it. `curation:*` is off by default and needs the explicit
elevation below. Every refusal is enforced in the mint, not left to the
caller's arguments.

**Lifetime.** `--no-expiry` mints a token that is valid until revoked — the
owner's ruling of 2026-09-19 (ADR-011, "No expiry: the owner override"), and
the default choice for a standing consumer like the dev-env pod, because every
expiry there costs a manual re-mint, a 1Password edit and a pod restart that
ends the running agent session. It is permitted with `--allow-curation`. What
it gives up is the forced rotation that bounded an undetected theft; what still
bounds the token is its scopes, its audience, its own client, per-request
validation, and a revoke that bites on the next call.

Otherwise the token is dated: `--ttl-days` caps at 365 — 90 for a
curation-elevated mint — and can only shorten. The two flags are mutually
exclusive (exit 2). Neither output leaves you to infer which you got — the plan
prints

```
  ttl        none — valid until revoked
```

and the report

```
  expires    never — valid until revoked
```

where a dated mint prints its TTL and the date it lands on. `list` shows
`never` in EXPIRES and `-` in DAYS for such a row.

## Mint the curation lane's token (`--allow-curation`)

The daily curation lane needs `curation:*`, which the mint refuses by default
because it lets a browserless holder mutate the **shared** catalog under the
subject's admin role for the token's whole life. The owner overrode that
refusal on 2026-08-30 (ADR-011, "Curation scopes: the owner override") after
the lane's rotating refresh token failed once too often — each failure costing
a manual browser re-consent. A minted token has no rotation to lose.

Two gates, both required: the `--allow-curation` flag, and an **admin
subject** checked at mint time (exit 1 if not — the curation tools re-check
the role on every call, so a non-admin token would be inert).

Dry run first — it reads the database, resolves the subject, and checks the
role, so a clean plan means the apply will not fail on any of it:

```sh
kubectl -n frontend exec -it deploy/cigar-journal-main -c app -- \
  sh -c 'cd /app/token && node --import tsx src/cli.ts mint \
    --client-name dev-env-curate \
    --user-email <owner> \
    --scope curation:read --scope curation:write \
    --scope catalog:read \
    --allow-curation \
    --no-expiry \
    --reason "daily curation lane (ADR-011 override 2026-08-30)"'
```

`--no-expiry` applies to this token too — the 2026-09-19 ruling covers both the
ordinary journal token and the curation-elevated one — and it waives nothing
else: `--allow-curation` is still required, the subject must still be an admin,
and the elevation is still named in the plan, the report and the audit row.

Drop `--no-expiry` and the mint is dated instead: an elevated mint then defaults
to its own ceiling, **90 days**, not the ordinary 365, and passing
`--ttl-days 365` here is refused (`invalid_request`). `--ttl-days` shortens it
further if you want a probe token; it cannot be combined with `--no-expiry`.
Re-minting is one interactive exec at a moment you choose, with the old token
live until you revoke it; that is not the rotation this whole change exists to
stop losing.

The plan prints a line the ordinary mint does not:

```
  curation   ELEVATED — this token may curate the SHARED catalog for its whole life
```

Re-run the same command with `--yes` appended to mint. The report repeats that
line, then prints the token once.

**Delivery.** This token has no 1Password field. Its only consumer is the
curation lane on the dev-env-ops pod, which reads
`~/.local/state/cigar-curation/token.json`. Write it there from the same
terminal before the value scrolls away — run the first line, paste, press
Enter, then run the second:

```sh
printf "paste token, then Enter: "; IFS= read -rs T; echo
printf %s "$T" | kubectl -n upgrade-agent exec -i deploy/dev-env-ops -c app -- \
  sh -c 'umask 077; t=$(cat); [ ${#t} -ge 20 ] || { echo "empty token - nothing written" >&2; exit 1; }
         f=~/.local/state/cigar-curation/token.json
         jq -n --arg t "$t" "{access_token:\$t,expires_at:null}" >$f.new && mv $f.new $f && echo written'
```

The write refuses an empty value and restarts nothing; the lane reads the file
on its next run. `read -rs` is deliberate: bash's `read -p` means "coprocess"
in zsh, where it fails and leaves the variable empty (2026-09-19 — an empty
`access_token` was written over the working one). Then finish as a rotation
from step 5: verify an MCP `tools/list` on the new value from the ops pod, and
revoke the old id.

`--scope catalog:read` is there because the lane also reads the catalog outside
the curation surface; drop it if the lane only ever triages. `get_cigar`
accepts `curation:read` on its own.

The mint records `curationElevated: true` and the subject's role at mint time
on its `oauth.service_token.mint` audit row, so the elevation is auditable
without decoding a scope list:

```sql
select created_at, correlation_id, after->>'clientName', after->>'subjectRole', after->'scopes'
from audit_log
where action = 'oauth.service_token.mint' and (after->>'curationElevated')::boolean
order by created_at desc;
```

And every write the credential subsequently makes names the client that made it
(`audit_log.client_id`, migration 0024), which is what turns "one client per
consumer" into an answerable question after the fact:

```sql
-- what did this credential do, and when
select created_at, action, run_id, after->>'id'
from audit_log
where client_id = '<client_id from the mint report>'
order by created_at desc
limit 100;

-- which credentials have touched the catalog at all
select client_id, count(*), min(created_at), max(created_at)
from audit_log
where action like 'listing_match.%' or action like 'cigar.%'
group by client_id
order by max(created_at) desc;
```

A null `client_id` is NOT proof of the web console. It means "no client was
recorded", which covers three different things:

1. a genuine console write — a session-driven call, where no OAuth client exists;
2. any row written before this column shipped (migration 0024);
3. a **credential-less surface**, which records null by design: the crawler's
   vendor approval sync (runs from a file in the repo), this CLI's own
   mint/revoke rows, and invite redemption (no principal exists yet — that row is
   the sign-up). Their `actor` — `import`, `system`, `web` — is their marker; a
   pseudo-client would break the column's one useful guarantee, that a non-null
   value is an OAuth client id you can look up in `oauth_client` and revoke.

Everything else — journal, inventory, photos, settings, curation — now stamps the
calling credential. Treat null as unknown, not as the console.

Watch one trap when reading the mint/revoke rows: their `before`/`after` payloads
carry a `clientId`, which is the client the row is *about*, not the credential
that wrote it. That is why it is deliberately not copied into the column — doing
so would fold every mint into that credential's own activity in the query above.

What IS load-bearing: two rows for the same subject with DIFFERENT client ids are
two different credentials, which is the question worth asking during an incident.

The mint is **not idempotent** — every run creates new material. Use `list` to
find an orphan and `revoke --id` to kill it.

## Rotate (overlap-safe)

Service tokens are independent rows with no refresh chain, so two are valid at
once. That is what makes this sequence safe.

A no-expiry token never forces this; you run it on suspicion, on a schedule you
choose, or when the scopes change. The sequence is identical either way — the
old token stays live until step 6, so there is no window where the consumer has
none:

1. `list` — note the active token id for the client (`never` in EXPIRES if it
   is a no-expiry one, otherwise its days remaining).
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
above with two differences: step 2 uses a new `--client-name` (`dev-env-pod`)
and `--no-expiry`, so a client row is created rather than reused and the pod
never has to do this again; and at step 6 the legacy token's client row is
deliberately left in place, because the audit trail points at it.

```sh
… mint --client-name dev-env-pod --user-email <owner> \
    --scope catalog:read --scope journal:read --scope journal:write \
    --no-expiry --reason "dev-env pod MCP client (ADR-011 override 2026-09-19)" --yes
```

Both preconditions are met (verified 2026-09-19): the deployed image carries
the `token` role, and haynes-ops#2681 has landed, so the expiry monitor follows
the new client with no edit. The monitor keeps failing on the legacy token
until step 6 revokes it — a revoked token leaves its watch list.

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
   (haynes-ops#2673).
3. The dev-env HelmRelease mounts that Secret `envFrom`, and `dev-init.sh`'s
   `envsubst` expands `Bearer ${CIGAR_JOURNAL_TOKEN}` into the registered MCP
   header.

A changed Secret value **restarts the dev-env pod** (reloader) and ends every
agent session in it, so update the 1Password field at a natural break.

## Exposure

Anyone who can read the 1Password item, the Secret, or the pod env holds a
credential that acts as its user at `/mcp` for its whole life, with no consent
screen and no refresh heartbeat that would reveal theft. What bounds it:
explicit per-consumer scopes, audience binding, one client per consumer (so a
leak is attributable and revocable in isolation), per-request validation, a
delivery path no log collector can read, and rotation cheap enough to actually
do.

A `--allow-curation` token is the widest of these: it can curate the shared
catalog, not just its own subject's journal. Give it its own `--client-name`
so it is revocable without touching the pod's ordinary journal credential, and
revoke it the moment the lane stops needing it. A dated one has its shorter
ceiling (90 days) as a backstop if neither happens; a `--no-expiry` one does
not, so revoking it when the lane retires is the whole control.

**If one leaks, revoke it by id** — `revoke --id <uuid> --yes`, which bites on
the next MCP call and touches nothing else. Do *not* reach for demoting the
subject instead. The curation tools do re-check the role on every call, so it
looks like a fast kill, but prod has exactly one user and that user is the
admin: demoting him takes down the web console, the curation surface and every
other admin credential he holds, to stop one token. It does not even hold —
`packages/auth/src/auth.ts` re-asserts `admin` on session create for any
allowlisted address, so the owner's next sign-in silently re-arms the token he
was trying to neutralize. Find the id with `list` (or from the mint report) and
revoke it.

For a **dated** token, expiry is a cliff. The daily
`cigar-journal-credential-expiry` CronJob in haynes-ops is the alert: a failing
Job pages at 7 days left. It selects every unrevoked token whose lifetime
exceeds 24h (haynes-ops#2681), so it follows a re-mint under a new client with
no edit, and a rotation is not finished until the old token is revoked.

A `--no-expiry` token has no cliff, so there is nothing to count down and
nothing to page about. The monitor lists it as `no-expiry` rather than
computing days remaining, and it still counts as a live credential — "no dated
token is near expiry" must not be read as "no credential exists", or the check
that exists to fail loudly when the credential is missing starts failing
because it is permanent. Rotation becomes something you do on suspicion or on a
schedule you pick, through the same overlap-safe sequence above. `list` remains
the pull-based view, and shows `never` in EXPIRES and `-` in DAYS for such a
row.
