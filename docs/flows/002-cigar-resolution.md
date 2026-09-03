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

The same disqualification applies to **word** identity tokens, and nothing about
the number rule was ever specific to digits. Each name is read as identity plus
vocabulary: strike the tokens the two names share, then the sizes, containers and
wrappers each judged by their own rule, and what remains is that name's identity
residue. Two non-empty residues are two different products — "Tatuaje Monster
Series The Face" is not "…The Bride", however many characters they share — and
the pair may not strong-link (production, 2026-08-30: `add_cigar` for The Face
returned `created: false` against The Bride).

**A described name links only to a row making the same identity claims**
(2026-09-01). Any residue at all — on the name, on the row, or both — and any
*stated* wrapper disagreement raises `cigar_ambiguous`; a number disagreement
still creates. A one-sided residue used to link, on the reasoning
that the shorter name said strictly less, until production showed the cost: the
catalog held "Atabey Ritos", `add_cigar` for "Atabey Black Ritos" — a different
blend — left the residue `{black}` on the query side alone and silently linked,
and a link carries smoke history, ratings, inventory, prices and enrichment onto
the wrong product. That allowance was written when the only alternative was
minting a near-twin row; the ask branch now exists, so the question costs a round
trip and the silent link costs data. Vocabulary is still not identity — sizes,
containers and wrappers are struck before either residue is built — so a name
adding only a size word, or a wrapper the row does not state, still links.

Residues are compared on SPELLINGS, not on strings. One word written two ways —
`Ecuador`/`Ecuadorian`, `San Andres`/`Mexican`, `Shade Grown`/`Shadegrown`,
`Anniversary`/`Aniversario`, `Edicion`/`Edition` — is one word, folded onto a
single key by the equivalence table the vocabulary sets carry (ADR-012
§Decision). Equivalence is a table and never a distance: over this catalog's own
tokens, edit distance 1 pairs `Face` with `Farce`.

A near-match rejected by the identity or wrapper rule ALONE is neither linked nor
created: it raises `cigar_ambiguous` with the siblings as candidates, because the
residue is too weak a signal to decide silently in either direction and the user
is the one who knows. A number rejection still creates — that name states a
structured difference, so there is nothing to adjudicate.

**Packaging comes off the name before any of it is read as a name** (#164,
amending ADR-012). Packaging is never identity: a container or count word
describes an offer, so `Undercrown Shade 5 Pack` is the base cigar bought five at
a time, `Punch Bolos Tin` is `Punch Bolos`, and both sides of every comparison
are stripped before the candidate search and the strong-match filter. The strip
is UNCONDITIONAL, unlike the vitola strike below — a size word can be identity, a
packaging word never is — so there is no packaging rejection left to create on,
and a created row's `canonical_name` is the stripped name: a journal never mints
`… 5 Pack`. It compares folded WORDS, so an identity word that merely contains a
container word survives (`CAO Brazilia Amazon` keeps its `Amazon`). A name that
is only packaging (`5 Pack`, `Tin`) is a `validation_error` on `canonicalName` —
there is nothing left to name.

**Assortments are refused, not stripped.** A sampler, a `Mix & Match`, a bundle
or trio deal, or two marcas joined by `&`/`and` is a retailer's selection: it
names several cigars and therefore none, and the registry's own alias probe is
what decides the two-marca case rather than any hand-written brand list. Where a
pack can be stripped down to the cigar inside it, an assortment cannot — `Mix &
Match Cuban Cigar Bundle` reduces to `Mix & Match Cuban`, which is the shape of
row the flat matcher used to mint — so `save_smoke` and `add_cigar` answer
`validation_error` on `canonicalName` and ask which cigar was actually smoked.
The word is not enough on its own: `Dominican Bundles` is a brand line of bundle
cigars, so `bundle` qualifies only inside a promotion phrase.

**An acquisition may be an assortment.** `record_purchase`,
`record_purchase_batch` and the ledger importer resolve one, because you do buy a
sampler as a unit and the owner keeps such rows as inventory records with lots
against them. An assortment name is not stripped either — there is no cigar
underneath it to strip down to — and an assortment row is reachable only by an
assortment name, so a cigar can never link onto the shelf it came in.

