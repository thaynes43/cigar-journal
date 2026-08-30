# Related Services

Architecture survey of the owner's existing SaaS apps (2026-08-26). The cigar
journal should follow these patterns unless an ADR says otherwise.

## The house standard (common to all three)

- **Stack:** pnpm monorepo, Next.js (App Router, standalone output), React,
  TypeScript strict, Tailwind or token-only CSS. Internal packages export raw
  TS, no per-package builds.
- **Auth:** Better Auth with the Drizzle adapter and `genericOAuth` for OIDC.
  DB-backed sessions and rate limits (replica-safe, no in-memory state).
  Bootstrap admin via `BOOTSTRAP_ADMIN_EMAILS` on a session-create hook.
  Fail closed when OIDC env vars are unset.
- **Data:** Postgres 16 only — no SQLite/MySQL substitutes, even in tests.
  Drizzle ORM, one schema file per table, numbered raw-SQL migrations run at
  startup behind `pg_advisory_lock` (init container in k8s).
- **API:** tRPC as the primary surface; thin route handlers for auth
  catch-all, health, webhooks. Domain package is the single writer — audit row
  in the same transaction as every mutation; write clients import-confined.
- **Delivery:** multi-stage Dockerfile (node:22-alpine, non-root), image to
  ghcr.io, release-please from conventional commits, keyless cosign signing,
  Kyverno signature enforcement in-cluster.
- **Docs:** PRD → ADR → DDD flow → design → plan → code. 3-digit stable IDs,
  ADRs MADR-style and immutable once accepted.

## Per-app deltas

| | haynesnetwork | todos-for-dues | sigoalumni-org |
|---|---|---|---|
| Role | SSO front door + media self-service | Chapter TODO/dues SaaS | Alumni site + members portal |
| Auth | Authentik OIDC only | sigoalumni OIDC + invite-gated email/password | Google OAuth + magic links; becoming the suite OIDC *provider* (its ADR 0007) |
| DB | CNPG `postgres16-rw` in-cluster | CNPG in-cluster | Cloud SQL |
| Hosting | homelab k8s (haynes-ops `apps/frontend/`) | homelab k8s | GCP Cloud Run + Terraform, keyless (WIF) |
| API | tRPC (~35 routers) | tRPC + SSE (ID-only payloads) | Server actions |
| Testing | Vitest w/ embedded Postgres + Playwright | Vitest w/ Testcontainers + Playwright | none (their known gap) |

## Directly relevant to cigar-journal

- **Local users:** todos-for-dues already combines OIDC SSO with invite-gated
  email/password in Better Auth — precedent for "OIDC plus local users in the
  site's database".
- **MCP server: no precedent.** None of the three has one; the cigar journal
  sets this pattern. Follow the confined-package + separate-image-role shape.
- **Deploy recipe to lift wholesale (todos-for-dues):** bjw-s app-template
  HelmRelease in haynes-ops, `postgres-init` + migrate init containers,
  ExternalSecret (1Password), Traefik IngressRoute via Cloudflare Tunnel,
  version pinned to the release tag.

## Traps the siblings already hit (inherit the fix, not the bug)

- `GITHUB_TOKEN` cannot trigger downstream workflows — release-please needs an
  App token or fine-grained PAT from day one.
- Better Auth `generateId: false` so Postgres owns UUIDs (sigo hit a live 500).
- Renovate is centralized in haynes-ops and does not cover app-repo devDeps —
  register the new repo deliberately.
- Design multi-tenant/role scoping into DB triggers up front (todos'
  min-admin trigger wasn't scoped and complicated e2e).
- Docs drift: keep the agent guide's claims small enough to stay true.
- GitHub occasionally drops workflow-trigger events; the remedy differs per
  hop — see [`ship-chain.md`](ship-chain.md).
