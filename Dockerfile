# syntax=docker/dockerfile:1

# Multi-stage build for the Cigar Journal image (node:22-alpine, non-root, tini
# for signals). One image serves multiple roles (ADR-001): `web` (default),
# `migrate`, `import`/`ledger` (one-shot legacy archive import, flow 006), `mcp`
# (ADR-005), `crawl` (ADR-006), and `token` (operator service tokens, ADR-011).
# The role is chosen by overriding the container command in k8s — see the ROLE
# DISPATCH marker at the runtime stage for the exact command arrays.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm CI=1
RUN corepack enable
WORKDIR /app

# --- deps: install the full workspace against the lockfile (build-script gated) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json ./packages/config/
COPY packages/domain/package.json ./packages/domain/
COPY packages/db/package.json ./packages/db/
COPY packages/auth/package.json ./packages/auth/
COPY packages/oauth/package.json ./packages/oauth/
COPY packages/importer/package.json ./packages/importer/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/photos/package.json ./packages/photos/
COPY packages/crawler/package.json ./packages/crawler/
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# --- build: compile the web app to a standalone server bundle ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY . .
RUN pnpm --filter @cj/web build

# --- migrate: prune @cj/db to the production subtree the migrate role runs ---
# `pnpm deploy --prod` copies the package source (src/scripts/migrate.ts) plus a
# flat prod node_modules (pg + tsx) into /app/migrate. --legacy is required
# since pnpm 10 for non-injected workspaces. The migrations/*.sql ship in this
# subtree because the advisory-locked runner reads them from ../../migrations/
# relative to itself (ADR-003) — they MUST be in the image, not baked into the DB.
FROM build AS migrate
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --legacy --filter=@cj/db --prod /app/migrate

# --- import: prune @cj/importer to its production subtree + bake archive/ ---
# The one-shot legacy importer (flow 006). `pnpm deploy --prod` copies the
# package source (src/cli.ts + parsers, run via tsx — no build step) plus a flat
# prod node_modules (its workspace deps @cj/domain + @cj/db, drizzle-orm, pg,
# tsx) into /app/importer. --legacy is required for non-injected workspace deps.
# archive/docs (archive import) AND archive/ledger (ledger reconcile) are baked
# alongside the subtree so a one-shot k8s Job needs only DATABASE_URL + flags —
# the CLI resolves `../archive/docs` and `../archive/ledger` relative to itself.
FROM build AS import
# hoisted linker: workspace deps (@cj/db, @cj/domain) land as REAL directories
# with their raw-TS sources, and third-party deps sit flat at the top level.
# The default isolated layout symlinks workspace deps back into /app/packages —
# dangling in the runtime stage (first cluster import Job failed on it).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --legacy --filter=@cj/importer --prod --config.node-linker=hoisted /app/importer
RUN mkdir -p /app/importer/archive \
    && cp -r /app/archive/docs /app/importer/archive/docs \
    && cp -r /app/archive/ledger /app/importer/archive/ledger

# --- mcp: prune @cj/mcp to the production subtree the mcp role runs ---
# The standalone MCP server (ADR-001 separate role, ADR-005). `pnpm deploy --prod`
# copies the package source (src/*.ts, run via tsx — no build step) plus a flat
# prod node_modules (its workspace deps @cj/oauth + @cj/domain + @cj/db, the MCP
# SDK, express, pg, tsx) into /app/mcp. --legacy is required for non-injected
# workspace deps; --config.node-linker=hoisted materializes the raw-TS workspace
# sources (db/domain/oauth src + db/migrations) as real dirs instead of the
# BuildKit symlink stubs tsx cannot resolve — the same class of fix the import
# role's explicit source-shipping addressed, done here by the linker.
FROM build AS mcp
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --legacy --filter=@cj/mcp --prod --config.node-linker=hoisted /app/mcp

# --- crawl: prune @cj/crawler to the production subtree the crawl role runs ---
# The vendor crawler (ADR-006 separate role). `pnpm deploy --prod` copies the
# package source (src/*.ts — adapters + core, run via tsx, no build step) plus a
# flat prod node_modules (its workspace deps @cj/domain + @cj/db + @cj/photos, the
# photos pipeline's sharp/heic-convert, the S3 client, drizzle-orm, pg, tsx) into
# /app/crawler. --legacy is required for non-injected workspace deps;
# --config.node-linker=hoisted materializes the raw-TS workspace sources
# (db/domain/photos src + db/migrations) as real dirs instead of the BuildKit
# symlink stubs tsx cannot resolve — the same linker fix the mcp role uses.
FROM build AS crawl
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --legacy --filter=@cj/crawler --prod --config.node-linker=hoisted /app/crawler

