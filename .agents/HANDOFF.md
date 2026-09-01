# Session handoff — 2026-08-31 evening (v0.31.1)

For a cold-start agent. The durable backlog is GitHub issues (label `backlog`);
this file is the bridge. Overwrite it at the next major handoff. Everything
below was verified against live state as it happened; the day ran the full
build-verify-fix-merge-deploy cycle eleven times without a single unreviewed
merge.

## Where prod stands

- **v0.31.1 live** (sixth deploy of the day: 0.28.1 → 0.29.0 → 0.30.0 →
  0.31.0 → 0.31.1), both pods 1/1, health 200. Migrations through **0027**
  applied. Ledger: **0028 = open PR #222** (reviews slice 1); 0029 (accent-key
  cleanup) and **0030 (#240, enrich `no_candidate` + open-ask ledger reset)** are
  since taken, so next free is **0031**. A new lane pre-assigns its number here
  and says so in its prompt.
- **The taxonomy program (ADR-012, #196) is BUILT and DEPLOYED through Wave 4:**
  registries + backfill (0026), matching v2 under the positive-evidence rule
  (0027 — an existing link is never broken by registry silence, only by a
  parse that positively resolves elsewhere), the four curation verbs
  (`register_taxonomy`, `update_registry_aliases`, `assign_cigar_taxonomy`,
  `split_cigar` — 30 MCP tools total), and the DESIGN-004 catalog UI
  (group-card views, drill-as-filter URLs, per-level registries, the Unfiled
  card). Mint-time slugs fold accents since v0.31.1.
- **Wave 3 data campaign is EXECUTING**: work order
  `wo-cigar-wave3-batch1-20260831` (ConfigMap `upgrade-work-orders`, ns
  `upgrade-agent`) on the dev-env-ops curate lane — 60 vetted marcas + 3
  alias fixes applied ungated; 8 accented marcas gated on v0.31.1 (gate now
  open; the lane's next tick applies them with a Cavalier Genève →
  `cavalier-geneve` read-back check). Target: 36 → 96 registered brands.
  The full campaign (batches 2–4: unbranded-570 sweep, top-brand
  lines/blends, collapse-bucket splits) is the 2026-08-31 work order on #196.
- **Tomorrow morning is the measurement**: Tue 2026-09-01 06:00 UTC runs the
  first matching-v2 crawl AND the first-ever Cuban Lou's enrich drain. Read
  `crawl_runs.stats`: `linksAnnotated`/`linksNoAnchor` against the recorded
  baseline (603/992 titles anchored nothing pre-registry), and
  `photoRefusedVendors` for the known head-of-line watch (a photo_refused ask
  stays open by design; if the CL lane pins on the ten oldest Fox-stocked
  asks, the open-set ordering needs a follow-up; lever is `crawl_enabled`).
- Vendors: Fox (NC) + Cuban Lou's (**both** — corrected from CC) crawl, all
  four CronJobs unsuspended, `Etc/UTC`, k8tz opt-out annotations in place.
  2 Guys: gate fix proven but the vendor moved — products live outside
  `/store/` entirely; adapter rework is #217, enable additionally gated on
  #196 Wave 5. Issue #170 closed (fix deployed; Tuesday's drain verifies).
- **#97 (go-live cutover) is CLOSED**: archive cut over with 36/36 archived
  reviews verified anonymously reachable (PRD-001 criterion met), docs
  describe the launched product; residue is #219.

## In flight — one PR, one tick

- **PR #222** (reviews slice 1 — ADR-013: `review_observations`,
  `vendors.kind`, two-population aggregates, migration 0028): verify round
  found 10 findings; the fix round is applying them PLUS the owner's fresh
  ruling — **the journal score is one voice per journal** (per-user means
  aggregated across users; count = journals; amendment note in ADR-013 §3).
  When green: merge, release, deploy — then slice 2 (halfwheel adapter +
  egress allowlist via GitOps, MCP/UI score surfaces).
- The curate lane's Phase 2 tick (8 accented marcas). Verify via
  `select count(*) from brands` reaching 96 and the #196 thread.

## Do these, in this order

1. **Read Tuesday's 06:00 UTC crawl** (above) and post the measurement on
   #196. If `linksNoAnchor` did not drop materially against 603, the marca
   registry needs batch-1 follow-up before batch 2.
2. **Land #222** (fix round → CI → merge → release → deploy; migration 0028
   applies). Then dispatch reviews slice 2 per #199.
3. **Wave 3 batches 2–4** via curate-lane work orders per the campaign order
   on #196: the unbranded-570 sweep (the Alec Bradley factory-seconds
   exclusion is written into the order — a "Factory Second" name must never
   auto-attach to the named brand), then top-brand lines/blends, then the
   collapse-bucket splits (**file editions before splitting** — the
   get-or-create tuple match can over-match sparsely structured rows).
4. **Owner-facing follow-ups**, one at a time when he's active: the photo
   retest (#202 experiment 1 is live: refresh the connector, new chat, attach,
   call — the probe answers), and the Cuban/NC homonym marcas ruling
   (El Rey del Mundo, Saint Luis Rey, Fonseca — held out of batch 1; need
   per-listing evidence and a homonym-handling decision).
5. **Standing small items**: #219 (go-live residue — the winston-churchill.md
   archive mis-link needs Wave-3-grade care, owner history), #206
   (malformed-id sweep), #210 (approved-import CC hardcode), #217 (2 Guys
   adapter), haynes-ops#2705 (crawl CronJob migrate init container — until it
   lands, verify the empty crawl window on every deploy).

## Rules that bite (updated)

- **Adversarial verify before merging any substantive PR.** Today it caught:
  a would-be catalog-doubling matcher defect, a 603-link mass-unlink, a
  deploy-aborting btree overflow, a split verb minting bare-"Robusto" rows,
  and a journal aggregate that would have published private ratings at
  count=1. Every one was found pre-merge. The pattern: build lane → 2-3
  lens reviewers (workflow) → one adjudicated fix round → merge.
- **Migration ledger** (top of this file). Two collisions were caught
  in-flight today by pre-assignment; it works — keep it current.
- **The positive-evidence rule governs matching**: registry silence is
  registry debt (a counter), never grounds to detach a live link. Recorded on
  PR #212.
- **Curate-lane work orders**: pickup requires no live `wo-*` window — a
  completed window holds 24h for post-mortem and silently blocks new orders;
  kill it (preserve scrollback) if an order must run sooner.
- **gh env token goes stale** — on 401, `GH_TOKEN=$(cat /creds/gh_token)`.
- **k8tz overwrites CronJob timeZone on CREATE**; the four crawl jobs carry
  the opt-out; any NEW CronJob needs it too.
- A red CI `test` job is usually real, but the `auth.test.ts` 57P01 flake
  survives (#174) — check the shape before retriggering.

## The day in numbers

19 PRs merged across two repos (cj: #190 #194 #195 #197 #200 #201 #203 #204
#205 #208 #211 #212 #214 #215 #218 #220 + releases; ops: #2693 #2694 #2698
#2699 #2703 #2706 #2707 #2708), 6 production deploys, 5 adversarial verify
workflows (12 reviewer lenses, ~50 adjudicated findings, zero shipped), the
catalog's data model rebuilt end to end, and the owner's two directives —
Brand → Line → Blend → Vitola organization, and Rotten-Tomatoes-style review
aggregation — are respectively deployed-and-filling and one PR from merged.
