# ADR-001: Modular monolith on the house stack

- **Status:** accepted
- **Date:** 2026-08-26

## Context

The owner runs three production SaaS apps (haynesnetwork, todos-for-dues,
sigoalumni-org) on a converged stack, surveyed in
[`.agents/reference/related-services.md`](../../.agents/reference/related-services.md).
This app adds one genuinely new component — an MCP server — and otherwise has
no requirement the siblings haven't already solved.

## Decision

Modular monolith, inherited stack: pnpm monorepo; Next.js (App Router,
standalone) + React + TypeScript strict; tRPC for the web API; Better Auth;
Drizzle; Postgres 16. One container image with multiple roles — `web`,
`mcp` (long-running Node service, `@modelcontextprotocol` SDK), `migrate`
(init container), `crawl` (CronJob entrypoint) — following haynesnetwork's
multi-role image. Internal packages (`domain`, `db`, `auth`, `mcp`,
`catalog`, `market`) export raw TS. Bounded contexts are packages, not
services. Web and MCP are two inbound adapters over the same application
services; all business rules live below the adapters.

Delivery: release-please, ghcr.io, keyless cosign, Kyverno verification;
deployed via bjw-s app-template HelmRelease in haynes-ops
(`kubernetes/main/apps/frontend/`), Traefik IngressRoute through the
Cloudflare tunnel on a haynesnetwork.com subdomain. The MCP endpoint is
path-routed on the same origin (`/mcp`) to keep one OAuth issuer/resource
identity.

Testing (house standard): Vitest with real Postgres (Testcontainers), authz
tests for cross-user and both visibility states, and Playwright e2e for the
web app. MCP contract tests cover discovery, schemas, scope-bounded reads,
mutation authorization, idempotent replay, `idempotency_conflict`,
`version_conflict`, ambiguous cigars, sparse payloads, full-smoke retrieval,
and LLM-shaped malformed input (`rating: "really good"`,
`approximatePosition: 4`, injected `userId`, invented `cigarId`, empty
progression — the last must pass). One end-to-end acceptance test plays a
whole conversation and asserts a single Smoke with no invented fields and a
duplicate-free replay. `GITHUB_TOKEN` downstream-trigger trap avoided via
App token from day one.

## Consequences

New capabilities land as packages without deployment topology changes; agents
already know these patterns. One image means MCP and web share release
cadence — acceptable at this scale. The Next.js/tRPC choice makes a future
first-party chat UI (non-goal now) cheap to add.

## Alternatives considered

- Separate MCP microservice — deployment machinery without a scaling or
  isolation requirement.
- Python backend (FastMCP) — splits the codebase across ecosystems; MCP
  TypeScript SDK is first-party.
- Next route handler hosting MCP — couples MCP session lifecycle to the web
  server; a separate role on the same image is as cheap and cleaner.