Candidate lists put the identity VERDICT first: a name that contradicts the query
— a residue on both sides — sorts below every name that merely says more or less,
whatever its trigram score, so among fourteen siblings of one family the one the
user named is offered first instead of buried. Below that verdict the residue is
a coarse signal and is treated as one, with trigram deciding between candidates
whose identity claims are comparable. `search_cigars` and `resolveCigar` draw the
same fifty-row candidate pool: ranking cannot recover a row the pool never held,
and a family is bigger than a page.

**Specialization** (ADR-017). A row with `vitola_name NULL` is a FAMILY ROW — the
vitola was never recorded, not a claim that there is none.

**A stated vitola is struck from the name to form the FAMILY CLAIM.** The rest of
the name is what says which family this is, and without the claim a numbered
vitola can never reach its family: `Padron 1926 Natural No. 2` carries a model
token `Padron 1926 Natural` lacks, so the number rule disqualifies the family and
the resolver mints a row sharing nothing with it.

**The full name is asked first; the claim answers only when it found nothing.**
The strike exists to REACH a family the name cannot, never to re-decide what the
name already decided — most vitolas are not in the size vocabulary, so the claim
reads their word as an identity residue on the ROW (`Trinidad Trinidad Reyes`
minus `Reyes` no longer accounts for the `Reyes` its own catalog row says). It
falls back only from ZERO strong candidates, so a genuine ambiguity stays a
question rather than being resolved by the broader key. The claim likewise only
widens the candidate pool — both keys probe it, scored on whichever fits better —
so a name that already matched a row outright still links instead of minting a
duplicate. What the claim LEAVES is judged by the ordinary rules: `Padrón 1926
Serie No. 2 Natural` minus `No. 2` still says `Serie`, which the family never
said, so that one-sided residue raises `cigar_ambiguous` exactly as any other
would. Nothing is renamed by the strike; it is a comparison key.

When the described cigar states `vitola.name` and the single strong candidate is
such a row, the resolver does not link: it gets-or-creates the SIBLING leaf under
the family's own `brand_id`/`line_id`/`blend_id` and free-text brand/line,
carrying the stated vitola and its dimensions, named as the user named it when
that name already carries the vitola and `<family name> <vitola>` otherwise —
from the FULL described name, never from the claim. Get-or-create: an existing
sibling links rather than a second one being minted, matched on the family's
parts within its own marca or on the folded name — and for a family with no
`brand_id`, on the folded name ALONE, because a null brand is not a wildcard and
`Bar Robusto` is no sibling of `Foo` (the rule `split_cigar` states, ADR-012).
The result adds `specializedFrom: { cigarId, canonicalName }` — the family row it
was minted under — and `created` says whether the sibling was new. The rule keys on the
FIELD, not on a word in the name: a size word in `canonicalName` alone stays
vocabulary and still links, a candidate whose RECORDED vitola differs from the
stated one is a different product and creates as before, and a described cigar
that states no vitola links to the family row as it always did. The family row is
never retyped, so the smokes and lots already on it keep the attribution they
were given; each moves with `update_smoke` or `update_purchase`, one at a time.

## Failure modes

- `cigar_ambiguous` at save time → model asks the user, retries with the
  chosen id and the **same** `clientRequestId`. Re-issuing the same call is safe
  under the same id: the ambiguity is raised inside the transaction, so nothing
  was written and the key was never recorded. When the user confirms none of
  the candidates is theirs, the deadlock breaks with `confirmedDistinct: true`:
  on `add_cigar`, whose `cigarId` the save then runs against — the turn still
  ends with the save — or, when the ambiguity arose on `record_purchase`, on
  that call itself, which resolves and lands the purchase in one go. The flag
  lives on those two tools only; `save_smoke` never sets it.
  **The `add_cigar` detour SPENDS that `clientRequestId`.** Keys are unique per
  user and id, not per tool, so the save that follows the detour must carry a
  FRESH one — reusing the spent id is a different payload under a recorded key,
  which is `idempotency_conflict` and is not recoverable. One id per mutation,
  not one per turn: a retry of the same call keeps its id, a second tool call
  takes its own.
- Model invents a `cigarId` → `cigar_not_found`, recoverable via search.
