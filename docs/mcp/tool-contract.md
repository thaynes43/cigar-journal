# MCP Tool Contract

Seventeen tools over the application services, client-neutral: any MCP client
(ChatGPT Web, Claude Code, Codex, future first-party) gets the same surface.
Schemas here are conceptual until frozen after the Phase 0 spike; field
semantics and error codes are normative. Governing decisions: ADR-004 (auth),
ADR-005 (integration). Client capability differences live in
[`client-compatibility.md`](client-compatibility.md), never in this contract.

## Principles

1. **The transcript never arrives.** Tool arguments contain only what the
   model synthesizes; design fields so a faithful synthesis is expressible.
2. **Unknown is valid.** Every field the user didn't state is omitted or
   null. A schema that forces the model to invent a value is a defect.
   Sparse Smokes are legitimate (see minimum validity below).
3. **No model-supplied identity.** The authenticated token determines the
   user; no tool accepts a user reference. Cigar/smoke ids come only from
   prior tool results, never invented.
4. **Verbatim + normalized.** Descriptors are kebab-case tags for analytics;
   the user's own words always travel alongside and are never rewritten.
5. **Errors are instructions.** Machine-readable code + `recoverable` +
   `action`, so the model can self-correct or ask the user.
6. **Every mutation is retry-safe.** Append-style write tools take a
   `clientRequestId`; replays return the original result, conflicting reuse
   is rejected (mutation envelope below). Target-state writes (`set_want`) are
   idempotent by nature — the desired end state is the argument — so they carry
   no envelope: a repeat is a safe no-op.
7. **Reads are frictionless, writes confirm.** Read tools carry
   `readOnlyHint: true`; a host's confirmation prompt on `save_smoke` is the
   user's last look before persisting.

Scopes: `catalog:read` (search_cigars, get_cigar, browse_catalog, get_offers),
`journal:read` (get_my_smokes, get_smoke, get_my_inventory), `journal:write`
(save_smoke, add_cigar, record_purchase, update_smoke, add_smoke_photo, set_want,
set_favorite, request_cigar_enrichment, update_cigar, record_price — including
lazy catalog create inside save/add, the enrichment queue write, conversational
catalog repair, and chat-submitted price observations). There is no
`catalog:write` scope: catalog mutation rides `journal:write` by house precedent
(the same scope already gates add_cigar's lazy create and the enrichment write).
`curation:read` (get_curation_queue) and `curation:write` (set_listing_match_status,
set_cigar_facts, verify_cigar, exclude_cigar, restore_cigar,
set_product_photo_rights, rename_cigar, queue_enrichment_backlog) are a SEPARATE
pair, so a journal:write token can never reach a curation tool. get_cigar is the
one any-of tool: `catalog:read` OR `curation:read`. Curation scope is necessary but
not sufficient — every curation handler also requires an admin principal, so a
curation-scoped token on a non-admin user is rejected exactly as the web console
rejects it.
**Scope-bounded responses:** catalog tools include personal fields
(`userSmokeCount`, `personalProfile`, the `wanted` and `favorited` overlays, and
browse_catalog's tile overlay `smokeCount`/`myRating`/`remaining`/`wanted`/
`favorited`) only when the token also carries `journal:read`; otherwise those
fields are omitted entirely. **browse_catalog's personal *filters*
(`inHumidor`/`wanted`/`smoked`) are journal:read-bounded too** — without that
scope they are dropped rather than applied, so the result set never leaks the
caller's own state; the catalog/market filters and sorts (`q`/`brand`/`type`/
`inStock`/`price`) and the catalog-scoped price-at-a-glance always apply. The
additive `get_cigar` `enrichment` and `pricing` blocks, browse_catalog's tile
`price`, and get_offers' whole payload are catalog-scoped (market/catalog data,
identical for every viewer) and ride `catalog:read`. Data returned never exceeds
the scopes presented.

## Server instructions (sent to every client at initialize)

```text
This server manages the authenticated user's personal cigar journal. The server
identifies the user from the authorization context; never supply or infer a user
id. During an active smoke, converse naturally — do not save as observations
happen. When the user signals the cigar is finished, synthesize the whole
conversation into one save_smoke call. Preserve uncertainty: omit any rating,
vitola, time, pairing, blend detail, or tasting stage never established — sparse
is correct, invented is a defect. Reuse the same clientRequestId when retrying a
mutation.

Resolving vs browsing. search_cigars resolves one named cigar ("I'm smoking an
Alma Fuego") — act on its guidance: single_match (an exact catalog-name hit —
proceed), multiple_matches (candidates but no exact hit — confirm the exact one
before saving), brand_match (only a brand was named — ask for the line/vitola),
no_match (nothing matched — a described save_smoke creates it; if the mention was
partial, ask for the fuller name first to avoid a duplicate). browse_catalog
answers browsing, filtering, and shopping questions ("what do I want that's in
stock", "my top-rated maduros", "cheapest per stick") — it pages the catalog with
composable filters (q, brand, type, inHumidor, wanted, smoked, inStock) and sorts
(name, my-rating, recently-added, price), returning tiles with the personal
overlay and price-at-a-glance. get_cigar is full detail on one cigar; get_offers
is its current vendor offers and price history (kept out of get_cigar to protect
its budget) — reach for it when the user asks about price or where to buy.

Gap-fill. When the user smokes or acquires something search_cigars does not match,
fill the gap first: add_cigar creates an unverified entry from their words and
queues enrichment (specs + a product photo) so the later save_smoke links to a
real cigar; record_purchase logs an acquisition and auto-creates the described
cigar the same way. If add_cigar errors cigar_ambiguous, show the search_cigars
candidates and ask; only when the user confirms none is theirs, retry add_cigar
with confirmedDistinct:true to create the distinct product. record_purchase is
also how the humidor count is corrected —
the ledger is append-only and holdings are derived, so a miscount is fixed with a
negative-quantity row (say why in notes), never an edit. Record only what the user
stated: never invent a price, date, or vendor.

Humidor deduction. A saved smoke deducts one stick from the humidor only when the
user says so. When the resolved cigar shows holdings, ask once at finish, "From
your humidor?"; skip the question when there are no holdings or the user already
said where the stick came from. Pass consumption { fromHumidor: true } when it
came from their humidor (add purchaseId only if they named a specific lot),
{ fromHumidor: false } when it did not (lounge, gift, sample); omit consumption
when unknown — an omitted block deducts nothing, and never invent the provenance.

Want and favorite. set_want flags (or clears) a catalog cigar the user wants;
wanting is independent of owning or smoking, and smoking never clears a want —
clear one only on an explicit request (set_want wanted false). When
record_purchase returns wanted:true the user just acquired something they had
wanted — offer to clear it, never silently. set_favorite flags (or clears) a cigar
the user loves, a mark distinct from want; it is never inferred (never from a
smoke's liked field) — mark one only when the user asks.

Catalog repair. When an existing catalog cigar is sparse (get_cigar carries an
enrichment hint with the missing fields and a pricing summary), repair it as you
go. request_cigar_enrichment queues a background lookup for its specs and a
product photo (status queued | already_queued | recently_enriched | not_needed).
update_cigar fills specific empty fields from what the user knows: it ONLY fills
blanks, never overwriting an existing value or a verified entry, and never touches
the journal. record_price logs a price you found or the user reported — give the
packaging it was priced at (single, 5-pack, box of 20) so per-stick is computed,
and never state a per-stick figure without its packaging; name the vendor when it
is a known shop, otherwise give a source name (and URL). An identical price re-seen
within a day is skipped; a changed price is always kept.

Photos attach through add_smoke_photo, never save_smoke: attach the image to that
tool call itself and the server files it under the smoke; with no image the tool
returns a one-time link to hand the user for a phone upload. A photo never blocks
saving the smoke.

Field conventions:
- rating is an integer 0-100; omit unless the user stated a number, never invent one.
- approximatePosition and any position is a 0-1 fraction through the smoke (0 = light, 1 = nub).
- descriptors are normalized kebab-case tags; specificDescriptors are the user's exact, unusual words kept verbatim.
- smokedAt carries provenance: { source: user, precision: minute } for a stated time, { precision: day } for a date only; omit it entirely when unstated and the server stamps finalize time.
- get_my_smokes text search covers journal title and narrative, impression, construction notes, imported original markdown, and progression verbatim.
- a title alone is not a journal entry — include at least one observation, descriptor, impression, or narrative.
- Combine related corrections into one update_smoke call rather than several.

Catalog curation (admin only). The get_curation_queue read and the eight curation
write tools are for an operations agent maintaining the catalog — not for
conversational journaling; a normal chat session never uses them. get_curation_queue
pages the work by kind (unverified, duplicates, match_triage, unbranded, untyped,
missing_photos); drain a kind with its nextCursor. Apply only what the evidence
supports: high-confidence corrections apply directly (set_cigar_facts overwrites a
wrong brand/line/type/manufacturer; rename_cigar corrects a wrong canonical name;
verify_cigar; set_listing_match_status confirmed/unmatched; exclude_cigar for
non-cigar pollution, restore_cigar to undo; set_product_photo_rights
approved/suppressed); low-confidence cases are skipped and
reported, never guessed — leave an uncertain brand or type null rather than invent
one. queue_enrichment_backlog is the operator's bulk enqueue of the photoless
holdings, NOT part of a curation run: do not call it on your own initiative — report
the worklist and leave the press to the operator. It queues a cigar only once its
canonical name is verified and a crawl-enabled vendor covering that market has
completed an enrich run; every other row comes back with the reason and nothing is
written for it. Enrichment matches on the canonical name, so the way to make a row
enqueueable is rename_cigar then verify_cigar. Pass runId (the batch id) and
confidence (0-1) on every write so the run is auditable and reversible. Merges stay
human-only in the web console — there is no merge tool here.
```

