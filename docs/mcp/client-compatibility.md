# LLM Client Compatibility

Per-client capability notes for the Cigar Journal MCP server. **This
document goes stale by design** — client products evolve independently of
this application. Re-verify before relying on any row.

```yaml
lastVerified: 2026-08-26        # documentation review only; empirical
                                # verification = Phase 0 spike, not yet run
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
| Remote MCP (Streamable HTTP) | documented | documented | unverified | protocol-dependent |
| OAuth 2.1 + PKCE + discovery | documented | documented | unverified | protocol-dependent |
| Read tools | documented | documented | unverified | yes if connected |
| Write tools | documented (Developer Mode, paid plans) | documented | unverified | yes if connected |
| Write confirmation UX | documented (prompt unless readOnlyHint) | documented (permission prompt) | unverified | client-dependent |
| Tool availability late in a long conversation | **unverified** | n/a (tools persist in session) | n/a | client-dependent |
| Token refresh / long-lived link | **unverified** | unverified | unverified | client-dependent |
| Reconnect after expiry | unverified | unverified | unverified | client-dependent |

Every `unverified` and `documented` cell is a Phase 0 spike deliverable;
the spike upgrades cells to `verified`/`unsupported` with dates and notes.

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
