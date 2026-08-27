# ADR-005: MCP integration for LLM clients

- **Status:** accepted (revised 2026-08-26 after review)
- **Date:** 2026-08-26

## Context

The desired long-term client is ChatGPT Web in normal Chat mode; Claude
Code, Codex, Claude Desktop, and future first-party clients must work
against the same server, and the owner will use Claude Code or Codex as the
write-capable client whenever ChatGPT Web cannot be. Client capabilities are
**external product surface that changes independently of this application**
— everything below marked *client capability* was verified against official
OpenAI docs on **2026-08-26** and must be re-verified empirically in Phase 0,
not trusted from documentation or this ADR.

Three layers are kept distinct:

```yaml
domainCapability:      { readJournal: supported, writeJournal: supported }
mcpServerCapability:   { readTools: supported, writeTools: supported }
clientCapability:      # per client, per plan, per date — see
                       # docs/mcp/client-compatibility.md (expected to go stale)
```

The domain and server always expose the full interface; clients consume the
subset they support. No subscription restriction shapes the architecture.

As verified 2026-08-26 (docs): ChatGPT Developer Mode advertises full
read+write MCP on paid plans, requires Streamable HTTP on public HTTPS,
performs OAuth 2.1 authorization-code + PKCE with RFC 9728/8414/8707
discovery and DCR/CIMD registration, refreshes tool lists manually, and
bounds tools at roughly 5k tokens per definition and ~60s per call. ChatGPT
does not transmit the chat transcript to tools.

**Phase 0 ran 2026-08-26 and its empirical results supersede the doc-based
claims** (full matrix: [`client-compatibility.md`](../mcp/client-compatibility.md)):
all three target clients — ChatGPT Web (owner's account), Claude Code, and
Codex — completed remote connection, OAuth, reads, and writes against the
live spike, and a value written by ChatGPT was read back by both CLIs.
Notably, ChatGPT executed the write **without** the documented confirmation
prompt; `readOnlyHint` annotations stay regardless, since confirmation is
host-owned and changeable. Claude Code additionally proved silent refresh
with rotation after token expiry. Still open to observation during real
use: ChatGPT's refresh behavior over multi-day links and connector
availability late in very long conversations.

## Decision

- **Plain standards-compliant MCP server** (official TypeScript SDK,
  Streamable HTTP) at `/mcp` on the app origin — no Apps SDK, no
  vendor-specific behavior. A thin adapter over the same application
  services the web uses; authorization, validation, identity, and
  invariants all live below it.
- **Protocol version:** whatever the official SDK negotiates (2025-11-25
  revision at time of writing). No hand-rolled lifecycle assumptions;
  sequence diagrams describe architecture, and the SDK owns
  initialize/negotiation. Protocol upgrades arrive as SDK upgrades plus a
  Phase-0-style re-verification against live clients.
- **Auth** per ADR-004: OAuth 2.1 + PKCE against the app's own authorization
  server with metadata discovery, DCR and CIMD registration, audience-bound
  tokens, and refresh-token rotation with `offline_access` so long-lived
  client links don't force reauthentication. No anonymous mode at launch.
- **Tool surface: six tools** (contract in
  [`docs/mcp/tool-contract.md`](../mcp/tool-contract.md)): reads
  `search_cigars`, `get_cigar`, `get_my_smokes`, `get_smoke` (all
  `readOnlyHint: true`); writes `save_smoke`, `update_smoke`. Responses are
  scope-bounded: catalog tools carry personal fields only when the token
  also has `journal:read`. Server-level instructions teach any client the
  intended conversational usage; the server still validates everything.
- **Retry safety is universal:** every mutation carries the envelope
  (`clientRequestId`, fingerprint-checked replay, `idempotency_conflict` on
  conflicting reuse; optional `expectedVersion` on updates).
- **Phase 0 compatibility spike is mandatory** before integration
  investment: a throwaway authenticated MCP server with one harmless read
  and one harmless write tool, exercised from ChatGPT Web, Claude Code, and
  Codex, producing the compatibility matrix (connection, auth, discovery,
  read, write, confirmation UX, reconnect, token refresh, late-conversation
  tool availability). The matrix freezes this ADR's client assumptions.
- **Client UX constraint, not architecture:** if ChatGPT requires the
  connector to be referenced on the turn where a tool call is needed
  ("@CigarJournal that's it"), that is documented workflow guidance in
  `client-compatibility.md`. The backend stays ready for the ideal
  always-available workflow.
- **Read-only fallback:** the model emits the exact `save_smoke` payload as
  text; it enters through the site's import page or any write-capable MCP
  client. One schema, same validation, no handoff infrastructure.
- **Deep Research `search`/`fetch`:** not implemented; noted extension point.

## Consequences

One server serves every client; ChatGPT plan drift degrades UX (fallback or
alternate client), never the domain. Costs: we run the Phase 0 spike before
committing integration work; the compatibility doc requires periodic
re-verification; write-confirmation UX belongs to hosts; the contract
freezes only after real-client evidence.

## Alternatives considered

- Apps SDK app + directory publication — review process and UI machinery a
  personal-first product doesn't need; revisit if it's ever distributed.
- `search`/`fetch`-shaped surface — Deep Research's mode, not Chat tool
  calling; obscures intent-shaped tools.
- Per-observation write tools — contradicts ephemeral-conversation and
  would spam confirmation prompts mid-smoke.
- Designing around one vendor's current write availability — the exact
  coupling this ADR exists to prevent.
