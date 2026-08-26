# syntax=docker/dockerfile:1
# Multi-stage build for the Phase 0 MCP spike. node:22-alpine, non-root, tini
# for signal handling, runs the compiled JS only.

FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS prod-deps
ENV PNPM_HOME=/pnpm CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production PORT=8080 STATE_FILE=/data/spike-state.json AUTH_STATE_FILE=/data/spike-state.json.auth.json
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
