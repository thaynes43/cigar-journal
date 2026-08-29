# Session handoff — 2026-08-29 (DESIGN-003 catalog rework shipped)

For a cold-start agent. The durable backlog is GitHub issues (label `backlog`);
this file is the bridge: where the last session left prod, and what to pick up.
Overwrite it at the next major handoff.

## Where prod stands

- **v0.24.0** live and verified (web + mcp pods on the new image, health OK,
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
  v0.24.0.
- Owner's journal still `private`; public pages dark until the #97 flip
  (which can now be done from /settings instead of raw SQL).

## Owner-gated cutover (#97) — unchanged, do not do unprompted

ChatGPT connector verification · unsuspend crawl CronJobs · journal flip +
archive cutover (53 reviews) · owner's Micallef photo.

## Open backlog (rescoped 2026-08-29 — read the issues, bodies were rewritten)

- **#124 library catalog build** — wave 1 DONE; remainder = wave 6 filter
  chips (router overlay booleans + brand, chip popovers, counts).
- **#125 chrome** — DONE via #133 (left open only if follow-ups surface;
  close after verifying on prod).
- **#126 agent enrichment** — wave 3 primitives DONE; remainder = the
  `curate` batch role (Sonnet 5) + review/undo queue. Read the issue comment:
  two carry-forwards (crawler overwrites curator `unmatched` — needs
  `decided_by`; unmerge needs per-merge bookkeeping).
- **#127 product images** — untouched. Root cause quantified: all 853 photos
  from the one Fox seed; owner humidor 63/82 photoless (all 46 CC); 834
  type-NULL, 538 unbranded. Sequence in the issue.
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
