# Flow: Idempotent Retry

- **Trigger:** a mutation response is lost (timeout, network) or the user
  says "save that" twice; the client or model retries. Applies identically
  to `save_smoke` and `update_smoke` — every mutation carries the envelope.

## Sequence

```mermaid
sequenceDiagram
    participant C as LLM Client
    participant M as MCP Server
    participant A as Application
    participant P as PostgreSQL
    C->>M: save_smoke { clientRequestId: 9f41..., ... }
    M->>A: SaveSmoke
    A->>P: transaction commits (smoke + idempotency key)
    P-->>A: ok
    A--xC: response lost
    C->>M: save_smoke { clientRequestId: 9f41..., ... } (retry)
    M->>A: SaveSmoke
    A->>P: INSERT idempotency key → unique violation
    P-->>A: existing smokeId for (user, 9f41...)
    A-->>M: original result + replayed: true
    M-->>C: smoke { smokeId: sm_01jc8x } (no duplicate)
```

## Invariants

- `(user_id, client_request_id)` is UNIQUE; the key row — including a
  fingerprint of the canonicalized arguments and the committed result —
  lands in the same transaction as the mutation. There is no window where
  the effect exists without its key.
- The model mints `clientRequestId` once per intent and reuses it exactly on
  any retry (tool contract); host-level retries resend identical arguments,
  so the key travels automatically.
- Replay detection is fingerprint-checked: same key + same fingerprint →
  stored result, `replayed: true`. This is what makes
  `update_smoke.progression.append` retry-safe — a replayed append returns
  the original result instead of appending twice.
- A *different* key with near-identical content is a new Smoke by design —
  the same cigar smoked twice in an evening is legitimate. No content-based
  dedup heuristics.

## Failure modes

- Same key, **different** arguments → `idempotency_conflict`
  (non-recoverable): the model must mint a new id for a genuinely new
  intent; corrections go through `update_smoke`, not divergent replays.
- Crash before commit → no key, no effect; the retry simply succeeds.
