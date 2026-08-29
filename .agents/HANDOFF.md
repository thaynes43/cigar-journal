# Session handoff — 2026-08-29 night (v0.26.1: full board sweep, vendors live)

For a cold-start agent. The durable backlog is GitHub issues (label `backlog`);
this file is the bridge: where the last session left prod, and what to pick up.
Overwrite it at the next major handoff.

## Where prod stands

- **v0.26.1** live and verified. The evening five-lane wave (all merged +
  deployed): markdown fidelity (#146 — react-markdown whitelist, unblocks the
  #97 flip), review console with agent-runs list + per-row Undo (#149),
  vendor expansion (#147/#150 — decided_by re-crawl guard, purchase_linkout
  posture, probe CLI, approved-list import), OAuth loopback fix (#144,
  prod-verified, #140 closed), Playwright e2e suite (#148 — 17 specs, own CI
  job). Issues #124/#125/#126/#128/#140 all closed.
- **Crawls are LIVE** (owner directive superseded the launch gate): offers
  weekly Sun 08:00 UTC, enrich daily 09:00 UTC (first run verified: 1 photo).
  **Cuban Lou's crawl_enabled** (photos + price seeds, purchase_linkout=false
  — never a buy destination, unapproved-source labeled). First seed:
  987 pages, 890 parsed, 807 non-cigar skipped, 83 auto, 56 created, 82
  offers, 60 photos. Catalog photos 853→914; CC 1→6; owner humidor
  photoless 63→55 — remainder closes via curation-agent triage (1,569 in
  queue), human merges of owner↔crawler dup pairs (console), and uploads.
