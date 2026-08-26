# LLM Client Compatibility

Per-client capability notes for the Cigar Journal MCP server. **This
document goes stale by design** — client products evolve independently of
this application. Re-verify before relying on any row.

```yaml
lastVerified: 2026-08-26        # spike LIVE at https://cigars.haynesnetwork.com
                                # (OAuth mode); Claude Code rows empirically
                                # verified against it this date
```

> The Cigar Journal supports journal reads and writes. Whether a particular
> LLM client exposes those operations to its user is a property of that
> client, not a limitation of the Cigar Journal domain.

## Matrix

Values: `documented` (official docs reviewed, date above) · `unverified`
(no reliable doc found) · `verified` (proven by the Phase 0 spike — none
yet) · `unsupported`.

| Capability | ChatGPT Web | Claude Code | Codex | Generic MCP client |
|---|---|---|---|---|
| Remote MCP (Streamable HTTP) | documented | **verified** 08-26 | blocked¹ | protocol-dependent |
| OAuth 2.1 + PKCE + discovery | documented | **verified** 08-26 (DCR, S256, state, RFC 8707 resource, `offline_access`; accepts pasted redirect URL — works headless) | blocked¹ | protocol-dependent |
| Read tools | documented | **verified** 08-26 (authless and authenticated) | blocked¹ | yes if connected |
| Write tools | documented (Developer Mode, paid plans) | **verified** 08-26; server-derived identity confirmed on writes | blocked¹ | yes if connected |
| Write confirmation UX | documented (prompt unless readOnlyHint) | **verified**: governed by Claude Code's own permission system (interactive prompt / `--allowedTools`), not MCP annotations | blocked¹ | client-dependent |
| Tool availability late in a long conversation | **unverified** | **verified**: tools persist for the session | blocked¹ | client-dependent |
| Token refresh / long-lived link | **unverified** | **verified** 08-26: silent refresh grant after 10-min token expiry, rotation honored (server `refresh_rotated`) | blocked¹ | client-dependent |
| Reconnect after expiry | unverified | **verified** 08-26: post-expiry call succeeds with no user interaction | blocked¹ | client-dependent |

¹ Codex CLI's own ChatGPT credential expired mid-Phase 0 (refresh loop:
"log out and sign in again") — blocked before MCP was ever exercised;
retest after an interactive `codex login`.

Environment note: clients running inside the cluster need IPv4-first DNS
(`NODE_OPTIONS=--dns-result-order=ipv4first` for Node-based CLIs) — the
cluster has no IPv6 egress and cigars.haynesnetwork.com publishes AAAA
records. Irrelevant for cloud-side clients like ChatGPT Web.

Remaining `unverified`/`documented` cells are Phase 0 deliverables: the
ChatGPT Web column needs the owner's browser; Codex needs re-login.

## Workflows

**Ideal (design target):** the user talks to ChatGPT normally for the whole
smoke; on "that's it," the model calls `save_smoke`. No connector ceremony.
The backend is fully ready for this today.

**Current ChatGPT (until Phase 0 proves otherwise):** the connector may need
to be selected or referenced on the turn where a tool call should happen —
e.g. "@CigarJournal I'm smoking an Alma del Fuego" at the start and
"@CigarJournal that's it for this one" at the end. Mid-smoke conversation is
unchanged. This is client UX, not architecture.

**Fallback (no write tools available):** the model produces the exact
`save_smoke` payload as text; the user pastes it into the site's import page
or hands it to a write-capable client (Claude Code / Codex) to invoke
verbatim. Same schema, same validation (tool contract, fallback section).

**Alternate full clients:** Claude Code or Codex connect to the identical
server and perform the complete read + write workflow. They are interim
vehicles for full capability — the product's UX model remains a normal
conversational assistant, and MCP schemas stay optimized for conversational
tool use, not coding-agent automation.
