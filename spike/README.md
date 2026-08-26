# Cigar Journal — Phase 0 MCP spike

Throwaway remote MCP server to empirically test real LLM clients (ChatGPT Web,
Claude Code, Codex): remote connect, tool discovery, read/write, write-confirm
UX, OAuth, token refresh, reconnect. **Not the product.** See ADR-005.

Streamable HTTP MCP at `POST /mcp`, `GET /healthz`. Two tools:
`get_test_value` (`readOnlyHint`) and `set_test_value` (`{ value }`).

## Env

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `SPIKE_AUTH` | `none` | `none` (authless) or `oauth` (OAuth 2.1 AS+RS) |
| `SPIKE_PASSCODE` | — | shared login passphrase (oauth mode) |
| `PUBLIC_ORIGIN` | `http://localhost:$PORT` | issuer/metadata base, e.g. `https://cigars.haynesnetwork.com` |
| `STATE_FILE` | `./spike-state.json` | persisted test value |
| `SPIKE_TOKEN_TTL_SECONDS` | `600` | access-token TTL (short on purpose) |
| `SPIKE_MCP_JSON_RESPONSE` | `false` | `true` = JSON replies instead of SSE |

`AUTH_STATE_FILE` (default `<STATE_FILE>.auth.json`) persists DCR clients + refresh tokens.

## Run locally

```bash
pnpm i && pnpm dev            # authless on :8080
pnpm build && pnpm selftest   # curl-based authless selftest (9 checks)
SPIKE_AUTH=oauth SPIKE_PASSCODE=secret PUBLIC_ORIGIN=http://localhost:8080 pnpm dev
```

## Point a client at it

- Authless: add connector URL `https://<origin>/mcp`.
- OAuth: same URL; client does DCR + auth-code/PKCE via the `/.well-known/`
  metadata, then logs in with `SPIKE_PASSCODE`. Watch `[auth]`/`[tool]`/`[mcp]` logs.

## Teardown

Delete `spike/` (and this workflow) when Phase 0 concludes.

Image: ghcr.io/thaynes43/cigar-journal-spike (built by spike-image workflow).
