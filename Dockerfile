# syntax=docker/dockerfile:1

# Multi-stage build for the Cigar Journal image (node:22-alpine, non-root, tini
# for signals). One image serves multiple roles (ADR-001): `web` (default),
# `migrate`, and `import` (one-shot legacy archive import, flow 006) today;
# `mcp`/`crawl` attach later over the same base. The role is chosen by overriding
# the container command in k8s — see the ROLE DISPATCH marker at the runtime
# stage for the exact command arrays.

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

# --- import: prune @cj/importer to its production subtree + bake archive/docs ---
# The one-shot legacy importer (flow 006). `pnpm deploy --prod` copies the
# package source (src/cli.ts + parsers, run via tsx — no build step) plus a flat
# prod node_modules (its workspace deps @cj/domain + @cj/db, drizzle-orm, pg,
# tsx) into /app/importer. --legacy is required for non-injected workspace deps.
# archive/docs is baked alongside the subtree so a one-shot k8s Job needs only
# DATABASE_URL + flags — the CLI resolves `../archive/docs` relative to itself.
FROM build AS import
# hoisted linker: workspace deps (@cj/db, @cj/domain) land as REAL directories
# with their raw-TS sources, and third-party deps sit flat at the top level.
# The default isolated layout symlinks workspace deps back into /app/packages —
# dangling in the runtime stage (first cluster import Job failed on it).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --legacy --filter=@cj/importer --prod --config.node-linker=hoisted /app/importer
RUN mkdir -p /app/importer/archive && cp -r /app/archive/docs /app/importer/archive/docs

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
# import role: the pruned @cj/importer subtree (CLI + parsers + baked archive/docs).
COPY --from=import /app/importer ./importer
# mcp role: the pruned @cj/mcp subtree (server src + its own node_modules).
COPY --from=mcp /app/mcp ./mcp
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
#   crawl:          future role attaches here over the same base.
CMD ["node", "apps/web/server.js"]
