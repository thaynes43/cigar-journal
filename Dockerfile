# syntax=docker/dockerfile:1

# Multi-stage build for the Cigar Journal image (node:22-alpine, non-root, tini
# for signals). One image serves multiple roles (ADR-001): `web` (default) and
# `migrate` today; `mcp`/`crawl` attach later over the same base. The role is
# chosen by overriding the container command in k8s — see the ROLE DISPATCH
# marker at the runtime stage for the exact command arrays.

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
#   mcp / crawl:    future roles attach here over the same base.
CMD ["node", "apps/web/server.js"]
