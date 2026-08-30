# Ship chain

How a merged PR becomes running pods, and what to do when a hop does not fire.

GitHub occasionally drops workflow-trigger events in this repo, and each hop
fails differently. The remedies are not interchangeable — the one that works
for release-please actively wastes time on publish-image.

## The hops

| # | Hop | Trigger | Proof it ran |
|---|---|---|---|
| 1 | CI | `pull_request` on the PR (`push:main` is a backstop) | four green jobs: `lint-and-typecheck`, `test`, `build`, `e2e` |
| 2 | release-please | `push` to `main` | a `chore(main): release X.Y.Z` PR opens or updates |
| 3 | tag + release | merging that PR | tag `vX.Y.Z` and a published GitHub release |
| 4 | publish-image | `release: published` | `ghcr.io/thaynes43/cigar-journal:vX.Y.Z` exists and is cosign-signed |
| 5 | haynes-ops bump | a hand-opened PR | Flux Kustomization + HelmRelease reconcile |
| 6 | rollout | Flux | new pod age in `frontend` |

Hops 2 and 3 run on `RELEASE_PLEASE_TOKEN`, not `GITHUB_TOKEN` — a release
created by `GITHUB_TOKEN` does not fire hop 4 at all (ADR-001). That PAT is the
single point of failure for the whole chain; it is watched daily from haynes-ops
(see *Credential expiry* below).

## When a hop does not fire

### 1. CI did not run, or flaked

`migrations.test.ts` fails roughly one full run in three — embedded-Postgres
startup under parallel load, a different file each time, always green on re-run.

Push an empty commit to the PR branch to retrigger. **Maximum three**, then stop
and investigate: past three, a real failure is being papered over.

### 2. release-please did not open a PR after a merge to main

The workflow declares `workflow_dispatch` precisely for this:

```
gh workflow run release-please.yml --ref main
```

An empty commit on `main` also works. Same cap of three.

If it runs but does nothing, check the merged commit messages — release-please
only cuts a release for conventional-commit types it is configured to bump.

### 3. publish-image did not run after a release was published

**An empty commit does not help here.** The trigger is `release: published`; the
`pull_request` trigger is paths-filtered to `Dockerfile`, `.dockerignore`, and
the workflow itself, and is build-only (it never pushes).

Remedies, in order:

1. **Re-emit the release event** — the only remedy that produces the `vX.Y.Z`
   tag:
   ```
   gh release edit vX.Y.Z --draft
   gh release edit vX.Y.Z --draft=false
   ```
2. **`gh workflow run publish-image.yml --ref vX.Y.Z`** — works, but produces
   **only the `sha-<short>` tag, never `vX.Y.Z`**. The raw tag in the
   metadata-action step is gated on `enable: github.event_name == 'release'`, so
   a `workflow_dispatch` run cannot emit it. After this remedy you must either
   pin the HelmRelease to the `sha-` tag or fall back to remedy 1.

Do **not** build an automated retriggerer. These are rare, the remedies differ
per hop, and an automatic re-kick hides a real outage behind a retry loop.

## Confirm the image landed before opening the bump PR

```
gh api /users/thaynes43/packages/container/cigar-journal/versions \
  --jq '[.[].metadata.container.tags[]] | map(select(startswith("v"))) | .[0:5]'
```

Filter for `v`-prefixed tags: the newest package *version* is normally the
cosign signature artifact (a `sha256-….sig` tag), so an unfiltered `.[0]`
answers the wrong question.

Only then open the haynes-ops PR. Bumping to a tag that does not exist leaves
the HelmRelease wedged on `ImagePullBackOff` and needs a second PR to fix.

## The haynes-ops bump

`kubernetes/main/apps/frontend/cigar-journal/app/` — **three** tag occurrences in
**two** files, and missing the second file is the usual mistake:

- `helmrelease.yaml` — the single `image: &mainImage` anchor (the `web` and
  `mcp` roles both reference it via `*mainImage`).
- `crawler-cronjobs.yaml` — **both** CronJob image pins. A CronJob is a separate
  manifest and cannot reach the HelmRelease's anchor.

Then:

```
flux reconcile source git haynes-ops -n flux-system   # the source is haynes-ops, NOT flux-system
flux get kustomization cigar-journal -n frontend      # must go Ready=True
kubectl -n frontend get pods -l app.kubernetes.io/name=cigar-journal
```

`flux get kustomization` is not optional. Flux runs `envsubst` in **strict mode**
over every resource in that path, so a new manifest containing inline shell
without the `kustomize.toolkit.fluxcd.io/substitute: disabled` annotation fails
the entire Kustomization — taking web, mcp, and the crawlers with it. Local
`kustomize build` and `flux-local` both pass such a manifest.

Declare the rollout first: `declare-activity start "cigar-journal rollout"
--scope frontend,cigar-journal`.

## Credential expiry

Two credentials in this chain expire silently, so both are watched daily by
`cigar-journal-credential-expiry` in haynes-ops
(`kubernetes/main/apps/frontend/cigar-journal/app/credential-expiry-cronjob.yaml`):

- **`RELEASE_PLEASE_TOKEN`** — hops 2 and 3 stop opening PRs when it lapses.
  Lead time 14 days.
- **the `dev-env-cli` OAuth access token** — the dev-env pod's MCP client
  (issue #129). Lead time 7 days.

The job exits non-zero inside either lead window; that pages via
`severity=critical`. Its log carries a `credential=… days_left=… status=…` line
per credential on every run, green ones included.