Guidance, not enforcement — the server validates every request regardless.

## Mutation envelope

Both mutations require:

```yaml
clientRequestId: 9f41c9d2-...   # minted once per user intent (one smoke,
                                # one correction); reused EXACTLY on retries
```

Server behavior, decided inside the write transaction:

- **First use:** commit, store `(user, clientRequestId, tool, request
  fingerprint, result)`. Fingerprint = hash of the canonicalized arguments
  (key-sorted, envelope fields excluded).
- **Replay** (same key, same fingerprint): return the stored result with
  `replayed: true`. Covers lost responses, host retries, "save that" twice.
- **Conflicting reuse** (same key, different fingerprint):
  `idempotency_conflict`, not recoverable — mint a new id for a new intent.
- Keys retained ≥90 days; timestamps are never identity.

`update_smoke` additionally accepts an **optional** `expectedVersion`: when
present, mismatch returns `version_conflict` (recoverable via `get_smoke`);
when absent, the change applies to the named fields last-write-wins,
audit-trailed (ADR-002). Provide it when correcting stale or contested data;
omit it for immediate conversational corrections.

## Timestamp semantics

`smokedAt` is provenance-aware — the model never invents time:

```yaml
smokedAt: { value: "2026-08-26T20:15:00-04:00", source: user, precision: minute }
```

- User stated a time/date → `source: user`, value as stated. **`source` is the
  only provenance a client may assert, and its only accepted value is `user`**
  (the write-tool schema pins it): a client cannot stamp `system-finalized`,
  `legacy-document`, or `unknown` — those are server/import-owned. In practice
  clients send `{ value, precision }` and omit `source` entirely.
- User said nothing → **omit the field**; the server records finalization
  time as `source: system-finalized, precision: approximate`. A live save
  therefore always has a useful timestamp without hallucination.
- Imports (server-side path, not this tool) → `source: legacy-document`
  (usually `precision: day`) or `source: unknown` with null value.

## Tool results (text + structured output)