- **2 Guys DISABLED**: robots/ToS fine but its sitemap content VARIES between
  fetches (1,462 /store/ locs, then 0) — needs variance handling (#127).
  **Small Batch DISABLED**: root-level slugs, needs negative-prefix gate.
  Probe nit: sample N locs, not the first (#127).
- **v0.25.1** shipped earlier. On top of 0.24.0 (below): filter chips
  (#136 — Brand/In stock/Smoked/Favorites, wave 6 done, #124 closed), the
  curator product-photo upload path (#139 — direct + phone upload-link +
  "Missing photos" worklist of the owner's 63 photoless holds), the MCP
  curation tool surface (#138 — curation scopes, 7 tools, actor='agent'
  attribution), and run_id→text (#141, migration 0016).
- **The curation agent is OPERATIONAL** (dev-env-ops wo-* lane, daily 10:15
  ET; cigar-journal #126 + haynes-ops #2659/#2662). First run 2026-08-29:
  300/300 writes, 0 errors — 291 wrong listing matches cleared, 9 non-cigar
  rows excluded; queue after: triage 1487, untyped 828, unbranded 532.
  OPERATING MANUAL: memory `curation-lane-ops` (rotating token on the ops
  PVC, requeue = kill post-mortem window + ops-SA Job, epoch CM stamps).
  Surface gaps queued on #126 (exclude→triage cascade, get_cigar scope).
- **OAuth loopback bug #140**: authorize normalizes incoming loopback
  redirect_uris to localhost but matches stored literals — register clients
  with BOTH forms until fixed.
- **v0.24.0** shipped earlier today (web + mcp pods on the new image, health OK,
  anonymous `/cigars` → signin, `/curation` → `/admin/catalog` 307). Ships:
  - **DESIGN-003 waves 1–3** (docs/design/003-library-catalog.md — the
    corrective spec after the owner rejected the v0.23 catalog IA): `/cigars`
    is the full-bleed unified cigar grid (auto-fill minmax, labeled Own/Type/
    Sort rails, price sort, result count, $n /stick tiles, 3:4 art, shelf
    strips with fade + hover paddles + See all); avatar user menu (Settings ·
    Ledger · Catalog review · Sign out); `/settings` v1 (display name,
    journal visibility — the #97 flip now has a UI — timezone, wired into
    LocalDate); `/admin/catalog` (renamed Catalog review); curation/rights
    primitives (rights-honored photo reads, setListingMatchStatus,
    catalog_status + exclude/restore, tombstone merge, audit
    run_id/confidence/reverts + actor 'agent'; migrations 0012–0014).
  - **add_cigar disambiguation fix** (owner-reported live MCP bug): optional
    `confirmedDistinct` + strong-link guard tightened (one-sided model
    numbers and packaging tokens never silently link; curation dup queue uses
    the same guard). Additive schema change → the ChatGPT connector needs a
    **refresh + NEW chat** before retesting (docs/mcp/client-compatibility.md).
- **Crawler CronJobs still SUSPENDED** (owner-gated, #97). Both now pinned to
  v0.25.1.
- Owner's journal still `private`; public pages dark until the #97 flip
  (which can now be done from /settings instead of raw SQL).

## Tomorrow morning (cold start): verify the overnight automations FIRST

1. **Enrich crawl** (daily 09:00 UTC, ns frontend): `SELECT kind,status,stats
   FROM crawl_runs ORDER BY started_at DESC` via memory `prod-db-read-access`.
   Fox + Cuban Lou's are crawl_enabled; expect photos/offers movement.
2. **Curation run** (daily 10:15 ET on dev-env-ops): order
   `wo-cigar-curate-<yyyymmdd>` in CM `upgrade-work-orders` (ns
   upgrade-agent). Ops manual: memory `curation-lane-ops` — includes the
   requeue procedure (kill post-mortem tmux window + ops-SA Job) and the
   rotating-token model. It now has ~1,569 triage rows incl. 82 fresh
   Cuban Lou's matches; expect confirms to start attaching CC context.
3. Report counts + queue depths + humidor photoless delta (was 55) to the
   owner; surface the **duplicates queue** count — it now holds
   owner-row↔crawler-row CC pairs and MERGES ARE HUMAN-ONLY (web console),
   so the owner clears those on Catalog review.
4. Then work the backlog (priorities: #127 remainder — 2 Guys
   sitemap-variance, Small Batch negative-prefix gate, probe multi-sample,
   Wikidata fallback; #45 unmerge bookkeeping + rename undo; #48 remainder;
   #129 token expiry ~Sep 26 is the only dated item).

Session worktrees under ~/work/ are disposable; canonical clones are
fetch-only. The 2026-08-29 sessions' scratch (probe dossiers etc.) is fully
captured in issue comments + memory — nothing lives only in /tmp.

## Owner-gated cutover (#97) — unchanged, do not do unprompted

ChatGPT connector verification · unsuspend crawl CronJobs · journal flip +
archive cutover (53 reviews) · owner's Micallef photo.

## Open backlog (rescoped 2026-08-29 — read the issues, bodies were rewritten)

- **#124/#125 CLOSED** (chips #136, chrome #133 — verified on prod).
- **#126 agent enrichment** — agent RUNNING (see above). Remainder: the
  review/undo web UI on /admin/catalog; exclude→triage cascade; get_cigar
  scope for curation tokens; crawler `decided_by` guard (curator `unmatched`
  survives re-crawls); unmerge bookkeeping.
- **#127 product images** — step 1 (upload path + worklist) SHIPPED #139;
  remainder: agent photo-attach, 2 Guys/Small Batch adapters (live robots/ToS
  read first; CI dropped), CC sources per ADR-006, Wikidata fallback, tile
  thumb-URL fingerprinting (Replace cache staleness, noted on the issue).
- **#140 OAuth loopback redirect bug** — new, evidence matrix on the issue.
- **#128 public journal markdown fidelity** — should land before the #97 flip.
- **#129 dev-env-cli OAuth token expires ~2026-09-26** — only hard-dated item.
- **#45** destructive-op curation surface (renameCigar still unbuilt) ·
  **#46** SSO + invites (UI slots into /settings) · **#48** e2e suite etc. ·
  **#49** cosmetic nits · **#50** parking lot.

## How this repo is worked (verify before trusting)

- Coordinator mode: session agent designs/reviews/ships; Opus worktree lanes
  build. Fetch the canonical clone BEFORE dispatching (isolation snapshots its
  last-fetched origin/main). Landing: cherry-pick onto fresh origin/main,
  full suite, PR, squash-merge (branch commit message drives release-please).
- **Concurrent-lane trap (hit 2026-08-29):** two lanes minted the same
  migration number (0012) — renumber at landing; lanes based pre-merge also
  both edit consumption-backfill.test.ts. Check migration numbering on every
  db-touching lane.
- **gh token trap:** the shell's `GH_TOKEN` env goes stale between refreshes
  and 401s; `/creds/gh_token` (mounted, 40-min refresh) is authoritative —
  prefix gh calls with `GH_TOKEN=$(cat /creds/gh_token)`. Note: `gh api user`
  is always 403 for the app token; test with a repo call instead.
- **CI/local flake:** `migrations.test.ts` (embedded-PG startup under
  parallel load) fails ~1 in 3 full runs — different file each time, always
  green on re-run/retrigger (max 3 empty-commit retriggers per house rule).
- Ship chain: release-please PR (regular merge) → tag fires publish-image →
  haynes-ops bump PR (helmrelease.yaml &mainImage ~line 44 AND both image
  pins in crawler-cronjobs.yaml) → `flux reconcile source git haynes-ops -n
  flux-system` (the source is named haynes-ops, NOT flux-system) → kustomization
  cigar-journal + helmrelease (ns frontend) → pod verify. Declare the rollout
  with declare-activity (scope frontend,cigar-journal).
- UI lanes must run the local preview rig + screenshots (memory:
  local-preview-rig); the wave-2 lane caught a real popover-clipping bug only
  via screenshots — keep requiring them.
- Prod DB read access for audits: memory `prod-db-read-access`
  (kubectl -n database exec postgres16-1, db cigar_journal, SELECT only).
