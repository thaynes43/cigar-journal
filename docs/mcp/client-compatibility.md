# LLM Client Compatibility

Per-client capability notes for the Cigar Journal MCP server. **This
document goes stale by design** — client products evolve independently of
this application. Re-verify before relying on any row.

```yaml
lastVerified: 2026-08-26        # Phase 0 spike, OAuth mode, at
                                # https://cigars.haynesnetwork.com — all
                                # three target clients tested live
```

> The Cigar Journal supports journal reads and writes. Whether a particular
> LLM client exposes those operations to its user is a property of that
> client, not a limitation of the Cigar Journal domain.

## Matrix

Values: `verified` (proven against the Phase 0 spike, date noted) ·
`documented` (official docs only) · `unverified` · `unsupported`.

| Capability | ChatGPT Web¹ | Claude Code | Codex CLI | Generic MCP client |
|---|---|---|---|---|
| Remote MCP (Streamable HTTP) | **verified** 08-26 | **verified** 08-26 | **verified** 08-26 | protocol-dependent |
| OAuth 2.1 + PKCE + discovery | **verified** 08-26 (owner authenticated via the connector flow) | **verified** 08-26 (DCR, S256, state, RFC 8707 resource, `offline_access`; accepts pasted redirect URL — headless-drivable) | **verified** 08-26 (native `codex mcp login`; localhost callback — headless-drivable) | protocol-dependent |
| Read tools | **verified** 08-26 | **verified** 08-26 (authless and authenticated) | **verified** 08-26 | yes if connected |
| Write tools | **verified** 08-26 | **verified** 08-26; server-derived identity confirmed | **verified** 08-26; server-derived identity confirmed | yes if connected |
| Write confirmation UX | **none observed** — the write executed with no prompt, despite OpenAI docs saying writes confirm by default. Keep `readOnlyHint` annotations anyway; treat confirmation as host-owned and changeable | **verified**: governed by Claude Code's permission system (interactive prompt / `--allowedTools`), not MCP annotations | **verified**: governed by codex approval/sandbox policy — headless `exec` auto-cancelled the write until `sandbox_mode=danger-full-access` + `approval_policy=never` | client-dependent |
| Tool availability late in a long conversation | unverified — initial test needed no per-turn selection, but a 90-minute smoke hasn't been simulated; observe during first real sessions | **verified**: tools persist for the session | **verified**: tools persist for the session | client-dependent |
| Token refresh / long-lived link | unverified — first test was same-session; observe across days of real use | **verified** 08-26: silent refresh after 10-min token expiry, rotation honored (server `refresh_rotated`) | unverified (session outlived no token in test) | client-dependent |
| Reconnect after expiry | unverified | **verified** 08-26: post-expiry call succeeds, no user interaction | unverified | client-dependent |

¹ Owner's account, Developer Mode, 2026-08-26 (spike). **Production
verified 2026-08-27**: ChatGPT Web connected to the real server end to end
— DCR, PKCE authorize, session-gated consent, token exchange (1h tokens +
refresh grant), live search_cigars/get_my_smokes calls. Two client-cache
traps burned in: connectors cache AS metadata (root-path aliases now
served) and consent buttons must bind the decision (Next drops submit
name/value under formAction). Cross-client persistence verified on the
spike: a ChatGPT write read back by both CLIs.

Environment note: clients running inside the cluster need IPv4-first DNS
(`NODE_OPTIONS=--dns-result-order=ipv4first` for Node-based CLIs) — the
cluster has no IPv6 egress and cigars.haynesnetwork.com publishes AAAA
records. Irrelevant for cloud-side clients like ChatGPT Web.

## Known platform behaviors (ChatGPT Web)

**Call latency is ChatGPT-platform-side, not ours (2026-08-27).** Second
field test: end-to-end tool calls stay ~5–7 s each, *unchanged* after the
server switched to MCP JSON response mode (`MCP_JSON_RESPONSE=true`).
Server-side handling is ~4 ms (per-tool `latencyMs` in the structured logs),
so the ~5–7 s is overhead inside the ChatGPT platform (model round-trip +
connector transport), not the Cigar Journal server. No server-side lever
meaningfully moves it — treat it as a platform property, not a regression to
chase.

**Connector manifest staleness (2026-08-27).** ChatGPT exposes no model-side
refresh of a connector's tool manifest: new tool schemas and descriptions
(e.g. the `matchedIn`/`matchSnippet` fields and the title-is-metadata
instruction line; the eleventh tool `set_want`, the `record_purchase.wanted`
result field, and the `get_cigar` `wanted` overlay added with Want v1; the
ADR-008 `consumption` block + ask-once "From your humidor?" instruction added
with explicit consumption) reach a client **only after the user refreshes the
connector in ChatGPT settings, then starts a new chat** (schema cache is
per-conversation — see below). The often-noted
"`ersonal cigar journal…`" text is neither a truncation bug nor our string:
the owner confirmed it is his own hand-typed connector description in ChatGPT,
entered with the leading "P" dropped. Our `INSTRUCTIONS` string — a separate,
server-owned field — is verified intact (server constant + `mcp.test.ts`
equality assertion), so nothing in what we send is affected. Re-check the
rendered instructions and tool descriptions after a user-initiated connector
refresh.

## ChatGPT manifest caching (verified 2026-08-27/28)

Tool *descriptions* and input *schemas* are cached separately, and schema
cache is **per-conversation**: after the user refreshes the connector in
settings, an existing conversation keeps serving stale input schemas while
a brand-new chat sees the current manifest (verified live: fresh session
reported the rating bounds, position semantics, and title rule; the same
checks were stale in the pre-refresh conversation). Practical rule: after
any tool-schema deploy, refresh the connector once, then start a new chat.
Deleting/re-adding the connector is not required.

## Workflows

**Ideal (design target):** the user talks to ChatGPT normally for the whole
smoke; on "that's it," the model calls `save_smoke`. Phase 0 shows this is
live-reachable today on the owner's account — reads *and* writes worked from
normal Chat with no confirmation friction. Remaining watch item: connector
availability across a very long conversation.

**Fallback (if a client loses write tools):** the model produces the exact
`save_smoke` payload as text; the user pastes it into the site's import page
or hands it to a write-capable client (Claude Code / Codex) to invoke
verbatim. Same schema, same validation (tool contract, fallback section).

**Alternate full clients:** Claude Code and Codex both proved the complete
read + write workflow against the identical server. The product's UX model
remains a normal conversational assistant; MCP schemas stay optimized for
conversational tool use, not coding-agent automation.
