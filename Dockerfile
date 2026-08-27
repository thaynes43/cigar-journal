# syntax=docker/dockerfile:1

# Multi-stage build for the Cigar Journal image (node:22-alpine, non-root, tini
# for signals). Phase 1 ships the `web` role only. The `migrate`, `mcp`, and
# `crawl` roles (ADR-001, one image / many roles) attach at the RUNTIME stage
# via additional entrypoints over the same base — see the marker there.

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

# --- runtime: minimal image running the standalone server as the web role ---
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# outputFileTracingRoot = repo root, so standalone already bundles the server
# plus the traced node_modules; copy it and the (unbundled) static assets.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# ROLE DISPATCH — migrate/mcp/crawl attach here later (override CMD or add a
# small role entrypoint). web is the default role.
CMD ["node", "apps/web/server.js"]
