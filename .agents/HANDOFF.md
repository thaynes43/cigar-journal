# Session handoff — 2026-08-31 pre-dawn (v0.28.0 + overnight fixes)

For a cold-start agent. The durable backlog is GitHub issues (label `backlog`);
this file is the bridge: where prod stands, what shipped overnight, and the
ordered queue for the 2026-08-31 daytime (ultracode) session. Overwrite it at
the next major handoff. Every factual claim below was verified against live
state on 2026-08-31 ~02:00–03:00 UTC; the previous handoff carried eleven
verified errors, so trust this revision over memory of the old one.

## Where prod stands

- **v0.28.0 live on both pods**, `/api/health` ok. Migrations through **0024**
  applied. Migration numbers are pre-assigned: **0025 = held PR #192**,
  **0026–0027 = taxonomy (#196)**, **0028+ = reviews (#199)**. A new lane takes
  the next number after those and says so in its prompt.
- **The site is live and the owner's reviews are public.** `/journal` and
  `/smokes/<id>` serve anonymously. Overnight, malformed ids on those routes
  went 500 → 404 and public photo bytes became revocable
  (`public, max-age=300, must-revalidate` + `Vary: Cookie`) — treat every
  change here as user-facing.
- **Catalogue: 971 active, 6 excluded** (Fox gift cards), 914 photos, **591**
  `listing_matches` with `decided_by='agent'` that must stay protected (the
  old handoff's 291 was one day's audit count, not the row total).
- **Crawl CronJobs are consolidated into the HelmRelease** (haynes-ops
  #2693+#2694, merged 02:17/02:21 UTC): one `&mainImage` pin now moves all six
  containers. Schedules are **UTC**, not ET: Fox enrich daily 06:00, Fox
  offers Sun 08:00, Cuban Lou's offers Wed 08:00, Cuban Lou's enrich Tue/Thu/
  Sat 06:00 — and that last one is **SUSPENDED as the #170 workaround; do not
  lift until the #192 rework ships** (unsuspending is that work's final step).
  The k8tz webhook stamped `America/New_York` on the recreated CronJobs
  (it unconditionally overwrites `spec.timeZone` on CREATE — invisible to
  flux-local, which cannot simulate admission webhooks); fixed and verified
  the same night via `k8tz.io/inject: "false"` annotations (haynes-ops
  **#2698**, HR v41, all four live on `Etc/UTC`).
- **The curation lane runs on a static service token.** Token id
  `c62463be-004f-467f-9372-b60c28bc1597`, client `dev-env-curate`, scopes
  `curation:read`+`curation:write`, expires 2026-11-28. State file
  `~/.local/state/cigar-curation/token.json` on the dev-env-ops PVC, read-only
  to the lane. A 401 means re-mint, never re-consent.
- Vendors: Fox Cigar (`focus='NC'`) and Cuban Lou's (`focus='CC'`) crawl;
  2 Guys, BR, CI, Mr. Cigar, OC, RSVP are registered but disabled; there is
  **no Small Batch row** in the prod registry (its adapter exists in code).
  **Vendor enablement is gated: nothing new is enabled until taxonomy
  matching v2 lands (ADR-012 / #196 Wave 5).** Re-probes are fine.
- SSO (Authentik OIDC + invites) live; local email+password stays the
  fallback. Nothing is blocked on the owner except one design ruling (below).

## Shipped overnight (2026-08-31, 02:00–03:00 UTC)

An audited review-and-repair pass over the previous day's work:

- **cj #190 merged** — excludeCigar refuses held inventory (#169) + audit
  client attribution (#183). Its "blocker" hold was disproven by inspection:
  `applyInverse` only ever restores prior status; the sole `excluded` write
  site sits behind the guard in-transaction (reasoning on the PR).
- **cj #194 merged** — the reviewed-clean #173 half of #188 (agent-run console
  pagination), split out cleanly; #188 now carries only the #177 rework.
- **cj #197 merged** — `fetchBinary` bounds downloads in two layers; both
  crawler image paths capped (vendor product photos had **no** bound at all).
- **cj #200 merged** — public 404s + revocable photo caching (above).
- **haynes-ops #2693 + #2694 merged** in strict order with cluster
  verification between (Helm v40); the k8tz timezone stamp was the one field
  that failed verification, remediated in **haynes-ops #2698** (Helm v41,
  verified live), after which **cj #189** (one-image-pin docs) merged.
- **cj #195 merged** — stale-text cleanup (the `--ttl-days` usage string now
  keys the 90-day ceiling on granted scopes; the public-reads impression
  comment says what the code does). Most of its migration-number fixes turned
  out to be already fixed by #190 — the overnight audit ran pre-#190.
- **ADR-012** (structured taxonomy) and **ADR-013** (external reviews and
  blend aggregates) written; backlog issues **#196** and **#199** carry the
  build plans.

## Do these, in this order (the ultracode session)

### 0. Close out the overnight tail
Take the release-please PR through (REGULAR merge, not squash) and deploy:
post-consolidation there is ONE image pin (`&mainImage` in helmrelease.yaml).
Two one-line follow-ups from #200's review: `smokes.delete` still takes bare
`z.string()`, and MCP `get_smoke` passes a malformed id straight to the
domain — both authenticated-only 500s, fix in passing.

### 1. Taxonomy — ADR-012, issue #196, Waves 0–2
The main event, and the gate for everything crawler-shaped. Wave 0 docs
alignment (supersede the DDD "resists hierarchy" wording; industry-vocabulary
reference; **DESIGN-004 stays on the driving session** — owner-facing design).
Wave 1 schema + brand registry (migration 0026). Wave 2 write paths +
matching v2 (0027). Read the ADR before decomposing; the prod evidence that
justifies every decision is summarized in it.

### 2. #192 rework (fixes #170) — then unsuspend Cuban Lou's enrich
Cheapest correct path per the overnight audit: set `vendors.focus='both'` for
Cuban Lou's (it sells Habanos AND Dominican/Nicaraguan bundles — ~39 of its
56 CC inferences are wrong), which collapses the false evidence to `unknown`
with zero algorithm change; then close the residuals the review found: the
seed-path fall-through to `createCigarFromListing` after a cross-market
refusal, and `mayWriteCatalogPhoto('both', …)` returning true (photo
authority needs its own gate — `vendors.focus` currently conflates "what it
sells" with "what it is authoritative about"). Rebase over main (#190 landed
five shared files). Migration 0025 is this PR's. Unsuspending
`cigar-journal-crawl-enrich-cuban-lous` is the LAST step, not a separate task.

### 3. #177 rework (in #188) — one owner ruling needed
Wrap/move `resolveAndEnrich` so an enrichment failure can never roll back the
journal entry (it currently runs inside the save transaction with no
try/catch — "never trade the entry for the enrichment" is the PR's own stated
priority). **The documented-path inversion is the owner's call** (issue #177
scope item 3): push that one question via AskUserQuestion when he's around;
do not decide it in a lane.

