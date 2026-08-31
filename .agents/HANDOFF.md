# Session handoff — 2026-08-30 evening (v0.28.0)

For a cold-start agent. The durable backlog is GitHub issues (label `backlog`);
this file is the bridge: where prod stands, what is in flight, and what is
actually blocked on whom. Overwrite it at the next major handoff.

## Where prod stands

- **v0.28.0 live and verified** — both pods, all four crawl CronJobs, migrations
  through **0024** applied, `/api/health` ok. Next free migration is **0025**.
- **SSO is live.** Authentik OIDC + invites (#46) shipped in #168; the owner
  created the Authentik application and the 1Password fields, and
  `cigar-journal-oidc` reports SecretSynced. `/signin` renders "Continue with
  Authentik". Local email+password sign-in is unaffected and stays the fallback.
- **THE SITE IS LIVE AND THE OWNER'S REVIEWS ARE PUBLIC** (flipped 2026-08-30).
  `users.journal_visibility = 'public'`; `/journal` and `/smokes/<id>` serve
  anonymously and review photos serve at `/api/photos/<id>`. Treat every change
  to those surfaces as user-facing from now on.
- **Catalogue: 970 active, 6 excluded** (all genuinely Fox gift cards), 914
  photos, ~1,549-row triage queue, **291 `listing_matches` with
  `decided_by='agent'`** that must stay protected.
- **The curation lane runs on a static service token now.** No more re-consent.
  Token id `c62463be-004f-467f-9372-b60c28bc1597`, client `dev-env-curate`,
  scopes `curation:read`+`curation:write`, **expires 2026-11-28** (90d — the
  elevated ceiling). State file `~/.local/state/cigar-curation/token.json` on the
  dev-env-ops PVC, `{access_token, expires_at, token_id}`, **read-only to the
  lane** (haynes-ops#2692). A 401 means re-mint, never re-consent.
- Vendors: **Fox Cigar** (NC, enrich daily 06:00 ET, offers Sun 08:00 ET) and
  **Cuban Lou's** (CC, offers Wed 08:00 ET; **enrich CronJob SUSPENDED** — that
  suspension is a workaround for #170, do not lift it until #170 lands).
  2 Guys and Small Batch remain `crawlEnabled: false`.

## Shipped today (v0.27.0 → v0.28.0)

#160 crawler sitemap sampling + root-slug gate + multi-sample probe · #162
unmerge bookkeeping + rename undo · #163 Wikidata brand covers · #165/#178
operator-minted service tokens (ADR-011) + `audit_log.client_id` · #166 the
packaging-SKU exclusion batch (documented, **not applied**) · #167 bulk-enqueue
enrichment · #168 SSO + invites · #171 measured tobacco ramp/seal/chips · #179
2 Guys product gate · #180 the embedded-Postgres teardown race · #181 per-vendor
enrichment budgets · #184 add_smoke_photo delivery diagnostics.
Closed: #45, #46, #48, #49, #126, #129, #154, #158, #174.

## IN FLIGHT — check this first

A four-lane burndown workflow was running when this session ended and **was
killed by the dev-env pod bounce**. It covers #170+#157+#155+#185,
#169+#183, #177+#173, and #159. Before starting anything:

```bash
git -C ~/repos/cigar-journal fetch origin --prune
GH_TOKEN=$(cat /creds/gh_token) gh pr list --repo thaynes43/cigar-journal --state open
GH_TOKEN=$(cat /creds/gh_token) gh pr list --repo thaynes43/haynes-ops --state open
ls ~/work/            # orphaned worktrees: enrichment-correctness, curation-guards,
                      # mcp-console-fixes, cj-cronjob-consolidation
git -C ~/repos/cigar-journal branch -r | grep agent/
```
Any of those lanes may have pushed a branch or opened a PR before dying. Adopt
what exists, `git worktree remove` what is stranded, and re-dispatch the rest.
**Do not assume a lane finished because its worktree exists.**

## Do these, in this order

Every one of these is unblocked. Nothing here waits on the owner.

### 1. Recover the killed burndown (first, before new work)
See "IN FLIGHT" above. Adopt surviving branches/PRs, `git worktree remove` the
stranded ones, re-dispatch the rest.

### 2. #170 — vendor-focus predicate on enrich matching
Highest priority defect on the board. A CC drain can answer an NC request and
attach a Habanos photo to a non-Cuban cigar; `product_photos` is
UNIQUE(cigar_id), so the wrong photo takes the only slot and is not merely a
display bug.
**`cigar-journal-crawl-enrich-cuban-lous` is SUSPENDED as the workaround for
this. Do not unsuspend it until #170 ships.** Unsuspending it is the last step
of #170, not a separate task, and it is what finally gives Cuban Lou's a
recurring enrich lane.

### 3. #169 — excludeCigar must refuse a cigar with purchase lots
Already cost the owner 23 sticks (three samplers hidden from his humidor). Refuse
for ANY user's lots, not just the caller's. Guidance already exists in the agent
manual (haynes-ops#2680) but guidance is not enforcement.

### 4. #177 — gap-fill drops the journal entry
Our own MCP instruction. Verified from Loki: the owner's whole session was
`browse_catalog`, `search_cigars`, `add_cigar` — no `save_smoke`, no errors.

### 5. Re-probe 2 Guys, then enable it (separate PRs)
v0.28.0 carries the corrected gate from #179 but the vendor has NOT been
re-probed. This is what gets a catalogue photo for brands Fox does not stock —
the owner's "Red Anchor Captain" case.

Run an in-cluster probe Job in ns `frontend` from the CURRENT image (build the
Job by taking a crawl CronJob's `jobTemplate` and replacing the command with
`--probe --vendor two-guys-cigars`; the dev pod cannot reach vendor domains, only
an in-cluster Job can):

```
kubectl -n frontend get cronjob cigar-journal-crawl-offers-fox-cigar -o json \
  | <swap container command to: node --import tsx src/cli.ts --probe --vendor two-guys-cigars> \
  | kubectl apply -f -
kubectl -n frontend logs job/<name> -c crawl
```

**The full acceptance checklist is in the review on PR #179 — read it before
judging the output.** Two points from it that catch a void run: the verdict must
be `ok`, and the gate line must read `prefix /store/ minus /^\/store\/go(?:\/|$)/i`
— if it still prints a bare `prefix /store/`, the Job ran a cached image and the
result means nothing. The last probe (2026-08-30, pre-fix) showed robots
allowing, `varied=no` across 4 samples (the sitemap variance is GONE), and 3/3
sampled URLs failing because `/store/` was matching `/store/go/registry/` pages.

Enabling is a SEPARATE PR from the probe, and green CI is not vendor
verification.

### 6. Codex-validate the photo path (owner requires this before he retests)
#184 shipped diagnostics against a live server, so this runs AFTER a deploy, not
against a branch. The validation plan is in PR #184's body. Be honest about the
ceiling: codex can prove server-side handling, the diagnostics firing, no secrets
in logs, and that the fallback never errors. It CANNOT prove whether ChatGPT's UI
binds an in-chat image — only the owner can exercise that.

### 7. Then the rest
#157, #155, #185, #183, #173, #156, #159, the #127 remainder, and the 44-row
packaging-SKU exclusion batch documented in `.agents/reference/catalog-exclusions.md`
(planned and gated, never applied — re-run its gate before applying, and the
selector must not touch anything the owner holds a lot for).

### Rules that bit us today
- Pre-assign a migration number per lane and put it in the lane's prompt. Next
  free is **0025**. #178 and #181 both took 0023.
- A red CI `test` job is now a REAL failure (#180 fixed the flake). Do not
  retrigger past one.
- On any image bump, check ALL FIVE pins — the HelmRelease anchor and the four
  CronJobs. Renovate bumps only the HelmRelease (#2689).

## Blocked on the owner — ONE thing

**Merge the dev-env PRs.** That is the entire list.
- haynes-ops **#2673** — `CIGAR_JOURNAL_TOKEN` into the pod env; fixes the dev pod's
  MCP 401 (the header currently registers as an empty `Bearer `).
- haynes-ops **#2684** — dev-env session docs.
- haynes-ops **#2683** — Renovate, dev-env image toolchain. Not ours, but it
  rebuilds the image, so take it in the same window.

All three bounce the dev-env pod, which is the only reason they are drafts.

Everything else that used to sit on him is DONE or reassigned to the agent:

- **Micallef photo — DONE.** He uploaded it. It is a `smoke_photos` row on
  `Micallef Orange Robusto` (a REVIEW photo). That cigar has no catalogue photo,
  which is correct and unrelated — the two are different tables and different
  things. Do not "fix" it by attaching the review photo to the catalogue.
- **Journal flip — DONE 2026-08-30.** `users.journal_visibility = 'public'`.
  Verified anonymously: `/journal` and `/smokes/<id>` went 404 → 200, a real
  browser renders the full review list with ratings, notes, descriptors and a
  working "Load more", and review photos serve at `/api/photos/<id>` and
  `/thumb` (200, image/jpeg). **His reviews are public now.** The only console
  error is the Cloudflare Insights beacon failing to resolve from this pod's
  egress allowlist — not a site defect.
- **MCP go-live verification (#97)** — drive it with **codex** as the ChatGPT
  proxy (the repo's testing standard) rather than asking him. Same for the #184
  photo-path validation. Codex cannot prove ChatGPT's UI binds an in-chat image;
  say so plainly instead of implying coverage.
- **#164 and #169's deeper half** — decide them yourself, conservatively,
  and write the reasoning into the issue so he can veto rather than author.

### #97 — what is actually left (all yours)

The flip was never the whole cutover. Remaining, from the issue:
1. Sweep the shipped surfaces against `docs/design/002-go-live-experience.md` —
   composition order, absent-when-empty sections, badge-row caps, facet/URL
   behaviour, mobile toolbar panning, `/inventory` redirects. File deltas, fix
   the small ones.
2. Empty-state audit: every surface degrades per the design doc (no offers / no
   holdings / no photo / zero-match facet) with the approved strings only.
3. MCP go-live verification: the DESIGN-002 conversation set green on the
   production connector, matrix dated in `docs/mcp/client-compatibility.md`.
4. Archive cutover: execute #96's plan — point MkDocs readers at the new site,
   verify every archived review renders (a PRD-001 success criterion), and keep
   the archive publishable until he retires it (AGENTS.md).
5. Docs: README + docs/README describe the launched product; remove stale
   "designed, unbuilt" claims.

Already satisfied and struck: the journal load-more past the 25 cap (#120 —
`public-journal-list.tsx` has it, confirmed live), per-user timezone (#120), and
the MCP Gatus probe (haynes-ops#2628).

## Operational truths learned the hard way today

- **`ops-digest.sh` was blanking every entry.** `jq -r '.[$k]'` already unwraps
  the JSON-string; piping that into `jq 'fromjson?'` hands fromjson an
  already-parsed object → error → `// {}`. Every digest ever sent read `[?]` /
  "no note". Fixed haynes-ops#2690. Watch for the same shape elsewhere.
- **The CI `test` flake is fixed** (#174/#180): `pool.end()` then `pg.stop()`
  raised an unhandled pool `error` (pg 57P01), failing runs where every test
  passed. A red `test` job now means a real problem — do not retrigger past one.
- **Renovate splits the image pins.** It bumps `helmrelease.yaml` only, leaving
  the four CronJob pins stale (happened 2026-08-30, fixed haynes-ops#2689).
  Check all five on every bump until #159 lands.
- **Concurrent lanes collide on migration numbers** — #178 and #181 both took
  0023. Pre-assign a number per lane and say so in the prompt.
- **Loki has everything**; the pod's Actions-log egress is blocked but
  `mcp__grafana-mcp__query_loki_logs` against `{namespace="frontend"}` answers
  most "what actually happened" questions in one query.
- **Adversarial review is earning its cost.** It caught an SSRF guard that
  allowed `127.evil.com` and `169.254.169.254`, a security doc claiming
  attributability the code did not have, and a change that would have hung 890
  of 977 catalogue rows. Do not skip the verify stage.

## How this repo is worked

Coordinator mode: the session agent designs, reviews and ships; worktree lanes
build. Fetch the canonical clone BEFORE dispatching. Landing: rebase onto fresh
`origin/main`, full suite, PR, squash-merge (the branch commit message drives
release-please; the release PR itself takes a REGULAR merge).
Ship chain and per-hop remedies: `.agents/reference/ship-chain.md`.
`gh` needs `GH_TOKEN=$(cat /creds/gh_token)` — the env var is stale and 401s.
UI lanes must produce before/after screenshots from the local preview rig.
