# Flow: Smoking Session

- **Trigger:** the user starts discussing a cigar with an LLM client
  (ChatGPT Web). Finalization triggers on the user signaling the smoke is
  over.

## Ordinary conversation — no backend traffic

The defining property: tasting talk stays between user and model. The backend
sees nothing until a tool is genuinely useful.

```mermaid
sequenceDiagram
    actor U as User
    participant C as ChatGPT
    U->>C: Spice right up front but nothing intense.
    C->>U: (conversation)
    U->>C: Smoother now. Tangerine actually seems accurate.
    C->>U: (conversation)
    Note over C: Context lives in the chat.<br/>No MCP calls, no writes.
```

## Mid-conversation history retrieval

```mermaid
sequenceDiagram
    actor U as User
    participant C as ChatGPT
    participant M as MCP Server
    participant A as Application
    participant P as PostgreSQL
    U->>C: This seems sweeter than I remember.
    C->>M: get_my_smokes { cigarId, limit: 3 }
    M->>A: query (principal from token)
    A->>P: SELECT smokes WHERE user + cigar
    P-->>A: rows
    A-->>M: summaries
    M-->>C: previous smokes
    C->>U: Last time you called it "mostly cedar and earth" — sweeter today.
    Note over C,M: readOnlyHint: no confirmation prompt.
```

## Finalize

```mermaid
sequenceDiagram
    actor U as User
    participant C as ChatGPT
    participant M as MCP Server
    participant A as Application
    participant D as Domain
    participant P as PostgreSQL
    U->>C: That's it. Really liked that one.
    Note over C: Synthesizes the whole conversation:<br/>progression, construction, assessment, narrative.
    C->>U: Confirm save? (host write prompt)
    U->>C: approve
    C->>M: save_smoke { clientRequestId, cigar, progression, ... }
    M->>A: SaveSmoke command (principal from token)
    A->>D: validate + resolve cigar (create unverified if described)
    D->>P: one transaction: cigar? + smoke + progression + idempotency key + audit
    P-->>D: committed
    D-->>A: canonical Smoke
    A-->>M: smoke { smokeId, url, version: 1 }
    M-->>C: result
    C->>U: Saved. This one developed from pepper into tangerine cream...
```

## Failure modes

- Cigar unresolvable/ambiguous → [flow 002](002-cigar-resolution.md).
- Timeout/retry → [flow 004](004-idempotent-retry.md).
- Write tools unavailable → model emits the `save_smoke` payload as text;
  user pastes it into the site's import page (tool contract, fallback).