### 4. Taxonomy Waves 3–4, then reviews (ADR-013 / #199)
Wave 3 backfill curation (565 unbranded rows, collapse-bucket splits — the
Padron rows serving 8–12 products each; audited, conservative, reversible).
Wave 4 read surfaces + facets per DESIGN-004. Then #199: review_observations,
critic/journal aggregates, halfwheel + Habanos reference sources (each needs
a GitOps egress allowlist entry before it can fetch).

### 5. 2 Guys re-probe (probe only)
The corrected gate from #179 is deployed but never re-probed. Run the
in-cluster probe Job (recipe + acceptance checklist in PR #179's review; the
gate line must read `prefix /store/ minus /^\/store\/go(?:\/|$)/i`, verdict
`ok`). **Enabling stays gated on #196 Wave 5** — do not enable on a green
probe alone.

### 6. Codex-validate the photo path (#184) after the deploy
Validation plan in PR #184's body. Codex proves server-side handling and
diagnostics; it cannot prove ChatGPT's UI binds an in-chat image — only the
owner can. Say so; don't imply coverage.

### 7. #97 remainder
Sweep shipped surfaces against `docs/design/002-go-live-experience.md`;
empty-state audit; MCP client matrix dated in
`docs/mcp/client-compatibility.md`; archive cutover per the (closed) #96 plan
— MkDocs readers point at the new site, every archived review renders, the
archive stays publishable until the owner retires it. Then README/docs
describe the launched product.

## Blocked on the owner — one ruling, zero merges

The #177 documented-path inversion (queue item 3). Everything else is agent
work. (The old handoff's "merge the dev-env PRs" section is void — haynes-ops
#2673/#2684/#2683 all merged 2026-08-31 ~01:12 UTC. Side effect: the dev pod's
MCP 401 fix is live — verify `claude mcp list` shows cigar-journal healthy on
the next session start.)

## Rules that bite

- **Pre-assign migration numbers** (see the ledger at the top). #178/#181
  collided once already.
- **A red CI `test` job is usually real** (#180 fixed the main flake) — but
  one survivor is documented on #174: `auth.test.ts` drives the ambient
  `@cj/db` singleton pool with no error listener, so pg `57P01` can still
  fail a green run. Check the failure shape before retriggering; never
  retrigger past one.
- **One image pin** post-consolidation: the `&mainImage` anchor in
  helmrelease.yaml moves all six containers; haynes-ops
  `scripts/crawl-cronjob-invariants.sh` asserts they stay in step (not yet
  wired into CI).
- **k8tz overwrites `spec.timeZone` on every CronJob CREATE** (not
  fill-when-absent — proven from source and managedFields), flux-local cannot
  see admission webhooks, and the HelmRelease has drift detection off. The
  four crawl CronJobs carry `k8tz.io/inject: "false"` since haynes-ops #2698;
  any NEW CronJob that must not run NY time needs the same annotation, and
  after anything that CREATEs one, verify `spec.timeZone` live.
- **`gh` env token goes stale mid-session** — on a 401, prefix commands with
  `GH_TOKEN=$(cat /creds/gh_token)`.
- **Fetch the canonical clone before dispatching lanes** — its local `main`
  sits ~170 commits behind; always branch worktrees from `origin/main`
  explicitly.
- UI lanes produce before/after screenshots from the local preview rig; codex
  drives MCP testing as the ChatGPT proxy.

## Operational truths still standing

- **Loki answers "what actually happened"** in one query:
  `{namespace="frontend"}` via grafana-mcp. The pod cannot reach Actions logs.
- **Adversarial review keeps earning its cost** — tonight it caught a false
  blocker (#190's hold) as well as real ones, and the overnight audit found
  eleven wrong claims in the previous handoff. Verify before acting on any
  inherited claim; the collapse-bucket and mis-link evidence in ADR-012 came
  from exactly that discipline.
- The 44-row packaging-SKU exclusion batch in
  `.agents/reference/catalog-exclusions.md` is planned, gated, and
  **superseded in approach by ADR-012** (merge into base rows beats
  excluding). Do not apply it as written; fold it into #196 Wave 3.