Every tool declares an MCP **`outputSchema`** (ChatGPT's connector settings flags
"Output schema recommended" per tool). Following the SDK's structured-output
contract, each successful result carries the payload **both** as the JSON text
block (unchanged, byte-for-byte — the fallback path still emits this exact JSON as
chat text) **and** as `structuredContent` validated against the schema; the two are
the same object, so they can never diverge. Error results (`isError: true`) carry
only the text payload and are exempt. The schemas are additive metadata and
deliberately **permissive** — rich nested objects (cigar/smoke detail, lots) and
conditional fields (`userSmokeCount`, `personalProfile`, `matchedIn`/`matchSnippet`,
browse_catalog's tile overlay, mode-A photo vs mode-B link) are mirrored loosely
so a valid payload is never rejected as a protocol error. The payload shapes below
are normative; the schemas mirror them.

---

## search_cigars — read

Resolve conversational cigar mentions to catalog entries. Use when a cigar
is named ("I'm smoking an Alma Fuego") or asked about. Not for the user's
history.

```yaml
arguments:
  query: alma fuego            # free text; fuzzy (trigram) matching
  limit: 5                     # default 5, max 10

result:
  matches:
    - cigarId: cg_01j9x2
      canonicalName: Plasencia Alma del Fuego Concepcion
      brand: Plasencia
      line: Alma del Fuego
      vitola: { name: Concepcion, lengthInches: 6.0, ringGauge: 52 }
      type: NC
      verification: verified
      userSmokeCount: 3        # present only with journal:read
  guidance: single_match       # single_match | multiple_matches | brand_match | no_match
```

Guidance is the client's instruction for what to do next:

- `single_match`: proceed with the top match. Emitted **only** when the top hit
  is an exact (case-insensitive) canonical-name match — remaining fuzzy hits are
  still listed but the exact one leads. A lone fuzzy candidate is deliberately
  **not** `single_match`: trigram similarity is dominated by shared brand tokens,
  so a different product under a known brand (e.g. "Arturo Fuente OpusX" against
  a catalogued "Arturo Fuente Hemingway") can score high while naming a different
  stick — auto-proceeding there would silently mislink the smoke.
- `multiple_matches`: one or more fuzzy candidates and no exact winner — confirm
  the exact one with the user before saving (vitola usually disambiguates). A
  single, non-exact candidate lands here too: surface it and confirm rather than
  assume.
- `brand_match`: the query names only a known brand, not a specific product.
  `matches` are that brand's catalogued cigars; ask the user for the line or
  vitola before resolving.
- `no_match`: proceed — `save_smoke` creates the cigar from described
  attributes; do not retry search with invented details.

## get_cigar — read

Full catalog detail for one resolved cigar, including blend metadata where
known (all nullable — see `docs/ddd/domain-model-examples.md`).

```yaml
arguments:
  cigarId: cg_01j9x2

result:
  cigar:
    cigarId: cg_01j9x2
    canonicalName: Plasencia Alma del Fuego Concepcion
    brand: Plasencia
    line: Alma del Fuego
    edition: null
    vitola: { name: Concepcion, lengthInches: 6.0, ringGauge: 52 }
    manufacturer: { name: Plasencia, factory: null }
    productionCountry: Nicaragua
    tobacco:
      wrapper: { country: Nicaragua, region: Ometepe, varietal: null }
      binder: { country: Nicaragua, region: null, varietal: null }
      filler:
        - { country: Nicaragua, region: Jalapa, varietal: null }
    releaseYear: null
    type: NC
    verification: verified
  enrichment:                  # additive (ADR-009); always present, catalog-scoped
    recommended: true          #   a background enrichment would help (photo/dims missing)
    missingFields: [dimensions, tobacco, productPhoto]
    verification: unverified
  pricing:                     # additive (ADR-009); null when no observations exist
    lowest:                    #   the comparison figure, ALWAYS with its packaging
      perStick: true           #   true → `amount` is per-stick; false → package price
      amount: 16.70
      packaging: box
      sticksPerPackage: 20
    currency: USD
    observedAt: "2026-08-28T18:02:00Z"
    sourceCount: 2             #   distinct sources with a current observation
    observationCount: 9        #   total observations recorded for the cigar
    refreshRecommended: false  #   latest observation older than the 30d window
  personalProfile:             # present only with journal:read; null if never smoked
    smokeCount: 3
    recurringDescriptors: [citrus, baking-spice, earth]
    rating: { average: 87, min: 84, max: 91 }
    lastSmokedAt: "2026-07-30"
  wanted: true                 # present only with journal:read; the caller's want mark
  favorited: true              # present only with journal:read; the caller's favorite mark
```

The want and favorite `note`s are web-detail display only and stay off this
payload; the model sets/reads the flags through `set_want` and `set_favorite`.

**Enrichment + pricing hints (ADR-009, additive, catalog-scoped).** `enrichment`
reports whether a background lookup would help (`recommended`), the missing
catalog fields, and the verification state — the model acts on it with
`request_cigar_enrichment` / `update_cigar`. `pricing` is the compact market
summary: `lowest` is the best current per-stick when derivable (else the lowest
package price), **always carrying its packaging** — a bare per-stick figure is
banned (owner ruling). `pricing` is `null` when the cigar has no observations;
`refreshRecommended` trips when the newest observation is older than 30 days.

## browse_catalog — read

Page the catalog with composable filters and sorts (PRD-003 R-MCP-1). The tool
for browsing, filtering, and shopping questions ("what do I want that's in stock,"
"my top-rated maduros," "cheapest per stick"); use `search_cigars` instead to
resolve one named cigar. Reuses the domain `browseCatalog` that backs the web's
unified catalog — one browse path for web and MCP.

```yaml
arguments:                       # all optional; combine freely
  q: alma                        # free-text over name/brand/line (substring, case-insensitive)
  brand: Plasencia               # one brand, matched case-insensitively and exactly
  type: NC                       # NC | CC
  inHumidor: true                # personal (journal:read): remaining > 0 (false = not owned)
  wanted: true                   # personal (journal:read): on the want list (false = not)
  smoked: false                  # personal (journal:read): smoked ≥ once (false = never)
  inStock: true                  # market: has a current in-stock offer (false = none)
  sort: price                    # name (default) | my-rating | recently-added | price
  cursor: null                   # keyset cursor from a prior nextCursor; omit for page 1
  limit: 48                      # default 48, max 96

result:
  cigars:
    - cigarId: cg_01j9x2
      canonicalName: Plasencia Alma del Fuego Concepcion
      brand: Plasencia
      line: Alma del Fuego
      vitola: { name: Concepcion, lengthInches: 6.0, ringGauge: 52 }
      type: NC
      verification: verified
      price:                     # catalog/market-scoped — always present (null if no offer)
        perStick: true           #   true → amount is per-stick; false → package price
        amount: 16.70
        packaging: box           #   a per-stick figure NEVER travels without its packaging
        sticksPerPackage: 20
        currency: USD
        seenAt: "2026-08-20T00:00:00Z"
      smokeCount: 3              # personal overlay — present only with journal:read
      myRating: 88               #   the caller's rounded average, null if unrated
      remaining: 5               #   derived stock (acquired − consumed), floored at zero
      wanted: false
      favorited: true
  nextCursor: "eyJ…"             # opaque keyset cursor; null on the last page
  totalCount: 42                 # total matching the filters, ignoring the cursor
```

**Composable filters.** `q`/`brand`/`type`/`inStock` are catalog/market state;
`inHumidor`/`wanted`/`smoked` are the caller's personal state. Each boolean is
independent and tri-state — omitted applies no filter, `true` requires the
property, `false` requires its absence — and they **AND together in one call**
(unlike the web's single exclusive `own` toolbar). `sort: price` orders by the
best current per-stick offer; unpriced cigars group **after** priced ones (nulls
last), never interleaved as zero.

**Scope-bounding.** The tile `price` (price-at-a-glance) is catalog/market data,
present for every caller. The personal overlay (`smokeCount`, `myRating`,
`remaining`, `wanted`, `favorited`) is present only under `journal:read`; without
it those fields are omitted **and** the personal filters (`inHumidor`/`wanted`/
`smoked`) are dropped rather than applied, so the result set never leaks the
caller's state. `hasProductPhoto` is a web-only tile field and stays off this
payload. A malformed `cursor` decodes as absent (first page); a bad `limit` is
clamped; a bad `type`/`sort` enum is a schema-shape protocol error.

## get_offers — read

Current market offers plus a compact price history for one cigar (PRD-003
R-MCP-2). Kept **out** of `get_cigar` to protect its token budget — reach for it
only when the user asks about price or where to buy. Wraps the domain
`getCigarOffers` (the newest observation per vendor/source × packaging series)
and `getCigarOfferHistory`.

```yaml
arguments:
  cigarId: cg_01j9x2             # from a prior search_cigars/get_cigar/browse_catalog result

result:
  offers:                        # current offer per (source, packaging) series, cheapest per-stick first
    - vendor: Small Batch Cigar
      isRegistryVendor: true     #   false for an ad-hoc/chat source (ADR-006 unapproved-source labels apply)
      price: 334.00              #   the packaging unit's price, null if none observed
      currency: USD
      inStock: true
      listingUrl: https://smallbatchcigar.com/…
      seenAt: "2026-08-20T00:00:00Z"
      packaging: box             #   per-stick ALWAYS travels with its packaging
      sticksPerPackage: 20
      pricePerStick: 16.70       #   dollars, null when not derivable
      priceType: retail          #   retail | msrp | sale
  history:                       # compact — span + per-stick range over the whole series
    firstSeenAt: "2026-06-01T00:00:00Z"
    lastSeenAt: "2026-08-20T00:00:00Z"
    minPricePerStick: 14.20      #   dollars; null when no per-stick figure was ever observed
    maxPricePerStick: 18.90
    observationCount: 9          #   total observations recorded for the cigar
```

Catalog/market-scoped (offers are identical for every viewer), so `get_offers`
takes no personal bounding and needs only `catalog:read`. A cigar with no offers
returns `offers: []` and a zeroed `history` (all null, count 0) rather than an
error — an id from a prior tool result always exists.

## get_my_smokes — read

Query the authenticated user's history; returns compact summaries. Use for
"what did I think last time," "what have I called bready," "what did I smoke
last month." For full detail on one smoke, follow with `get_smoke`.

```yaml
arguments:                     # all optional; combine freely
  cigarId: cg_01j9x2
  brand: Davidoff
  descriptor: bready           # matches normalized descriptors
  text: sweeter than           # FTS over journal title + narrative, impression,
                               # construction notes, imported original markdown,
                               # and progression verbatim
  smokedAfter: "2026-07-01"
  minRating: null
  limit: 10                    # default 10, max 25; newest first

result:
  smokes:
    - smokeId: sm_01jab4
      cigar: { cigarId: cg_01j9x2, canonicalName: Plasencia Alma del Fuego Concepcion }
      smokedAt: { value: "2026-07-30T21:05:00-04:00", source: system-finalized, precision: approximate }
      rating: 88
      liked: true
      descriptors: [tangerine, cream, cedar]
      summary: >
        Brighter than previous smokes; tangerine sweetness in the middle
        third, cream on the finish.
      matchedIn: [narrative, progression]   # present ONLY when `text` was used
      matchSnippet: >                        # short plain-text excerpt (~160 chars)
        ...much sweeter than the last one, tangerine right in the middle...
  totalMatches: 3
```

**Match provenance (text search only).** When the `text` filter is used, each
result carries `matchedIn` — the prose field(s) the search hit, any of
`title`, `narrative`, `impression`, `constructionNotes`, `originalMarkdown`,
`progression` — and `matchSnippet`, a short plain-text excerpt (~160 chars)
around the hit. Together they let the model show *why* a legacy or imported
smoke matched without a follow-up `get_smoke`. Both keys are **omitted
entirely** for non-text queries (descriptor/brand/date/rating filters).

## get_smoke — read

The canonical, complete representation of one Smoke: full progression with
verbatim text, construction, context, assessment, journal prose, provenance,
version. Use for exact comparison with the current conversation, before a
guarded correction (`expectedVersion`), or when the user asks detail a
summary can't answer.

```yaml
arguments:
  smokeId: sm_01jab4

result:
  smoke:
    smokeId: sm_01jab4
    version: 3
    cigar: { cigarId: cg_01j9x2, canonicalName: Plasencia Alma del Fuego Concepcion }
    consumption: { purchaseId: pu_01kd, source: user }   # null when not from the humidor (ADR-008)
    smokedAt: { value: "2026-07-30T21:05:00-04:00", source: system-finalized, precision: approximate }
    context: { location: patio, pairing: [sparkling-water] }
    overallDescriptors: [citrus, cream, cedar]
    progression:
      - stage: opening
        approximatePosition: 0.05
        descriptors: [black-pepper, cedar]
        verbatim: Spice immediately but not really aggressive.
    construction: { draw: excellent, burn: fair, smokeOutput: high, notes: null }
    assessment: { strength: medium-full, body: full, liked: true, rating: 88, impression: "..." }
    journal: { title: "...", narrative: "..." }
    provenance: { source: llm-conversation, client: chatgpt-web }
```

Not for browsing — one Smoke per call, owner-only.

## get_my_inventory — read

The user's current humidor holdings from the purchases ledger: what they own,
how many remain, since when it has been aging, and their own rating. Use when
the user asks what to smoke or what they have. Takes no arguments.

```yaml
arguments: {}                  # none — scoped to the authenticated user

result:
  holdings:
    - cigar:
        cigarId: cg_01j9x2
        canonicalName: Plasencia Alma del Fuego Concepcion
        brand: Plasencia
        line: Alma del Fuego
        vitola: { name: Concepcion, lengthInches: 6.0, ringGauge: 52 }
        type: NC
      remaining: 7             # max(0, totalAcquired − count(consumptions))
      totalAcquired: 10        # sum of lot quantities
      smokedCount: 3           # the caller's smokes of this cigar, all-time
      consumedCount: 3         # explicit humidor-consumption links (ADR-008)
      overConsumed: 0          # count(consumptions) − totalAcquired, when positive
      agingSince: "2025-06-01" # earliest humidor date, else earliest box date
      myRating: 88             # the caller's average rating, null if unrated
      lots:
        - purchasedAt: "2026-01-10"
          quantity: 10
          packaging: box
          vendor: Small Batch Cigar
          pricePerStick: 12.5
          boxDate: null
          humidorAt: "2025-06-01"
  totalSticksRemaining: 7
```

`remaining` is `max(0, totalAcquired − consumedCount)`, where `consumedCount` is
the number of the caller's smokes of this cigar carrying an explicit consumption
link (ADR-008 — this **supersedes** the earlier smokes-since-first-purchase
heuristic). The display floors at zero; `overConsumed` (`consumedCount −
totalAcquired`, when positive) surfaces a discrepancy instead of hiding it — a
missing acquisition row, fixed with a correcting `record_purchase`, never an
edit. `smokedCount` is the all-time smoke count, kept distinct from consumption.
In-stock holdings sort first, then empties, each alphabetical by name.

## save_smoke — write, idempotent

Persist one finished smoke. Call once, when the user indicates the smoke is
over — never per observation, never mid-smoke.

```yaml
arguments:
  clientRequestId: 9f41c9d2-6b7a-4c0e-a1e5-2f8f4f6f7a10
  cigar:                         # exactly one of:
    cigarId: cg_01j9x2           #   resolved id (preferred)
    described:                   #   or the user's naming when no match existed
      canonicalName: Atabey Divinos    # required; the name as the user knows it
      brand: Atabey                    # everything else optional
      line: null
      vitola: { name: Divinos }
      type: CC
  smokedAt: { value: "2026-08-26T20:15:00-04:00", source: user, precision: minute }
                                 # omit entirely if the user never said —
                                 # server stamps system-finalized time
  context:
    location: patio
    pairing: [sparkling-water]
  overallDescriptors: [spice, cream, citrus]
  progression:                   # OPTIONAL — [] / omitted is valid
    - stage: opening             # the user's own framing, free text
      approximatePosition: 0.05  # 0..1, null when unclear
      descriptors: [black-pepper, cedar]
      verbatim: >
        Spice immediately but not really aggressive.
    - stage: middle
      approximatePosition: 0.5
      descriptors: [citrus, cream]
      specificDescriptors: [tangerine]
      verbatim: >
        Much smoother now. Fruit sweetness coming through — tangerine
        might actually be right.
  construction:
    draw: excellent              # excellent | good | fair | poor | null
    burn: fair
    smokeOutput: high
    notes: Needed a few touch-ups in the final third.
  assessment:
    strength: medium-full        # mild..full spectrum, null ok
    body: full
    liked: true                  # ONLY when explicitly stated — never inferred from tone/prose/rating; omit otherwise
    rating: null                 # 0-100 ONLY if the user stated one
    impression: >
      Complex and easy to like; burn issues on this stick only.
  journal:                       # optional; preserve the user's words
    title: Alma del Fuego Concepcion — patio evening
    narrative: |
      Full prose entry in the user's voice...
  consumption:                   # OPTIONAL — omit when unknown (deducts nothing)
    fromHumidor: true            #   true deducts one stick; false = not from humidor
    purchaseId: pu_01kd          #   optional lot attribution when the user named a lot

result:
  smoke:
    smokeId: sm_01jc8x
    version: 1
    url: https://cigars.haynesnetwork.com/smokes/sm_01jc8x
    cigar: { cigarId: cg_01j9x2, verification: verified }
  cigarCreated: false            # true when `described` created an unverified entry
  holdingAfter:                  # PRESENT ONLY when a `consumption` block was supplied
    totalAcquired: 7             #   (additive; mirrors record_purchase's holdingAfter)
    remaining: 6                 #   max(0, totalAcquired − count(consumptions)) (ADR-008)
  replayed: false
```

**Explicit consumption (ADR-008).** `consumption` is the ONLY way a smoke deducts
from the humidor. `fromHumidor: true` links the smoke to the caller's holdings
(with an optional lot `purchaseId`); `fromHumidor: false` records that the stick
came from elsewhere. **Omitting the block is unknown — it deducts nothing, and
the schema never forces the model to invent provenance.** The server instructions
carry the ask-once "From your humidor?" beat; a replayed save (same envelope) does
not double-deduct. **When (and only when) a `consumption` block is present, the
result carries `holdingAfter { totalAcquired, remaining }`** — the derived stock
after the smoke, so the model can confirm the new count without a follow-up read
(additive; mirrors `record_purchase`).

**Minimum validity:** a cigar reference plus at least one substantive field
(non-empty progression, overallDescriptors, journal.narrative, or
assessment.impression). Everything else may be absent — sparse is correct,
invented is a defect. **`journal.title` is metadata, not content — a title
alone does not satisfy this minimum** (a title-only save is rejected as a
`validation_error`; the rule is correct per ADR-002, but the schema
`.describe()` and server instructions now say so up front). If `described`
strongly matches an existing cigar the server links instead of creating
(`cigar_ambiguous` if it can't decide).

## add_cigar — write, idempotent

Create an unverified catalog entry from the user's own naming when search_cigars
matched nothing, and queue background enrichment so the crawler fills the specs
and a product photo. Use before `save_smoke`/`record_purchase` when the cigar is
missing. Resolve-or-create is the exact path `save_smoke` uses for a described
cigar (exact-name link, `cigar_ambiguous` when it can't decide, unverified
create otherwise); this tool adds only the enrichment queue.

```yaml
arguments:
  clientRequestId: 3b9f1c22-...
  cigar:                         # the described-cigar shape from save_smoke
    canonicalName: Quasar Comet 7 Toro   # required; the name as the user knows it
    brand: Quasar                        # everything else optional
    vitola: { name: Toro }
    type: NC
  requestEnrichment: true        # optional, default true

result:
  cigar: { cigarId: cg_01k9, canonicalName: Quasar Comet 7 Toro, verification: unverified }
  created: true                  # false when the name linked to an existing entry
  enrichmentQueued: true         # a request was enqueued (or reused if already pending)
  guidance: created              # created | already_existed
  replayed: false
```

Enrichment is queued at most once per cigar: skipped when a pending or fulfilled
request already exists, or when the entry already has both a product photo and
full vitola dimensions (nothing left to fill). A described name that matches two
catalog rows returns `cigar_ambiguous` with candidates, exactly as `save_smoke`.

## record_purchase — write, idempotent

Append an acquisition to the humidor ledger — or correct the count. Everything
is a purchase row: the ledger is append-only and holdings stay derived, so a
miscount is fixed with a negative-quantity row, never an edit. A described cigar
with no catalog match is auto-created and its enrichment queued (the `add_cigar`
path); a resolved id links directly.

```yaml
arguments:
  clientRequestId: 8c14aa7e-...
  cigar:                         # exactly one of cigarId / described (as save_smoke)
    cigarId: cg_01j9x2
  quantity: 10                   # integer, non-zero; NEGATIVE corrects an over-count
  purchasedAt: "2026-01-10"      # optional; only what the user stated
  packaging: box                 # optional
  boxDate: null                  # optional
  humidorAt: "2025-06-01"        # optional
  pricePerStick: 12.5            # optional — never invented
  vendorName: Small Batch Cigar  # optional; matched to the registry case-insensitively,
                                 # an unknown name is kept in notes ("vendor: X")
  notes: null                    # REQUIRED when quantity is negative (the reason)

result:
  purchaseId: pu_01kd
  cigar: { cigarId: cg_01j9x2, canonicalName: Plasencia Alma del Fuego Concepcion, verification: verified }
  holdingAfter:
    totalAcquired: 10            # sum of the caller's lot quantities for this cigar
    remaining: 7                 # max(0, totalAcquired − count(consumptions)) (ADR-008)
  wanted: true                 # the caller still has an active want mark on this cigar
  replayed: false
```

Only stated facts travel — never invent a price, date, or vendor. A negative
quantity without `notes` is a `validation_error` (the correction must carry its
reason); a zero quantity is rejected. Provenance is server-stamped
`llm-conversation`; the vendor registry is admin data and is never created from a
conversational mention. **`wanted`** reports whether the caller had this cigar on
their want list — acquisition never clears it silently (R-WANT-2), so when it is
`true` the model offers the clear (`set_want`, `wanted: false`).

## update_smoke — write, idempotent

Correct an existing smoke ("actually the Robusto", "change my rating to 9 —
make that 90 on your scale"). Explicit, field-scoped operations — not a
generic patch; unlisted fields cannot be touched (no mass assignment).

```yaml
arguments:
  clientRequestId: 7c02aa10-...
  smokeId: sm_01jc8x
  expectedVersion: 2             # optional; see mutation envelope
  changes:                       # each block optional; only these exist:
    cigar: { resolveTo: cg_01j9x7 }        # re-point to the correct catalog entry
    smokedAt: { value: "2026-08-25T21:00:00-04:00", source: user, precision: minute }
    context: { location: garage }
    assessment: { rating: 90 }
    construction: { draw: good }
    journal: { title: null, narrative: null }   # explicit null clears; omitted keeps
    overallDescriptors: { add: [leather], remove: [] }
    consumption: { fromHumidor: true, purchaseId: pu_01kd }  # set/clear/re-attribute
    progression:
      append:                    # append-only; history is never rewritten
        - stage: final inch
          descriptors: [leather]
          verbatim: Draw tightened up right at the end.

result:
  smoke: { smokeId: sm_01jc8x, version: 3 }
  changedFields: [assessment.rating, cigar, progression, consumption]
  replayed: false
```

Deletion is web-only. Imported Smokes accept structured-field changes; their
original markdown is immutable. The `consumption` op sets, clears
(`fromHumidor: false`), or re-attributes the humidor link (ADR-008); re-pointing
the smoke's `cigar` clears a now-foreign lot automatically. The movement is
audited in the same transaction as the smoke change.

## add_smoke_photo — write, dual-mode

Attach a review-bound photo to one of the user's smokes (ADR-007, issue #44).
The image is **never** a tool argument — it arrives attached to the tool call, or
not at all — and the tool auto-detects which. A photo failure is fully isolated
from `save_smoke`: separate tool, separate result, its own storage transaction.

```yaml
arguments:
  smokeId: sm_01jc8x
  kind: band                     # cigar | band | construction | burn | other (default other)
  caption: "The second band"     # optional; only if the user gave one

# Mode A — image attached to the tool call (host carries it as file data):
result:
  mode: attached
  photo:
    photoId: ph_01ke
    smokeId: sm_01jc8x
    kind: band
    caption: "The second band"
    width: 2048
    height: 1365
    createdAt: "2026-08-28T20:15:00Z"

# Mode B — no image attached: a one-time, short-lived upload link to hand the user
result:
  mode: upload_url
  uploadUrl: https://cigars.haynesnetwork.com/u/<token>
  expiresAt: "2026-08-28T20:30:00Z"
```

**Two modes, one tool.**

- **Attached image (mode A).** ChatGPT Web attaches the user's image to the tool
  call; the server fetches it (15s timeout, 20MB cap), runs the shared pipeline
  (EXIF applied + all metadata/GPS stripped, normalized JPEG + thumb), and files
  it under the smoke. The description steers the model to attach the image to the
  **tool call itself** and never to paste a chat file URL (e.g. `chatgpt.com/...`)
  as text — those links are unreachable outside ChatGPT and will 403.
- **No image (mode B).** The tool mints a short-lived, single-use link bound to
  (user, smoke, kind?, caption?) and returns it. The model hands the URL to the
  user to open on their phone — the reliable path on mobile, where in-chat photo
  attachment is broken upstream. The link opens a one-tile upload page; the token
  is the authorization, consumed atomically on first successful use.

Errors are the standard set: `unavailable` when photo storage is unconfigured,
`smoke_not_found` for a non-owned/unknown smoke, `photo_limit` at the per-smoke
cap, `validation_error` when an attached image can't be decoded. Scope
`journal:write`. The mint/consume link is web-only from there on — its
invalid/expired failure (`upload_token_invalid`) surfaces on the upload page (410
"Link expired."), never through an MCP tool.

### File intake (`openai/fileParams`)

**The tool declares its file input.** Per OpenAI's Apps SDK
([reference](https://developers.openai.com/apps-sdk/reference)) a tool that wants
an attached file MUST declare it, or ChatGPT forwards nothing (the owner-blocking
bug: the receive path worked, but with no declaration ChatGPT never sent the
image). `add_smoke_photo` therefore declares an **optional** top-level `image`
property and lists it in the **tool-level** `_meta["openai/fileParams"]: ["image"]`
published in `tools/list`. The MCP SDK (1.30.x) carries this via a `_meta`
pass-through on `registerTool` — no response hooking needed. The `image` property
is deliberately **permissive** (every sub-field optional, unknown keys pass
through, kept out of `required`): a partial or odd file object reaches the handler
and falls back to mode B rather than failing input validation.

**Two deliveries, one fetch path.** Mode A accepts the file handle from either:

1. the declared **`image` argument** — `{ download_url, file_id, mime_type?,
   file_name? }` the client fills in for the file param (the standard Apps SDK
   path ChatGPT uses once the declaration is present); or
2. request-level **`_meta["openai/fileParams"]`** — the same entry shape (array or
   single object) carried in request metadata (the earlier, production-proven
   delivery), still accepted.

In both, `download_url` is a **short-lived signed URL** the server must fetch
promptly. The adapter parses each defensively — any unknown shape treated as
*absent* so a malformed argument or `_meta` silently falls back to mode B rather
than erroring. The tool's JSON schema still never carries image bytes; only the
signed-URL handle. Field/handle names (`download_url`, `mime_type`, the single-use
upload link) deliberately track the in-progress MCP file-upload drafts **SEP-2356
/ SEP-1306**, so swapping to the ratified standard later is a mechanical rename,
not a redesign.

## set_want — write, idempotent

Mark a catalog cigar as wanted, or clear the mark (PRD-003 R-WANT). A single
per-user flag, independent of owning or smoking it — smoking never clears a want,
and it is cleared only on an explicit request. "Put the Opus on my want list" →
`set_want wanted: true`; "take it off" → `set_want wanted: false`. When
`record_purchase` returns `wanted: true`, the user just bought something they'd
wanted — offer the clear here (never clear it silently).

```yaml
arguments:
  cigarId: cg_01j9x2             # from a prior search_cigars/get_cigar result
  wanted: true                   # true marks it, false clears it
  note: "gift idea for Dad"      # optional; the user's own reason, only if given

result:
  cigarId: cg_01j9x2
  wanted: true                   # the resulting state (echoes the request)
  note: "gift idea for Dad"      # the note now on the mark, or null (null once cleared)
  changed: true                  # false on an idempotent no-op
```

**Target-state, not append.** The desired end state *is* the argument, so the
write is idempotent by nature and takes **no `clientRequestId`** — a repeat call
is a safe no-op (`changed: false`). Setting an already-set mark keeps any existing
`note` unless a new one is given (a bare re-mark never wipes the "why"); clearing
drops the note. An unknown `cigarId` is `cigar_not_found`. The `note` is
MCP-authored only in v1 — the web has no input field — and displays on the cigar
detail page. Scope `journal:write`; the `wanted` overlay on `search_cigars`/
`get_cigar` reads under `journal:read`.

## set_favorite — write, idempotent

Mark a catalog cigar as a favorite — one the user *loves* — or clear the mark
(PRD-003, DESIGN-002). The second per-user cigar-level mark, mirroring `set_want`
but a distinct meaning: Favorite = loves it, Want = wants to try/own it. A
favorite is independent of want, owning, and smoking, and is **never inferred**
— set it only when the user asks ("add the Padrón to my favorites" →
`set_favorite favorited: true`; "take it off my favorites" → `favorited: false`).
It is never derived from a smoke's `liked` signal (that field stays explicit-only).

```yaml
arguments:
  cigarId: cg_01j9x2             # from a prior search_cigars/get_cigar result
  favorited: true                # true marks it, false clears it
  note: "my desert-island stick" # optional; the user's own reason, only if given

result:
  cigarId: cg_01j9x2
  favorited: true                # the resulting state (echoes the request)
  note: "my desert-island stick" # the note now on the mark, or null (null once cleared)
  changed: true                  # false on an idempotent no-op
```

**Target-state, not append.** Like `set_want`, the desired end state *is* the
argument, so the write is idempotent by nature and takes **no `clientRequestId`**
— a repeat call is a safe no-op (`changed: false`). Setting an already-set mark
keeps any existing `note` unless a new one is given; clearing drops the note. An
unknown `cigarId` is `cigar_not_found`. The `note` is MCP-authored only in v1 —
the web has no input field — and displays on the cigar detail page. Scope
`journal:write`; the `favorited` overlay on `get_cigar` reads under `journal:read`.

## request_cigar_enrichment — write, idempotent

Queue a background lookup to fill an **existing** sparse cigar's specs and a
product photo (ADR-009). `add_cigar` covers only missing cigars; this repairs one
already in the catalog. It never creates a cigar and never touches the journal.

```yaml
arguments:
  cigarId: cg_01j9x2             # an existing catalog id; from search_cigars/get_cigar

result:
  cigarId: cg_01j9x2
  status: queued                 # queued | already_queued | recently_enriched | not_needed
  missingFields: [dimensions, tobacco, productPhoto]
  verification: unverified
  queued: true                   # a request row was inserted (false for the other statuses)
```

**Target-state, not append.** Reuses the `enrichment_requests` queue and its
dedupe (the gap-fill flow's pending/fulfilled gate), so it is idempotent by nature
and takes **no `clientRequestId`** — a repeat is a safe no-op. `status` is
`queued` (enqueued now), `already_queued` (one is pending/in progress),
`recently_enriched` (a fulfilled request exists — the crawler recently filled it),
or `not_needed` (already complete — a photo and full dimensions, nothing the
lookup adds). An unknown `cigarId` is `cigar_not_found`. Scope `journal:write`.

## update_cigar — write, idempotent

Fill blank factual catalog fields from what the user knows (ADR-009) — the
conversational half of catalog repair. **Fill-nulls-only:** a field is written
ONLY while it is currently null AND the cigar is unverified; a non-null value or a
curator-verified entry is never overwritten (trust order, ADR-006; verification
stays curator-only). Never touches the journal. `canonicalName` is identity and
not fillable here.

```yaml
arguments:
  clientRequestId: 5f2c9e10-...
  cigarId: cg_01j9x2
  fields:                        # every field optional; pass only what you can fill
    brand: Padron
    vitola: { name: Torpedo, lengthInches: 6.0, ringGauge: 52 }
    type: NC
    tobacco:
      wrapper: { country: Nicaragua }
    releaseYear: 1994

result:
  cigarId: cg_01j9x2
  changedFields: [brand, vitola.name, vitola.lengthInches, vitola.ringGauge, type, tobacco, releaseYear]
  skipped: []                    # provided but not written (already set, or verified-locked)
  verification: unverified
  replayed: false
```

`changedFields` are the fields actually filled; `skipped` are provided fields left
untouched because they were already non-null or the entry is verified. A verified
cigar fills nothing (all fields skipped). Retry-safe through the mutation envelope,
like `update_smoke`. Vitola sub-fields fill independently. Scope `journal:write`.

## record_price — write, idempotent

Log a price observation for a catalog cigar in the offers model (ADR-009) — the
same store and the same 24h dedupe the crawler uses. Only stated facts travel;
never invent a price.

```yaml
arguments:
  clientRequestId: a7d1f004-...
  cigarId: cg_01j9x2
  price: 334.00                  # dollars, the packaging unit's observed price
  packaging: box                 # single | 5-pack | box | … — the tier this price is for
  sticksPerPackage: 20           # so per-stick is computed (single = 1)
  vendorName: Small Batch Cigar  # a registry shop, matched case-insensitively;
                                 #   OR give a sourceName (+ sourceUrl) for an ad-hoc source
  sourceName: null               # required when no registry vendor matches
  sourceUrl: null
  priceType: retail              # retail | msrp | sale (default retail)
  inStock: true
  observedAt: null               # ISO date/time; defaults to now

result:
  observationId: of_01ke         # the offers row id, or null when deduped
  cigarId: cg_01j9x2
  recorded: true                 # a row was written
  deduped: false                 # true → skipped as identical within 24h (recorded false)
  packaging: box
  pricePerStick: 16.70           # dollars, derived from price / sticksPerPackage; null if not
  currency: USD
  priceType: retail
  observedAt: "2026-08-28T18:02:00Z"
  source: { vendorId: ve_01, vendorName: Small Batch Cigar, name: null, url: null }
  replayed: false
```

**A source is required** — a registry vendor by name, else a named ad-hoc source
(the vendor-or-source rule; an unmatched `vendorName` becomes the ad-hoc source
name so it is never lost). No vendor and no source is a `validation_error`.
**Per-stick is computed only from `price` + `sticksPerPackage`** and never travels
without its packaging (owner ruling). An observation identical to the latest one
for the same (cigar, source, packaging) — same price, currency, availability —
within 24h is **skipped** (`recorded: false`, `deduped: true`); a changed price
always inserts. Retry-safe through the envelope; an unknown `cigarId` is
`cigar_not_found`. Provenance is server-stamped `llm-conversation`; ad-hoc sources
never mint registry vendor rows. Scope `journal:write`.

---

## Curation surface (admin only)

`get_curation_queue` (read, `curation:read`) plus eight writes on `curation:write`:
`set_listing_match_status`, `set_cigar_facts`, `verify_cigar`, `exclude_cigar`,
`restore_cigar`, `set_product_photo_rights`, `rename_cigar`,
`queue_enrichment_backlog`. These are for an operations agent maintaining the
catalog (DESIGN-003 §Curation); a conversational session never uses them. Every
write carries the mutation envelope plus `runId` and `confidence`, and the adapter
stamps `actor: agent` server-side so the review console can group and score a run.
Scope alone is not enough — each handler also requires an admin principal.

### queue_enrichment_backlog — write, idempotent

Enqueue the caller's **photoless holdings** — cigars they hold with no servable
product photo — for the crawler's enrich runs, in one call instead of looping
`request_cigar_enrichment` (#154). Selection is the same read the console's
"Missing photos" section renders, so the number on screen is the number
considered. **Operator-initiated:** the server instructions tell the curation
agent not to call it on its own initiative, and the tool enforces its own
preconditions besides.

```yaml
arguments:
  clientRequestId: 9f2c...        # required; reuse EXACTLY on a retry
  limit: 60                       # optional; 1-100, default 100. Highest remaining stock first
  retryExhausted: false           # optional, default false; re-queue rows the crawler gave up on
  runId: wo-cigar-curate-20260830 # the batch this press belongs to
  confidence: 0.9

result:
  eligible: 55                    # worklist rows before the cap
  considered: 55                  # rows the cap admitted
  queued: 7
  skipped: 48
  enrichedMarkets: [NC]           # markets an enrich lane actually reaches right now
  eligibleVendors: [Fox Cigar]    # vendors that COULD look — the exhaustion denominator
  entries:
    - cigarId: cg_01j9x2
      canonicalName: Trinidad Reyes
      status: queued              # see the taxonomy below
    - cigarId: cg_01j9x3
      canonicalName: Red Anchor Captain
      status: exhausted
      triedVendors: [Fox Cigar]   # only on `exhausted`: who looked and did not carry it
  replayed: false
```

`enrichedMarkets` and `eligibleVendors` answer different questions and are both
reported. A market is **enriched** when some crawl-enabled vendor covering it has
completed an `enrich` run — that is the enqueue gate. A vendor is **eligible**
when it is crawl-enabled and its focus covers the row's market — that is the set
that has to be exhausted before a request retires. A vendor enabled in the
registry with no enrich CronJob scheduled is eligible but not live, and keeps
every matching request open forever; `eligibleVendors` is the only surface that
shows it.

The per-row `status` is `request_cigar_enrichment`'s taxonomy (`queued`,
`already_queued`, `recently_enriched`, `not_needed`) plus three verdicts only a
bulk press has:

| status | meaning | how to clear it |
| --- | --- | --- |
| `exhausted` | **every eligible vendor** spent its own budget on this row (2 completed looks each) and none carried it; `triedVendors` names them | enable a vendor that stocks the brand — the row reopens on its own — or press with `retryExhausted: true` |
| `unverified_name` | nobody has reviewed this canonical name | `rename_cigar` if it is wrong, then `verify_cigar` |
| `no_vendor_coverage` | no crawl-enabled vendor covering that market has completed an `enrich` run | bring that market's enrich lane up |

**A vendor's catalogue is PARTIAL** (ADR-006 amendment 2026-08-30). "No match at
Fox" is evidence about Fox and about nothing else, so the budget is per
*(request, vendor)*: each eligible vendor gets its own two completed looks, and a
request retires only once all of them are spent. A request with no eligible
vendor at all is NOT exhausted — nobody could look, which is a different fact
from "we looked and found nothing" — and it reopens by itself the moment a vendor
becomes eligible, with no reopen call and no `retryExhausted` press.

**Both preconditions are enforced, not advised, and neither has an override.** A
queued request that cannot be served is not inert: every drain that looks and
misses spends one of that vendor's two attempts. Enrichment resolves by canonical
name (slug-token ranking, then a pg_trgm similarity floor), which is why an
unreviewed name is refused; and an untyped cigar needs BOTH markets covered,
because enrichment is what would tell us which one it belongs to.

## Errors

Machine-readable, action-bearing, never exposing SQL, stack traces, secrets,
or other users' existence.

```yaml
error:
  code: cigar_ambiguous
  message: Multiple catalog cigars match "Atabey".
  recoverable: true
  action: { type: ask_user }
  candidates:                    # carry the fields that separate same-named rows
    - { cigarId: cg_01k2m1, canonicalName: Atabey Divinos, brand: Atabey, vitola: Divinos, verification: verified }
    - { cigarId: cg_01k2m2, canonicalName: Atabey Ritos, brand: Atabey, vitola: Ritos, verification: verified }
```

Each candidate carries `brand`, `vitola`, and `verification` (any may be null)
so the `ask_user` question is answerable. Truly identical duplicate rows with no
differentiators are a catalog-curation (merge) problem, not something the client
can resolve.

```yaml
error:
  code: version_conflict
  expectedVersion: 3
  currentVersion: 4
  recoverable: true
  action: { type: retrieve_latest_and_retry, tool: get_smoke }
```

```yaml
error:
  code: validation_error
  recoverable: true
  action: { type: fix_and_retry }
  fields:
    - { path: progression[0].approximatePosition, message: Must be between 0 and 1. }
    - { path: assessment.rating, message: Must be an integer 0-100 or null. }
```

| code | recoverable | action |
|---|---|---|
| `validation_error` | yes | `fix_and_retry` with listed `fields` |
| `unauthenticated` | no | `reconnect` — user relinks the connector |
| `unauthorized` | no | none — scope/ownership; do not retry |
| `cigar_not_found` | yes | `search_first` or use `described` |
| `cigar_ambiguous` | yes | `ask_user` (candidates included) |
| `smoke_not_found` | no | none — id came from nowhere; re-query history |
| `version_conflict` | yes | `retrieve_latest_and_retry` via `get_smoke` |
| `idempotency_conflict` | no | new `clientRequestId` for a genuinely new intent |
| `unavailable` | yes | retry once with the same envelope, then tell the user; the fallback below preserves the entry |

Idempotent replay is not an error: same envelope returns the original result
with `replayed: true`.

**Two validation layers.** Value violations the domain owns — rating range,
`approximatePosition` bounds, malformed `smokedAt`/`smokedAfter` dates, empty
`update_smoke.changes` — return the structured `validation_error` above (machine
code + `recoverable` + `action` + `fields[].path`). Schema-*shape* violations
caught before dispatch — an unknown enum value (`draw: "silky"`), a wrong-typed
strict field, or an unknown top-level key (an injected `userId`) — surface as a
standard MCP protocol error (`-32602`) whose message names the offending path.
Both are actionable; leaf types are kept lenient precisely so domain-owned value
checks return the richer structured shape instead of an opaque protocol error.

## Fallback without write tools

If the active client cannot invoke write tools, the model emits the exact
`save_smoke` `arguments` YAML as chat text. Two doors, one schema, same
validation:

1. **Site import page** — paste the payload; it runs the identical
   application command (simplest, no second client needed).
2. **Any write-capable MCP client** (Claude Code, Codex) — paste the payload
   there and ask it to call `save_smoke` verbatim.

No handoff infrastructure beyond this for MVP.
