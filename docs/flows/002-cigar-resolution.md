# Flow: Cigar Resolution

- **Trigger:** a cigar is named conversationally — usually partially
  ("Alma Fuego", "Atabey") — and the model needs a catalog reference.

## Sequence

1. Model calls `search_cigars` with the user's phrasing; trigram matching
   tolerates partial names and misspellings.
2. `single_match` → proceed with the `cigarId`. Emitted when the top hit is an
   exact (case-insensitive) canonical-name match — trailing fuzzy hits stay
   listed — or a single fuzzy candidate stands alone. No user interruption.
3. `brand_match` → the query named only a known brand, not a product. `matches`
   are that brand's catalogued cigars; the model asks for the line/vitola
   before resolving.
4. `multiple_matches` → several fuzzy candidates and no clean winner; the model
   disambiguates *conversationally* (vitola usually settles it). Never guesses.
5. `no_match` → no interruption mid-smoke; at finalize, `save_smoke` carries
   `described` attributes — `canonicalName` as the user knows it, plus brand,
   line, blend, and vitola only where the user actually stated them — and the
   server creates an `unverified` catalog entry inside the save transaction
   (catalog invariant, ADR-002/006). Stated levels resolve against the brand
   and line registries by alias (ADR-012); unstated levels stay NULL and the
   row stays `freeform` until curation composes it. The curation queue picks
   it up later. No line, blend, or vitola detail is ever invented to fill a
   level. The **documented** path is `add_cigar` first and then the save
   (server instructions; owner ruling on issue #177); the described save is the
   resolver's safety net for a client that skipped that prelude, so the entry
   survives either way. What must never happen is stopping at `add_cigar` — it
   writes no journal entry, and a catalog row without one looks like success
   (#177, a live loss on 2026-08-30). Only a save that actually *creates* the
   entry queues its enrichment; one that links to an existing row filled no gap.

```mermaid
sequenceDiagram
    actor U as User
    participant C as LLM Client
    participant M as MCP Server
    U->>C: I'm smoking an Atabey.
    C->>M: search_cigars { query: "Atabey" }
    M-->>C: brand_match [Atabey Divinos, Atabey Ritos]
    C->>U: Nice — the Divinos or the Ritos?
    U->>C: The Divinos.
    Note over C: Holds cigarId cg_01k2m1 for the session.
```

## Aggregates and invariants

Catalog Cigar only. Server-side strong-match check prevents `described` from
duplicating an existing entry (`cigar_ambiguous` if it can't decide);
verification/merge stay curator-only. The strong-match check also guards
against collapsing number-distinct names: a candidate whose digit/alphanumeric
model tokens conflict with the query's (e.g. "1964 Maduro" vs "1926 Maduro",
"Liga Privada T52" vs "…No. 9") is disqualified from strong-linking even at a
high trigram score, so it creates a new entry rather than mislinking.

## Failure modes

- `cigar_ambiguous` at save time → model asks the user, retries with the
  chosen id and the **same** `clientRequestId`. When the user confirms none of
  the candidates is theirs, the deadlock breaks through `add_cigar` with
  `confirmedDistinct: true` (the flag exists only there) and the save then runs
  against the `cigarId` it returns — the turn still ends with the save.
- Model invents a `cigarId` → `cigar_not_found`, recoverable via search.