# --- token: prune @cj/oauth to the production subtree the token role runs ------
# The operator service-token CLI (ADR-011, mint | list | revoke). @cj/oauth is a
# library package that also carries a privileged, DB-only, one-shot entrypoint —
# the same animal as @cj/db's migrate role, and the reason the minting logic sits
# beside the authorization-server invariants it depends on (hashToken,
# mcpResource, SUPPORTED_SCOPES, the oauthAccessToken schema) rather than in a
# package of its own. Same prune shape as the roles above; --legacy for the
# non-injected workspace deps and --config.node-linker=hoisted so the raw-TS
# @cj/db + @cj/domain sources land as real dirs tsx can resolve.
FROM build AS token
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --legacy --filter=@cj/oauth --prod --config.node-linker=hoisted /app/token

# --- runtime: minimal image; the role is selected by the container command ---
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# web role: outputFileTracingRoot = repo root, so standalone already bundles the
# server plus the traced node_modules; copy it and the (unbundled) static assets.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# migrate role: the pruned @cj/db subtree (runner + SQL + its own node_modules).
COPY --from=migrate /app/migrate ./migrate
# import role: the pruned @cj/importer subtree (CLI + parsers + baked archive/{docs,ledger}).
COPY --from=import /app/importer ./importer
# mcp role: the pruned @cj/mcp subtree (server src + its own node_modules).
COPY --from=mcp /app/mcp ./mcp
# crawl role: the pruned @cj/crawler subtree (adapters + core + its own node_modules).
COPY --from=crawl /app/crawler ./crawler
# token role: the pruned @cj/oauth subtree (service-token CLI + its own node_modules).
COPY --from=token /app/token ./token
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# ROLE DISPATCH (ADR-001, one image / many roles). ENTRYPOINT is tini; the k8s
# container command picks the role. Roles read DATABASE_URL from the env.
#   web (default):  no override — runs the CMD below.
#   migrate (init container):
#     workingDir: /app/migrate            # REQUIRED: `--import tsx` resolves the
#     command: ["/sbin/tini","--","node","--import","tsx","src/scripts/migrate.ts"]
#                                          # tsx loader relative to the CWD, and
#                                          # tsx lives in /app/migrate/node_modules.
#     Applies /app/migrate/migrations/*.sql under a cluster-wide advisory lock,
#     then exits 0 (idempotent; re-runs are safe). Fails non-zero with a clear
#     message if DATABASE_URL is unset or the database is unreachable.
#   import (one-shot Job, flow 006 — run AFTER the migrate role):
#     workingDir: /app/importer            # REQUIRED: `--import tsx` resolves the
#     command: ["/sbin/tini","--","node","--import","tsx","src/cli.ts",
#               "--user-email","<owner-email>","--dry-run"]
#                                          # tsx loader relative to CWD; tsx lives
#                                          # in /app/importer/node_modules. Drop
#                                          # "--dry-run" to apply. Archive is baked
#                                          # at /app/importer/archive/docs (default).
#     Reads DATABASE_URL from env; resolves the owner by email and refuses (exit 1)
#     if unknown. Idempotent: a re-run replays through the mutation envelope and
#     duplicates nothing. Emits a terse imported/skipped/needs-review report.
#   ledger (one-shot Job, flow 006 — run AFTER the archive import above):
#     workingDir: /app/importer            # REQUIRED: `--import tsx` resolves the
#     command: ["/sbin/tini","--","node","--import","tsx","src/cli.ts","ledger",
#               "--user-email","<owner-email>"]
#                                          # tsx loader relative to CWD; tsx lives
#                                          # in /app/importer/node_modules. Add
#                                          # "--apply" to write (default is
#                                          # dry-run). CSV is baked at
#                                          # /app/importer/archive/ledger and the
#                                          # archive table at .../archive/docs.
#     Reconciles the ledger snapshot against the archive-imported purchases:
#     matched rows are skipped, unmatched rows insert once under deterministic
#     `ledger-2026-08-27#<row>` keys. Idempotent: a re-run replays, never
#     duplicating; existing purchases are never updated or deleted. Emits a terse
#     matched/inserted/needs-review report.
#   mcp (long-running Deployment — the MCP server, ADR-005):
#     workingDir: /app/mcp                 # REQUIRED: `--import tsx` resolves the
#     command: ["/sbin/tini","--","node","--import","tsx","src/index.ts"]
#                                          # tsx loader relative to CWD; tsx lives
#                                          # in /app/mcp/node_modules.
#     Serves GET /healthz and the Streamable HTTP MCP transport at /mcp; listens
#     on $PORT (contract default 8081 — SET IT, the image default PORT=3000 is a
#     web-ism). Reads DATABASE_URL (bearer-token validation + journal reads/writes)
#     and BETTER_AUTH_URL (RFC 8707 audience + discovery + smoke URLs) from env;
#     fails fast if either is unset. Long-running — never exits. The web origin
#     serves /oauth/* and /.well-known/*; this service serves ONLY /mcp on the
#     same public origin (path-routed at the ingress).
#   crawl (CronJob or one-shot Job — the vendor crawler, ADR-006):
#     workingDir: /app/crawler             # REQUIRED: `--import tsx` resolves the
#     command: ["/sbin/tini","--","node","--import","tsx","src/cli.ts",
#               "--vendor","fox-cigar","--mode","seed"]
#                                          # tsx loader relative to CWD; tsx lives
#                                          # in /app/crawler/node_modules. Modes:
#                                          # seed | offers | enrich. Add "--dry-run"
#                                          # to report without writing, "--limit N"
#                                          # to bound a partial run.
#     Reads DATABASE_URL (catalog/offers/match writes) and, optionally, PHOTOS_S3_*
#     (product-photo capture — skipped with the photos-disabled note when unset).
#     Resolves/creates the vendor registry row, refuses to crawl a path robots.txt
#     disallows, rate-limits every fetch (≥2.5s), and brackets the run in a
#     crawl_runs row. Exits 0 on success, 1 on a run failure.
#   token (operator service tokens, ADR-011 — `kubectl exec`, NOT a Job):
#     kubectl -n frontend exec -it deploy/cigar-journal-main -c app -- \
#       sh -c 'cd /app/token && node --import tsx src/cli.ts mint \
#         --client-name dev-env-pod --user-email <owner-email> \
#         --scope catalog:read --scope journal:read --scope journal:write \
#         --reason "<why>" --yes'
#     The `cd` is required: `--import tsx` resolves the loader from CWD and tsx
#     lives in /app/token/node_modules. Drop --yes to print the plan (which
#     still reads the database and runs every check the apply runs) and write
#     nothing. Subcommands: mint | list | revoke --id <uuid>.
#     Reads DATABASE_URL and (mint only) BETTER_AUTH_URL — the RFC 8707 audience,
#     so a wrong origin fails fast instead of minting a token /mcp will reject.
#     There is deliberately NO Job or CronJob for this role: `mint --yes` refuses
#     to run unless stdout is an interactive terminal, because a container's
#     stdout is collected into Loki and cannot carry a credential. The refusal
#     happens before the insert, so nothing is orphaned. The mint is also NOT
#     idempotent (`list` finds orphans, `revoke --id` kills them). Exits 0 ok,
#     1 operational failure (unknown user or token id), 2 usage, env, or a
#     refused delivery.
#   brand-images (CronJob or one-shot Job — the Wikidata/Commons brand covers,
#   issue #127; same crawl role, vendor-independent):
#     workingDir: /app/crawler
#     command: ["/sbin/tini","--","node","--import","tsx","src/cli.ts",
#               "--brand-images"]
#                                          # Add "--dry-run" to report without
#                                          # writing, "--limit N" to bound the run,
#                                          # "--brand <name>" for one shelf,
#                                          # "--refresh" to ignore the 30-day
#                                          # negative cache. "--probe" WRITES
#                                          # NOTHING and prints the claim QIDs that
#                                          # seed core/wikidata-taxonomy.ts — run
#                                          # that FIRST, commit the QIDs, then run
#                                          # the job (ADR-006 live-verification).
#     Fills brand-wall shelves that no member cigar photo covers. Writes NO
#     crawl_runs row (Wikidata is not a vendor — ADR-006 amendment 2026-08-29).
#     Requires egress to www.wikidata.org, commons.wikimedia.org and
#     upload.wikimedia.org; without PHOTOS_S3_* it records outcomes and skips
#     bytes, and skips any row that already carries bytes (it could neither
#     replace nor delete them). Exits 1 on an unseeded taxonomy — seed it first —
#     and on a run where every attempted brand errored.
CMD ["node", "apps/web/server.js"]
