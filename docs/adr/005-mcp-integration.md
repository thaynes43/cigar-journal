# ADR-005: MCP integration for ChatGPT Web and other LLM clients

- **Status:** accepted
- **Date:** 2026-08-26

## Context

The primary client is ChatGPT Web in normal Chat mode via a Developer Mode
connector. Platform facts verified against OpenAI docs 2026-08-26: Developer
Mode (Plus and above) supports full read+write MCP; write tools prompt the
user for confirmation unless annotated `readOnlyHint: true`; transport is
Streamable HTTP on a public HTTPS endpoint; auth is OAuth 2.1
authorization-code + PKCE with RFC 9728 protected-resource metadata, RFC 8414
AS metadata, RFC 8707 audience-bound tokens, and DCR/CIMD client
registration; tool definitions should stay under ~5k tokens and calls return
within ~60s; tool-list changes require a manual refresh in ChatGPT;
`search`/`fetch` tools matter only for Deep Research mode. Claude's custom
connectors accept the same standards stack. ChatGPT does not send the chat
transcript to tools — tool arguments contain only what the model synthesizes.

## Decision

- **Plain standards-compliant MCP server** (TypeScript SDK, Streamable HTTP)
  at `/mcp` on the app origin — no Apps SDK, no OpenAI-specific coupling. It
  is a thin adapter over the same application services the web uses;
  authorization, validation, identity, and invariants all live below it.
- **Auth** per ADR-004: OAuth 2.1 + PKCE against the app's own authorization
  server, both ChatGPT callback URLs registered, tokens audience-bound to the
  MCP resource. No anonymous mode at launch (journals are private by
  default); revisit an authless read-only mode if public-journal browsing
  through MCP ever matters.
- **Tool surface: five tools** (contract in
  [`docs/mcp/tool-contract.md`](../mcp/tool-contract.md)): `search_cigars`,
  `get_cigar`, `get_my_smokes` (reads, `readOnlyHint: true` — no confirmation
  friction mid-smoke), `save_smoke`, `update_smoke` (writes — ChatGPT's
  confirmation prompt on `save_smoke` is accepted UX: one prompt per smoke,
  and a deliberate last-look before persisting).
- **Design rules:** the model never invents ids, users, or timestamps it
  doesn't know — unknown fields are omitted/null and the schema allows it;
  errors are structured and recoverable (`cigar_ambiguous` carries
  candidates and `suggestedAction`); `save_smoke` requires a
  `clientRequestId` and replays idempotently; responses stay compact (no
  unbounded lists) for the 60s/size limits.
- **Read-only fallback** (client without write tools): the model produces the
  exact `save_smoke` YAML payload as chat text; the site's import page
  accepts that payload and runs the identical application command. Same
  schema, no second code path. This also serves R12 later.
- **Deep Research `search`/`fetch`:** not implemented at launch; noted as the
  extension point if journal content should be reachable there.

## Consequences

Works unchanged for Claude/Claude Code and other MCP clients; ChatGPT plan
drift degrades to the paste-payload fallback rather than breaking the domain.
Costs: manual connector refresh on tool changes (keep the surface stable);
write-confirmation UX is in OpenAI's hands; token-refresh behavior is
unverified and must be validated with real reconnects in Phase 4 before the
tool contract freezes.

## Alternatives considered

- Apps SDK app + directory publication — review process and UI machinery for
  a personal-first product; a directory listing is a future decision.
- `search`/`fetch`-shaped surface — wrong mode; Chat tool calling doesn't
  need it and it obscures intent-shaped tools.
- Per-observation write tools — contradicts the ephemeral-conversation
  principle and would spam confirmation prompts mid-smoke.
