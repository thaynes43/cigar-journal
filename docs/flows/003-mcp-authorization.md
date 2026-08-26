# Flow: MCP Authorization

- **Trigger:** a user adds the connector in ChatGPT (Developer Mode), or a
  token expires.

## Sequence

```mermaid
sequenceDiagram
    actor U as User
    participant C as ChatGPT
    participant M as MCP Server (app origin /mcp)
    participant AS as App Authorization Server
    C->>M: initialize (no token)
    M-->>C: 401 + WWW-Authenticate resource_metadata
    C->>M: GET /.well-known/oauth-protected-resource
    M-->>C: PRM (authorization server = app origin)
    C->>AS: GET /.well-known/oauth-authorization-server
    AS-->>C: AS metadata (endpoints, PKCE, DCR)
    C->>AS: register client (DCR / CIMD)
    C->>U: open authorization page
    U->>AS: sign in (local password or Authentik SSO) + consent to scopes
    AS-->>C: authorization code (redirect to chatgpt.com callback)
    C->>AS: token request (code + PKCE verifier + resource=/mcp)
    AS-->>C: access token (aud = mcp, scopes journal:read/write, catalog:read)
    C->>M: tools/list (Bearer token)
    M-->>C: five tools
```

## Invariants

- The token's subject **is** the principal; every application command derives
  ownership from it. No tool argument can name a user.
- Tokens are audience-bound (RFC 8707) — a web session token is not valid at
  `/mcp` and vice versa.
- Both ChatGPT redirect URIs registered; state + PKCE enforced; consent
  screen shows scopes in plain language.
- Revocation: disconnecting the connector (or the site's "connected apps"
  page) revokes the grant; tokens are short-lived.

## Failure modes

- Expired token → 401 → ChatGPT re-runs the flow (refresh behavior is
  UNVERIFIED platform-side; validate real reconnects in Phase 4).
- Consent denied → connector unlinked, nothing stored.
- Wrong-audience or tampered token → `unauthenticated`, logged with
  correlation id, no detail leaked.
