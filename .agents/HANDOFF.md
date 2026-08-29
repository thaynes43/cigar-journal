# Session handoff — 2026-08-29 (post go-live code queue)

For a cold-start agent. The durable backlog is GitHub issues (label `backlog`);
this file is the bridge: where the last session left prod, and what to pick up.
Overwrite it at the next major handoff.

## Where prod stands

- **v0.23.1** live and verified (web + mcp pods, health OK). The entire go-live
  code sequence #88–#97 is merged and deployed: detail-page rebuild, unified
  catalog + want/favorites, explicit consumption, price surfaces, 17-tool MCP
  (`browse_catalog`/`get_offers` verified live), public journal pages,
  curation pass done (35 clean brand shelves), cutover sweep applied.
- **Crawler CronJobs exist and are SUSPENDED** (`cigar-journal-crawl-offers`
  weekly Sun 08:00 UTC, `cigar-journal-crawl-enrich` daily 09:00 UTC, ns
  `frontend`). Unsuspend is a deliberate owner call:
  `kubectl patch cronjob -n frontend <name> -p '{"spec":{"suspend":false}}'`.
- **Owner's journal is still `private`.** Anonymous `/journal` 404s by design.
  Public pages are shipped but dark until the cutover flip.
- Prod DB got a one-off fix: Vega Fina `type` CC→NC.

## Owner-gated cutover (issue #97 — the only go-live issue still open)

Everything here needs Tom's go-ahead; do not do it unprompted.

1. **ChatGPT verification**: refresh the connector, start a NEW chat (schema
   cache is per-conversation — docs/mcp/client-compatibility.md), run the
   DESIGN-002 conversation set, date the compatibility matrix.
2. **Unsuspend the crawl CronJobs** (commands above).
3. **Journal flip + archive cutover**: `UPDATE users SET
   journal_visibility='public'` for the owner; verify all 53 archived reviews
   render on `/journal` (count vs `archive/` — the #96 PR body and issue #97
   carry the plan); then point MkDocs readers at `/journal`. Keep the archive
   publishable until Tom retires it (AGENTS.md).
4. Owner still intends to attach his real Micallef photo (upload-link path works).

## Open backlog (GitHub issues)

- **#45 curation tooling** — post-#95 comment lists the real gaps: listing-match
  confirm/unmatch curator functions (1778 auto matches untriaged), product-photo
  suppress/replace + `rights` honored (ADR-007 partial), non-cigar exclude
  (gift cards/samplers pollute shelves), crawler brand/line backfill (538
  unbranded rows), canonical-name rename tooling. Plus flagged data judgment
  calls (Cuba Divinos, doubled names, reversed CC names, La Nox cross-line
  matches).
- **#46 identity** — Authentik SSO, invite system, OG share cards. Public-pages
  slice already shipped; the rest is post-launch.
- **#48 ops hygiene** — spike/ removal, Playwright e2e suite, dev-env-cli OAuth
  token expires ~2026-09-26, RELEASE_PLEASE_TOKEN expiry, publish-image event
  reliability note. (The MCP Gatus probe already exists on haynes-ops main —
  a stale-clone read said otherwise; always `git fetch` the canonical clone.)
- **#49 UX follow-ups** — remainder only; load-more >25 and per-user dates were
  done in the #97 sweep.
- **#50 later-phase** — R11/R12, analytics, Deep Research.
- Deferred by design: web `price` sort on the All view (domain supports it;
  catalog-registry defers the UI), favorites facet/shelf, `get_cigar_prices`.

## How this repo is worked (hard-won, verify before trusting)

- Coordinator mode: the session agent dispatches Opus worktree lanes and owns
  design/text/review/ship. Fetch the canonical clone (`git -C
  ~/repos/cigar-journal fetch origin`) BEFORE dispatching — worktree isolation
  snapshots its last-fetched origin/main.
- Landing: cherry-pick the lane's commit onto a fresh `origin/main` branch in
  your own worktree, run the full suite (`pnpm lint/typecheck/test/build`),
  push, PR, squash-merge. The squash commit message comes from the branch
  commit, not the PR title — it drives release-please's version bump.
- Ship chain: release-please PR → tag → publish-image → haynes-ops HR bump PR
  (bump `helmrelease.yaml` AND `crawler-cronjobs.yaml` together) → flux
  reconcile (`kustomization cigar-journal` lives in ns `frontend`) → pod verify.
  `kubectl kustomize`/flux-local do NOT catch server-side typed-apply errors on
  raw manifests (raw CronJobs need list-form `env:`).
- UI features get a real anonymous/authed click-through on the local preview
  rig before ship — edge `middleware.ts` is invisible to unit tests and once
  bounced all anonymous traffic to /signin on a green branch.
- CI flakes: empty-commit retriggers (max 3); release-branch retrigger via
  `git commit-tree` + force-with-lease. Actions logs are egress-blocked from
  the pod; use the job-summary tail.
