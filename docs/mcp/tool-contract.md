# MCP Tool Contract

Thirty-four tools over the application services, client-neutral: any MCP client
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
(save_smoke, add_cigar, record_purchase, record_purchase_batch, update_smoke,
update_purchase, add_smoke_photo, set_want, set_favorite,
request_cigar_enrichment, update_cigar, record_price — including
lazy catalog create inside save/add, the enrichment queue write, conversational
catalog repair, and chat-submitted price observations). There is no
`catalog:write` scope: catalog mutation rides `journal:write` by house precedent
(the same scope already gates add_cigar's lazy create and the enrichment write).
`curation:read` (get_curation_queue) and `curation:write` (set_listing_match_status,
set_cigar_facts, verify_cigar, exclude_cigar, restore_cigar,
set_product_photo_rights, rename_cigar, queue_enrichment_backlog,
register_taxonomy, update_registry_aliases, assign_cigar_taxonomy, split_cigar)
are a SEPARATE pair, so a journal:write token can never reach a curation tool. get_cigar is the
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
mutation — one id per mutation, not one per turn, so a second call in the same
turn takes its own.

Resolving vs browsing. search_cigars resolves one named cigar ("I'm smoking an
Alma Fuego") — act on its guidance: single_match (an exact catalog-name hit —
proceed), multiple_matches (candidates but no exact hit — confirm the exact one
before saving), brand_match (only a brand was named — ask for the line/vitola),
no_match (nothing matched — fill the gap below, then save; if the mention was
partial, ask for the fuller name first to avoid a duplicate). browse_catalog
answers browsing, filtering, and shopping questions ("what do I want that's in
stock", "my top-rated maduros", "cheapest per stick") — it pages the catalog with
composable filters (q, brand, type, inHumidor, wanted, smoked, inStock) and sorts
(name, my-rating, recently-added, price), returning tiles with the personal
overlay and price-at-a-glance. get_cigar is full detail on one cigar; get_offers
is its current vendor offers and price history (kept out of get_cigar to protect
its budget) — reach for it when the user asks about price or where to buy. A
search match whose vitola.name is null is a family entry — the vitola was never
recorded. When the user names the vitola, put it in vitola.name on add_cigar or
on the save's described cigar so the smoke lands on that vitola's own entry;
when they do not, the family entry is right. A smoke or lot logged against a
family entry moves to a vitola entry only by update_smoke or update_purchase,
one record at a time.

Gap-fill. When you are about to log a smoke or a purchase and search_cigars
matched nothing, fill the gap first: add_cigar creates an unverified entry from
their words and queues enrichment (specs + a product photo) so the save_smoke
that follows links to a real cigar; record_purchase logs an acquisition and
auto-creates the described cigar the same way. Gap-fill is a prelude, never the
answer. add_cigar writes NO journal entry — its result says so,
journalEntryCreated:false — so the request is not complete until the save_smoke
or record_purchase that motivated it has run in the same turn, against the
cigarId add_cigar returned. A catalog row with no journal entry is worse than
no row at all: it looks like success and drops what the user actually said. If
add_cigar or record_purchase errors cigar_ambiguous, show the search_cigars
candidates and ask; only when the user confirms none is theirs, re-issue the
same call with confirmedDistinct:true to create the distinct product — for a
purchase that is one call, not a detour through add_cigar. save_smoke can
error it too and has no such flag: show the candidates, then either save
against the cigarId the user confirms — its clientRequestId is unspent, the
ambiguity wrote nothing — or create the product with add_cigar
confirmedDistinct:true and save against the cigarId it returns under a FRESH
clientRequestId, since add_cigar spent the first one. A spent id is
idempotency_conflict, which does not recover. record_purchase is
also how the humidor count is corrected — the ledger is append-only and
holdings are derived, so a miscount is fixed with a negative-quantity row (say
why in notes), never an edit. Record only what the user stated: never invent a price, date, or
vendor.

Hauls. When the user acquires several cigars at once — a sampler, a box
inventory, a shop run — record_purchase_batch takes the whole lot in one call:
shared facts (date, vendor, packaging) go in defaults, each cigar is one item
with its own clientRequestId, and every item reports its own result. An item
whose name cannot be decided comes back ambiguous with candidates and costs the
batch nothing; show that item's candidates, and when the user confirms none is
theirs re-send the whole batch under a FRESH batch clientRequestId with
confirmedDistinct added to just those items and every other item byte-identical
— the items already recorded replay, so nothing is written twice.

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

Photos. The moment the user shares a photo during a smoke, or says they took
one, call open_photo_drop and relay its link (shareWithUser is the sentence to
say): they add the photo there right then, and every later photo of the same
smoke goes to that same link. Keep the photoDropId and pass it to save_smoke,
which attaches the dropped photos to the saved smoke and reports how many in
photoDrop.attached — never ask the user to send a photo again at the end; when
attached is 0 and they meant to add one, say the link is still open and a photo
added now lands on the saved smoke. Opening a drop while one is open returns
the same drop with a fresh link. After a save, add_smoke_photo with the smoke
id returns a one-time upload link for a photo of that saved smoke, and with a
photoDropId attaches a drop the save did not carry. If the host forwarded an
attached image with either call the photo is stored directly and no link is
needed; delivery.status reports which happened. Never fill the image argument
yourself, and never paste an image, a chat file link, or a file id into any
field. A photo never blocks saving the smoke.

Field conventions:
- rating is an integer 0-100; omit unless the user stated a number, never invent one.
- approximatePosition and any position is a 0-1 fraction through the smoke (0 = light, 1 = nub).
- descriptors are normalized kebab-case tags; specificDescriptors are the user's exact, unusual words kept verbatim.
- smokedAt carries provenance: { source: user, precision: minute } for a stated time, { precision: day } for a date only; omit it entirely when unstated and the server stamps finalize time. Started and ended times are the same: state them only when the user gave them; a save that carries the photo drop takes its start from the drop, and the server derives the duration.
- get_my_smokes text search covers journal title and narrative, impression, construction notes, imported original markdown, and progression verbatim.
- a title alone is not a journal entry — include at least one observation, descriptor, impression, or narrative.
- Combine related corrections into one update_smoke call rather than several.

Catalog curation (admin only). The get_curation_queue read and the thirteen
curation write tools are for an operations agent maintaining the catalog — not for
conversational journaling; a normal chat session never uses them. get_curation_queue
pages the work by kind (unverified, duplicates, match_triage, unbranded, unlined,
unblended, untyped, missing_photos); drain a kind with its nextCursor. A
match_triage row carries a status: auto is a proposed link to rule on, unmatched is
a listing the crawler linked to nothing and its reason says why: no_anchor means
the title spelled the marca a way the registry does not know, and ambiguous means a
brand anchored but no single entry under it settled. Apply only what the evidence
supports: high-confidence corrections apply directly (set_cigar_facts overwrites a
wrong brand/line/type/manufacturer; rename_cigar corrects a wrong canonical name;
verify_cigar; set_listing_match_status confirmed/unmatched; exclude_cigar for
non-cigar pollution, restore_cigar to undo; set_product_photo_rights
approved/suppressed); low-confidence cases are skipped and
reported, never guessed — leave an uncertain brand or type null rather than invent
one. Every unmatch states its reason: pass unmatchedReason (no_match, no_anchor,
ambiguous, market_refusal) whenever you call set_listing_match_status unmatched. A
stated reason is a verdict later enrichment preserves; an unmatch with none is read
as a report on the catalog at that moment, which a later enrichment ask may
supersede by linking the listing anyway.
exclude_cigar never applies to a cigar anybody holds: a worklist row whose
heldLots is above zero has purchase lots pointing at it, and the server refuses the
exclude outright — enforced, not advised, and there is no override. Skip such a row
or rename it; a sampler someone bought is a catalog entry, not pollution.
queue_enrichment_backlog is the operator's bulk enqueue of the photoless
holdings, NOT part of a curation run: do not call it on your own initiative — report
the worklist and leave the press to the operator. It queues a cigar only once its
canonical name is verified and a crawl-enabled vendor covering that market has
completed an enrich run; every other row comes back with the reason and nothing is
written for it. Enrichment matches on the canonical name, so the way to make a row
enqueueable is rename_cigar then verify_cigar. Pass runId (the batch id) and
confidence (0-1) on every write so the run is auditable and reversible. Merges stay
human-only in the web console — there is no merge tool here.

Catalog structure (admin only). A cigar hangs off a brand, a line under that, a
blend under that, with a vitola on the leaf itself. The three structural queue
kinds are one ladder worked in order — unbranded, then unlined, then unblended —
and a row leaving one appears in the next. For a row: decide the levels from the
evidence, call register_taxonomy to find or mint the brand, line and blend it needs
(finding and minting are the same call, and created says which happened), then
assign_cigar_taxonomy with the ids it returned. Never invent a level. Unknown stays
out, and a cigar whose line nobody knows correctly hangs off its brand alone —
that is a finished row, not a gap. Setting nameSource composed hands the canonical
name over to the parts; send preview true first to see the name they compose to
before the flip. update_registry_aliases is what closes a no_anchor listing: add
the spelling as a key on the entity it names, never loosen the match. A key some
other entity already claims is refused and that entity is named — use it rather
than working around it, because the refusal is usually a near-duplicate caught.
rename_registry_entity corrects the spelling an entity is DISPLAYED under (H
Upmann to H. Upmann) and moves nothing else: the slug and the matching keys it
already holds stay, so listings that match today keep matching, and the new
spelling becomes a key only when it folds to one the entity does not hold.
split_cigar breaks an entry that has been standing for several products into the
leaves it should have been and moves each product's listings onto its own; split
only on unambiguous listing evidence, leave the rest, and expect a partial split.
It refuses a listing a curator or agent already ruled on. A leaf it mints inherits
the line and blend you leave out from the entry being split, and minting is
get-or-create like register_taxonomy — parts that already name a live entry
re-point onto it rather than growing a second copy of it.
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

### The session's bounds and its length (ADR-016)

`startedAt` and `endedAt` are a second, separate pair — when the cigar was lit
and when it was put down — and they carry provenance the same way:

```yaml
startedAt: { value: "2026-09-02T01:04:00Z", source: photo-drop }
endedAt:   { value: "2026-09-02T02:20:00Z", source: system-finalized }
durationMinutes: 76
```

- **State a bound only when the user stated it** (`{ value }`; source `user`).
  Like `smokedAt`, `user` is the only provenance a client may assert —
  `photo-drop` and `system-finalized` are the server's own observations. A
  stated bound is never overwritten by one.
- **The photo drop establishes the start.** A `save_smoke` carrying a
  `photoDropId` with no stated `startedAt` takes that drop's *session* start,
  source `photo-drop` — the moment this smoke's first photo appeared, not the
  drop's creation (one open drop per user, so the same drop is re-used for
  evenings on end). A late `add_smoke_photo { photoDropId }` fills it in the
  same way, and neither overwrites a start that already exists.
- **Finalizing establishes the end.** `endedAt = now`, source
  `system-finalized`, exactly when the server stamps `smokedAt`. A save carrying
  a stated `smokedAt` is a user logging after the fact and gets no end.
- **When the server stamps `smokedAt` and a start exists, `smokedAt` takes the
  start's value** — the journal date is when the cigar was lit, not when it was
  written up, so a smoke lit before midnight files under the evening it belongs
  to. `system-finalized` therefore reads as *the server's best observation of
  when the smoke happened*, not literally the finalize instant (ADR-002 as
  amended). A user-stated `startedAt` with `smokedAt` unstated makes `smokedAt`
  that value, `source: user, precision: minute`.
- **`durationMinutes` is derived on every read, never stored:**
  `floor((ended − started) / 60s)` when both bounds exist, the difference is
  positive, and it is at most twelve hours; otherwise null. Never send it — it
  is an output only, and a stored number would go stale the moment either bound
  is corrected.
- An `endedAt` before its `startedAt` is a `validation_error`. Any other
  combination is stored as given, and the derivation reports null when it cannot
  vouch for the pair.

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
- `no_match`: nothing matched — call `add_cigar`, then save against the `cigarId`
  it returns, in the same turn. A described `save_smoke` still creates the cigar,
  but that is the safety net for a client that skipped the prelude, not the
  documented action (#177). Do not retry search with invented details; when the
  mention was partial, ask for the fuller name first so the gap-fill does not
  create a duplicate.

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
    bestSingle:                #   the cheapest single (DESIGN-005); null when none is offered
      amount: 18.40            #   what ONE stick costs, from this vendor
      currency: USD
      vendor: Small Batch Cigar
      seenAt: "2026-08-28T18:02:00Z"
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
banned (owner ruling). Quote `lowest` with its packaging and `bestSingle` as the
single price; an offer whose `packaging` is `null` is "not stated" — never a
stick price (DESIGN-005). `pricing` is `null` when the cigar has no observations;
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
  offers:                        # current offer per (source, packaging) series, in tier order:
                                 #   single → packs → box → packaging not stated, best per-stick inside each
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

An offer whose `packaging` is `null` is one nobody recorded a packaging for:
quote it as a package price with that said, never as a stick price (DESIGN-005
rule 1). Catalog/market-scoped (offers are identical for every viewer), so
`get_offers` takes no personal bounding and needs only `catalog:read`. A cigar
with no offers returns `offers: []` and a zeroed `history` (all null, count 0)
rather than an error — an id from a prior tool result always exists.

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
      startedAt: { value: "2026-07-30T21:05:00-04:00", source: photo-drop }   # null when unknown
      endedAt: { value: "2026-07-30T22:21:00-04:00", source: system-finalized }
      durationMinutes: 76        # derived from the pair on read (ADR-016); null when unknown
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
    startedAt: { value: "2026-07-30T21:05:00-04:00", source: photo-drop }   # user | photo-drop; null when unknown
    endedAt: { value: "2026-07-30T22:21:00-04:00", source: system-finalized } # user | system-finalized
    durationMinutes: 76          # derived from the pair on read (ADR-016), never stored
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
  startedAt: { value: "2026-08-26T20:15:00-04:00" }   # ONLY when the user stated when they lit it;
                                 #   omit and the photoDropId's session start is used
  endedAt: { value: "2026-08-26T21:31:00-04:00" }     # ONLY when the user stated when they put it down;
                                 #   omit and a live save ends at the save
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
  photoDropId: pd_01kf           # OPTIONAL — the drop opened for this smoke (open_photo_drop, ADR-014)

result:
  smoke:
    smokeId: sm_01jc8x
    version: 1
    url: https://cigars.haynesnetwork.com/smokes/sm_01jc8x
    cigar: { cigarId: cg_01j9x2, verification: verified }
    startedAt: { value: "2026-09-02T01:04:00Z", source: photo-drop }   # null when unknown
    endedAt: { value: "2026-09-02T02:20:00Z", source: system-finalized }
    durationMinutes: 76          # derived from the pair, never stored; null when it can't be vouched for
  cigarCreated: false            # true when `described` created an unverified entry
  enrichmentQueued: false        # true only alongside cigarCreated — the new entry's specs + photo lookup
                                 #   ABSENT on an idempotent replay of an envelope recorded before this field
  specializedFrom:               # PRESENT ONLY when a stated vitola specialized a family entry (ADR-017)
    cigarId: cg_01j9x2           #   the family entry — untouched; this smoke is on the sibling above
    canonicalName: Padron 1926 Natural
  holdingAfter:                  # PRESENT ONLY when a `consumption` block was supplied
    totalAcquired: 7             #   (additive; mirrors record_purchase's holdingAfter)
    remaining: 6                 #   max(0, totalAcquired − count(consumptions)) (ADR-008)
  photoDrop:                     # PRESENT ONLY when `photoDropId` was supplied
    photoDropId: pd_01kf
    status: claimed              # claimed | not_found | bound_elsewhere | failed
    attached: 2                  #   photos moved onto this smoke by the claim
    pending: 0                   #   photos left in the drop (only when the smoke's photo cap was hit)
  replayed: false
```

**The photo drop is claimed after the save, never inside it (ADR-014).** With
`photoDropId`, the drop's staged photos are moved onto the new smoke and the drop
is bound to it, so a photo added through the same link afterwards lands on the
smoke directly until the link expires. The claim runs after the save transaction
commits, in its own transaction, and **never fails the save**: a drop that is not
the caller's (or does not exist) reports `not_found`, one already bound to a
different smoke reports `bound_elsewhere`, an unexpected failure reports
`failed` — and the smoke is saved in every case. An idempotent replay re-runs the
claim (it is idempotent) and re-reports it. A save without `photoDropId` touches
no drop, however many the user has open: attachment is explicit, never inferred
(compare `consumption`). `add_smoke_photo` accepts the same `photoDropId` for a
drop the save did not carry.

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

**The described save is the safety net, not the documented path (#177).**
`add_cigar` → `save_smoke` is what the server instructions tell a client to do; a
`described` ref still resolves-or-creates inside the save transaction, so a client
that skips the prelude never loses the entry. When such a save *creates* the
entry, and only on the conversational path, its background enrichment is queued
too and reported as `enrichmentQueued`. Three gates, each load-bearing:

- `cigar.created` — a save that linked to an *existing* row filled no gap.
  Queueing there files requests against the unverified/untyped rows the curation
  press refuses by design, and would make `enrichmentQueued: true` reachable with
  `cigarCreated: false`, which this contract says is impossible.
- `described` refs only — a `cigarId` save never creates, and takes no extra reads.
- `provenance.source: llm-conversation` — the legacy importer saves per review with
  `described` cigars under `legacy-import`, and an ungated queue would file one
  enrichment request per distinct cigar on the next archive import. The web form
  (`manual`) is excluded for the same reason; it has its own repair surfaces.

The enrichment is never bought with the entry: the queue attempt runs in a
savepoint, and any failure returns `enrichmentQueued: false` with the smoke saved.
`record_purchase` guards its ledger row the same way.

**`enrichmentQueued` is absent, not false, on an idempotent replay of an envelope
recorded before the field existed** — a replay returns the stored result verbatim,
so read it as optional and treat its absence as "not reported", never as `false`.

**A stated vitola against a family entry lands on the sibling (ADR-017).** A
catalog entry whose `vitola.name` is null is a *family entry* — the vitola was
never recorded — and a `described` cigar that states one does not link to it: the
save resolves to that vitola's own entry under the family's brand/line/blend,
minting it if it does not exist yet, and reports `specializedFrom { cigarId,
canonicalName }` (the family entry, untouched). `cigarCreated` says whether the
sibling was minted here or already existed, and the enrichment gates above are
unchanged. Smokes and lots already on the family entry stay there; each moves
only by `update_smoke` / `update_purchase`.

## add_cigar — write, idempotent

Create an unverified catalog entry from the user's own naming when search_cigars
matched nothing, and queue background enrichment so the crawler fills the specs
and a product photo. Use before `save_smoke`/`record_purchase` when the cigar is
missing. Resolve-or-create is the exact path `save_smoke` uses for a described
cigar — it links only to a close row making the *same* identity claims, raises
`cigar_ambiguous` when a close row differs by a word or a stated wrapper, and
creates an unverified entry otherwise (nothing close, or a number/packaging
difference the names state outright); this tool adds the enrichment queue and the
`confirmedDistinct` escape hatch — which `record_purchase` carries too, so an acquisition never needs
this tool as a detour just to reach the flag.

**It is a prelude, never the answer** (#177). It writes no journal entry and no
purchase — `journalEntryCreated` is always `false` — so it never satisfies "log
this smoke" or "I bought these": the `save_smoke` or `record_purchase` that
motivated it still has to run in the same turn, against the `cigarId` returned. A
catalog row with no journal entry is worse than no row at all, because it looks
like success and drops what the user said — a live loss on 2026-08-30, when
`add_cigar` ran, no `save_smoke` followed, and the turn reported success.

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
  enrichmentQueued: true         # a request was FILED — false when one is already open, or nothing is missing
  journalEntryCreated: false     # ALWAYS false — cataloguing is not journaling
  guidance: created              # created | already_existed
  specializedFrom:               # PRESENT ONLY when a stated vitola specialized a family entry (ADR-017)
    cigarId: cg_01j8               #   the family entry, left exactly as it was
    canonicalName: Padron 1926 Natural
  replayed: false
```

Enrichment is queued at most once per cigar: skipped when a pending or fulfilled
request already exists, or when the entry already has both a product photo and
full vitola dimensions (nothing left to fill). A described name that matches two
catalog rows — or lands a word away from one, "Atabey Black Ritos" against a
catalogued "Atabey Ritos" (production, 2026-09-01) — returns `cigar_ambiguous`
with candidates, exactly as `save_smoke`.

**A family entry is specialized, never retyped (ADR-017).** When the described
cigar states `vitola.name` and the single close entry records none (`vitola.name`
null — a *family entry*, the vitola was simply never recorded), this tool mints
that vitola's own sibling under the family's `brand`/`line`/`blend` — with the
stated vitola and dimensions on it, named as the user named it when that already
carries the vitola and `<family name> <vitola>` otherwise — and reports
`specializedFrom { cigarId, canonicalName }` for the family entry. The family
entry is not edited: setting its vitola would declare every smoke and lot already
on it that vitola. A sibling that already exists links instead
(`created: false`), still with `specializedFrom`. The rule keys on the *field*: a
size word in `canonicalName` alone is still vocabulary and links, an entry whose
recorded vitola merely *differs* is a different product and creates as before,
and a description that states no vitola links to the family entry as ever.

## record_purchase — write, idempotent

Append an acquisition to the humidor ledger — or correct the count. Everything
is a purchase row: the ledger is append-only and holdings stay derived, so a
miscount is fixed with a negative-quantity row, never an edit. A described cigar
with no catalog match is auto-created through the same resolver `add_cigar` uses,
and its enrichment queued; a described name that *links* to an existing row filled
no gap and queues nothing, and a resolved id links directly. The queue runs after
the ledger row, in a savepoint — a failed enrichment never costs the purchase.

```yaml
arguments:
  clientRequestId: 8c14aa7e-...
  cigar:                         # exactly one of cigarId / described (as save_smoke)
    cigarId: cg_01j9x2
  confirmedDistinct: false       # optional, default false; `described` refs only —
                                 # the cigar_ambiguous recovery, below
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
  cigarCreated: false          # whether THIS purchase created the catalog entry
  enrichmentQueued: false      # implies cigarCreated — a link filled no gap
  replayed: false
```

Only stated facts travel — never invent a price, date, or vendor. A negative
quantity without `notes` is a `validation_error` (the correction must carry its
reason); a zero quantity is rejected. Provenance is server-stamped
`llm-conversation`; the vendor registry is admin data and is never created from a
conversational mention. **`wanted`** reports whether the caller had this cigar on
their want list — acquisition never clears it silently (R-WANT-2), so when it is
`true` the model offers the clear (`set_want`, `wanted: false`).

**`cigar_ambiguous` recovers in ONE call** (2026-08-31). A described name that
strong-matches two catalog rows — or a related-but-distinct sibling the
number/packaging guard refuses to link — returns `cigar_ambiguous`, exactly as
`add_cigar` does. Show the user the `search_cigars` candidates; when they confirm
none is theirs, re-issue **this same `record_purchase`** with
`confirmedDistinct: true`. The semantics are `add_cigar`'s, field for field:
strong-link and ambiguity are skipped and the described entry is created, except a
case-insensitive **exact** `canonical_name` match still links (`created: false`),
so an override can never mint a literal duplicate. It applies to a `described` ref
only — a `cigarId` is already resolved — and changes nothing else about the call:
the ledger row, its audit, the savepointed enrichment queue and its `cigar.created`
gate behave exactly as they do without the flag, so an override that linked an
exact name created no gap and queues nothing. Reusing the `clientRequestId` from
the ambiguous attempt is safe — that call rolled back and recorded no envelope —
and a genuine retry of the confirmed call replays as usual (`confirmedDistinct` is
part of the intent, so it must be repeated identically, like every other argument).

Without it, a sampler of related-but-distinct sticks cost three calls each —
`search_cigars` → `add_cigar(confirmedDistinct)` → `record_purchase(cigarId)` —
because the flag existed only on `add_cigar`.

## record_purchase_batch — write, idempotent

One acquisition of several different cigars in one call: a sampler, a box
inventory, a shop run, a retailer order. Every item is an ordinary
`record_purchase` — the same resolver, the same `confirmedDistinct`, the same
enrichment gate, the same audit attribution, its own idempotency envelope — so
this tool adds no ledger semantics of its own and none can drift. What it adds
is **per-item results**: an item the resolver cannot decide comes back
`ambiguous` while the rest of the batch lands.

```yaml
arguments:
  clientRequestId: 5f2b70a1-...   # the BATCH envelope; a corrected re-send takes a NEW id
  defaults:                       # optional; the facts the whole lot shares
    purchasedAt: "2026-08-31"
    vendorName: Small Batch Cigar
    packaging: sampler
  items:                          # 1..50 entries, one per DISTINCT cigar
    - clientRequestId: 0d3c81ee-...        # this item's own envelope, distinct from every other
      cigar:                               # exactly one of cigarId / described (as record_purchase)
        described: { canonicalName: Tatuaje Monster Smash The Mummy, brand: Tatuaje }
      quantity: 1
      confirmedDistinct: false             # optional; `described` refs only, per item
    - clientRequestId: 9a17f240-...
      cigar: { cigarId: cg_01j9x2 }
      quantity: 2
      pricePerStick: 11.0                  # any default is overridable per item

result:
  items:
    - index: 0
      clientRequestId: 0d3c81ee-...
      status: created                      # created | existing | ambiguous | failed
      purchaseId: pu_01kd
      cigar: { cigarId: cg_01kf, canonicalName: Tatuaje Monster Smash The Mummy, verification: unverified }
      holdingAfter: { totalAcquired: 1, remaining: 1 }
      wanted: false
      enrichmentQueued: true
      replayed: false
    - index: 1
      clientRequestId: 9a17f240-...
      status: ambiguous                    # nothing written for this line
      error:
        code: cigar_ambiguous
        recoverable: true
        action: { type: ask_user }
        candidates: [ ... ]                # the ranked siblings, as record_purchase returns them
  summary:
    items: 2
    recorded: 1                            # created + existing
    created: 1
    existing: 0
    ambiguous: 1
    failed: 0
    replayed: 0                            # recorded items whose own envelope replayed
    sticks: 1                              # net quantity across the recorded items
  replayed: false                          # the BATCH envelope replayed
```

**Four statuses, one action each.** `created` — the ledger row landed and this
item created the catalog entry (so its enrichment was queued). `existing` — the
row landed against an entry the catalog already had. `ambiguous` — nothing was
written; `error.candidates` are the siblings to show the user. `failed` —
nothing was written; `error` says why (a `validation_error` with its field paths
rewritten to `items[i].<field>`, an unknown `cigarId`, a spent key). There is no
separate "inventory updated" status: every `created`/`existing` item appended its
ledger row, and `holdingAfter` reports the count it produced.

**Two envelope layers, and the item layer is the load-bearing one.** The batch
key replays an identical re-send, doing no work at all. The item keys are what
make a partial batch safe to re-issue **whole**: show the user the `ambiguous`
items' candidates and, when they confirm none is theirs, re-send every item under
a **fresh batch `clientRequestId`** with `confirmedDistinct: true` added to just
those items and every other item byte-identical. The items already recorded
replay (`replayed: true`, no second lot); only the corrected ones do new work.
Do not add `confirmedDistinct` to an item that already succeeded — that changes
its fingerprint and the line comes back `failed` with `idempotency_conflict`.
The batch key and every item key share one `(user, clientRequestId)` namespace,
so a duplicate among them is refused up front as a `validation_error` rather than
spending a key.

**`defaults` are the acquisition facts a haul shares** — `purchasedAt`,
`vendorName`, `packaging`, `boxDate`, `humidorAt`, `pricePerStick`, `notes`. An
item that sets the field wins, including an explicit `null` (how one line opts
out of a default); an item that omits it inherits. The merged item is exactly the
`record_purchase` a standalone call would carry, so its fingerprint is the same
either way. **`confirmedDistinct` is deliberately not a default**: the flag
records that the user was shown candidates for *one* cigar and said none is
theirs, and a batch-wide default would let a single "no" authorize fourteen
creates.

**Not one transaction, deliberately.** Atomicity is the opposite of what a haul
wants — the requirement is that one undecidable cigar isolates to its line while
the others land — so each item commits in its own transaction and the batch key
is written after them. A systemic fault (not a domain error) propagates and the
batch key is never recorded, so the same batch id retries cleanly: the lines that
committed replay through their own envelopes. Items run in order, never in
parallel: the lines of one haul routinely name near-identical siblings, and each
is resolved against the catalog as it then stands.

At most 50 items, one entry per distinct cigar — repeats of the same stick are a
`quantity`, not a repeated entry. The real case this was built for is a 14-cigar
Tatuaje Monster Smash sampler that cost roughly three calls per stick
(`search_cigars` → `add_cigar(confirmedDistinct)` → `record_purchase(cigarId)`);
it is now one call, or two when the siblings need confirming.

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
    startedAt: { value: "2026-08-25T21:00:00-04:00" }   # explicit null clears it and its source
    endedAt: { value: "2026-08-25T22:16:00-04:00" }     # an end before its start is a validation_error
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
  changedFields: [assessment.rating, cigar, progression, consumption, startedAt, endedAt]
  replayed: false
```

Deletion is web-only. Imported Smokes accept structured-field changes; their
original markdown is immutable. The `startedAt`/`endedAt` ops set the session's
bounds with `source: user` — a correction is a statement, so it outranks whatever
observation stood there — and an explicit null clears the instant and its source
together. `durationMinutes` has no op: it is derived from the pair on read
(ADR-016), so correcting either bound is how it changes. The `consumption` op sets, clears
(`fromHumidor: false`), or re-attributes the humidor link (ADR-008); re-pointing
the smoke's `cigar` clears a now-foreign lot automatically. The movement is
audited in the same transaction as the smoke change.

## update_purchase — write, idempotent

Re-point one purchase lot at the correct catalog entry ("that box was the No.
2") — the ledger's counterpart to `update_smoke`'s `cigar` op (ADR-017), and
field-scoped the same way. **The cigar is the only thing a lot can change**: the
ledger is append-only and holdings stay derived, so a miscount is still a
negative-quantity `record_purchase` row and never an edit.

```yaml
arguments:
  clientRequestId: 41c0aa93-...
  purchaseId: pu_01kd
  changes:
    cigar: { resolveTo: cg_01j9x7 }        # the only op there is

result:
  purchase:
    purchaseId: pu_01kd
    cigarId: cg_01j9x7
    canonicalName: Padron 1926 Serie No. 2 Natural
  changedFields: [cigar]        # empty when the lot already pointed there — a no-op, not an error
  replayed: false
```

Owner-only: a lot that is not the caller's reads exactly like one that does not
exist (`purchase_not_found`), so ownership never leaks. An unknown or malformed
`resolveTo` is `cigar_not_found`. The move is audited as `purchase.repoint` with
the cigar on both sides, in the same transaction as the update.

**It is refused while a smoke consumed from the lot sits on another cigar.** Any
`smoke_consumptions` row on the lot whose smoke links to a cigar other than the
destination returns `validation_error` on `changes.cigar.resolveTo`, naming those
smoke ids: moving the lot under them would leave a consumption claiming a lot of
one product for a smoke of another. Move the smokes first with `update_smoke`,
then re-point the lot. Nothing here is bulk — a family entry is never migrated as
a whole, because only the owner knows which stick was which (ADR-017).

## open_photo_drop — write

Open a **photo drop** for the smoke in progress (ADR-014, issue #263): a link the
user adds photos to at any point during the smoke, before it is saved. The
photos wait in the drop; `save_smoke` with the drop's id attaches them to the
saved smoke, and the same link then keeps working for that smoke until it
expires. This is the photo path for a live smoke — `add_smoke_photo` needs a
`smokeId`, which only exists after the save, and asking the user to send a photo
again at the end is the failure this tool exists to remove.

```yaml
arguments: {}                    # no smoke yet, nothing to name; `image` as on add_smoke_photo

result:
  photoDropId: pd_01kf
  uploadUrl: https://cigars.haynesnetwork.com/d/<token>
  expiresAt: "2026-09-03T20:15:00Z"       # 48h after opening
  reused: false                  # true when the user already had an open drop — same photos, fresh link
  photoCount: 0                  # photos already in the drop (meaningful when reused)
  shareWithUser: "Send the user this link to add photos during the smoke: https://… — every photo of this smoke goes there, and they attach to the review when it is saved. It lasts 48 hours."
  delivery:                      # as on add_smoke_photo: why no image arrived with the call
    status: no_image_received
    detail: "No image arrived with this call. Chat attachments are not forwarded to this server by any current client, so the upload link is the path — relay it. This is the expected outcome, not a failure."

# With a forwarded image (never observed on this connector — see add_smoke_photo):
result:
  photoDropId: pd_01kf
  uploadUrl: …
  staged: { photoId: ph_01kg, kind: cigar, width: 1080, height: 1440 }
```

- **When to call it: the moment a photo appears, not when the smoke ends.** The
  server instructions say it in one sentence. The user adds the photo to the drop
  while they still have it in hand; two hours later the model passes
  `photoDropId` to `save_smoke` and the photos are on the review. The link takes
  every later photo of the same smoke, so it is relayed once.
- **Multi-use, bounded.** The link works for 48 hours and up to twelve photos
  (`MAX_PHOTOS_PER_SMOKE`); the page shows only the drop's own photos and lets
  the user set a photo's kind, caption it, or remove it. A single-use link is
  right for one photo of a saved smoke; it is wrong for an event that produces
  several photos over hours.
- **One open drop per user.** Opening again while a drop is open (unclaimed,
  unexpired) returns *that* drop — `reused: true`, its `photoCount` — with a
  fresh token; the earlier link stops working. The raw token is never stored, so
  reuse must rotate. This is what lets a model that lost the id in a long chat
  recover the photos by opening again.
- **Nothing is claimed implicitly.** A drop attaches only through a
  `photoDropId` the caller passes (`save_smoke`, or `add_smoke_photo` for a late
  claim). Unclaimed drops expire and are swept seven days after opening.
- Scope `journal:write`. Errors: `unavailable` when photo storage is unconfigured.
  The same file intake and `photo_intake` diagnostics as `add_smoke_photo` apply
  (the record names the tool).

## add_smoke_photo — write, link-first

Attach a review-bound photo to one of the user's smokes (ADR-007, issue #44).
The tool returns a **one-time upload link** for the user to open on their phone;
if the host happened to forward a file with the call, the photo is stored
directly instead. The image is **never** a tool argument the model writes — it
arrives attached by the HOST, or not at all — and the tool auto-detects which. A
photo failure is fully isolated from `save_smoke`: separate tool, separate
result, its own storage transaction. For a photo taken *during* a smoke that is
not yet saved, the path is `open_photo_drop` above; this tool is for a photo of
a smoke that already exists.

```yaml
arguments:
  smokeId: sm_01jc8x
  kind: band                     # cigar | band | construction | burn | other (default cigar)
  caption: "The second band"     # optional; only if the user gave one
  photoDropId: pd_01kf           # optional — claim a drop the save did not carry (ADR-014)

# Mode C — a drop was named: its photos move onto the smoke, no link is minted
result:
  mode: drop_claimed
  photoDrop: { photoDropId: pd_01kf, status: claimed, attached: 2, pending: 0 }
                                 # not_found → error photo_drop_not_found; bound_elsewhere → validation_error

# Mode B — the ordinary result: a one-time upload link to hand the user
result:
  mode: upload_url
  uploadUrl: https://cigars.haynesnetwork.com/u/<token>
  expiresAt: "2026-08-29T20:15:00Z"       # 24h after minting
  shareWithUser: "Send the user this link to add their photo: https://… — it works once and is valid for 24 hours."
  delivery:                      # why there is no photo, in terms the model can act on
    status: no_image_received    # | image_reference_unusable | image_fetch_failed | image_unreadable
    detail: "No image arrived with this call. Chat attachments are not forwarded to this server by any current client, so the upload link is the path — relay it. This is the expected outcome, not a failure."

# Mode A — opportunistic: a host forwarded a file with the call
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
```

**One primary mode, one opportunistic one.**

- **Upload link (mode B) — the flow.** The tool mints a single-use link bound to
  (user, smoke, kind?, caption?), valid 24 hours, and returns it with
  `shareWithUser`: the sentence the model relays. The user opens it on their
  phone; it goes straight to the camera roll. The link opens a one-tile upload
  page; the token is the authorization, consumed atomically on first successful
  use — after the file has been validated, so a rejected photo leaves the link
  usable (see `apps/web/app/api/photo-uploads/[token]/route.ts`).
- **Attached image (mode A) — opportunistic, never observed on this connector.**
  Declared via `_meta["openai/fileParams"]`, so a host that forwards a file gets a
  direct store: the server fetches it (15s timeout, 20MB cap), runs the shared
  pipeline (EXIF applied + all metadata/GPS stripped, normalized JPEG + thumb),
  and files it under the smoke. **As of 2026-08-31 it has never fired here.** A
  live ChatGPT call captured in Loki carried no `openai/fileParams` on any channel
  (`metaFileParams: {"type":"absent"}`, no `image` argument, no undeclared keys),
  and `mode: attached` has never been seen in production. ChatGPT *does* hydrate
  `openai/fileParams` for some servers — third-party operators report receiving
  `{ file_id, download_url }` objects — so the mechanism is real; it has simply
  never been pointed at this connector, most likely a host-side gating policy
  rather than anything wrong with our declaration. No other client has the
  mechanism at all. See [client-compatibility.md](client-compatibility.md). The
  path stays declared and implemented because it costs nothing and is how this
  works the day a host does forward a file; it is not what the model or the docs
  should lead with. Only the HOST can forward a file, and the description tells
  the model never to paste a chat file URL (e.g. `chatgpt.com/...`) as text —
  those links are unreachable outside ChatGPT and will 403.

  **Open lead.** ChatGPT integrations that reportedly do receive files declare a
  strict four-property file schema for the param; we publish the object through a
  preprocess/passthrough wrapper, which emits a looser shape. Aligning the
  published schema exactly with the Apps SDK reference shape and re-testing is the
  next falsifiable experiment — cheap, and it either fixes it or narrows the cause
  to gating.
  **Experiment 1 shipped 2026-08-31** (issue #202): `image` is now a plain optional
  strict object — the four properties, all optional strings, `additionalProperties:
  false` — with the preprocess/passthrough wrapper and its internal marker removed.
  The retest is the owner attaching an image in ChatGPT and calling
  `add_smoke_photo`; `photo_intake_request` answers, since it records the delivery
  off the unparsed body before validation. If the shape was never the cause, this
  reverts and the cause narrows to host-side gating.

**Mode B is guaranteed, so intake failure is a FALLBACK, not an error** (changed
2026-08-30). A reference that carries no fetchable URL, a URL that fails to fetch
(non-2xx, timeout, over 20MB), and bytes that will not decode all mint the link
instead of returning `unavailable`/`validation_error`. The old behavior returned a
model-visible error for a failure the user could do nothing about, while the link —
the thing that actually works — was withheld. The signal is not lost: it moves into
the `photo_intake` log record (below), which is queryable and alertable, unlike an
error the user never sees. Consequence to watch: a systemic fetch regression is now
quieter in the tool result, so a sustained non-`attached` rate deserves an alert —
though with attachment unobserved, the current non-`attached` rate is 100%.

`delivery` (mode B only) tells the model **why**, without leaking anything:

| `delivery.status` | Meaning | What the model should do |
|---|---|---|
| `no_image_received` | Nothing was forwarded on either channel — the normal outcome on every current client. | Hand over the link. Never report it as a problem. |
| `image_reference_unusable` | A file handle arrived carrying nothing the server can read. | Hand over the link. |
| `image_fetch_failed` | A reference arrived but the image could not be retrieved. | Hand over the link. |
| `image_unreadable` | Bytes arrived but are not a readable photo. | Hand over the link. |

`delivery` never names a URL, a host, a key, or a file id — it is model-visible and
therefore user-visible. The precise diagnosis lives in the log, not the result.

**The link leads, in every branch** (2026-08-30). Earlier drafts of this text and of
the shipped tool description told the model, on `no_image_received`, to ask the user
to re-send the photo with their next message. That instruction encodes an
*unverified hypothesis* — that a host forwards only a file attached to the invoking
turn (client-compatibility.md) — as if it were established behavior. If the
hypothesis is wrong, it costs the user a pointless round trip before they are
offered the link that actually works. So no model-facing string asserts it: the
model hands over the link and uses `delivery.status` to say something true about
why. The hypothesis stays a hypothesis, in client-compatibility.md, until
`photo_intake_request` settles it.

**Amended 2026-08-31 — the same-turn rule is now stated, as odds and not as fact.**
A session that evening supplied the detail the earlier transcript lacked: the
user's photo was attached *several turns before* `add_smoke_photo` was called, and
nothing was forwarded (the upload link carried the smoke). Whatever hydration a
host does, current-turn-only is the plausible contract — every integration
reported to receive files receives the *invoking* turn's attachment. So the tool
description and the server instructions each gained one sentence: a host that
forwards anything is understood to forward only an image attached to the message
that triggered the call, so ask the user to attach (or re-attach) the photo in
that same message when they want it stored directly. This does **not** reinstate
what was withdrawn above. That instruction fired on `no_image_received` and
*delayed* the link; this one is standing advice that ends by naming the link as
the path that works either way, and it is phrased as how to maximize the chance —
never as established behavior — because forwarding has still never been observed
on this connector (#202).

**Withdrawn 2026-09-01 — the same-turn sentence is gone.** The retest ran: the
owner attached the image to the *same message* that asked for the photo, and
`photo_intake_request` recorded `argImage: absent`, `metaFileParams: absent`
(count 0), no undeclared keys (2026-09-02T01:36:17Z, smoke `04869501-…`). Under
same-turn attachment and the strict reference schema, the host forwarded nothing:
issue #202's experiments 1 and 2 are both spent, and developer-mode connectors
being gated out of `openai/fileParams` is the standing explanation. Advice that
costs the user a re-attach for a path now shown not to fire is withdrawn from the
tool description and the server instructions. What replaces it is not advice but
a design: `open_photo_drop` (ADR-014) takes the photo when it is taken, so nothing
has to be re-sent at the end. Attached delivery stays implemented on both tools
for the day a host forwards a file. The strict `image` schema stays as well: it is
the Apps SDK reference shape, and reverting it would only restore a lenience no
host has ever exercised.

**Amended 2026-09-03 — forwarding is not a failure (#288).** Three
`open_photo_drop` calls that night (01:04:08Z, 01:18:09Z, 01:21:46Z) recorded the
settled signature a third time: `paramKeys ["_meta","arguments","name"]`,
`argKeys []`, `argImage absent`, `metaFileParams {"type":"absent"}` count 0,
`photo_intake outcome no_delivery, channel none, mode upload_url`. The link then
carried the photo (`photoId 10edfb52`, 1080×1440). What still cost the owner a
turn was the wording: `no_image_received` read as a fault, so the model reported
one before relaying the link. The `delivery.detail` for that status now names the
outcome as expected and points at the link, and both tool descriptions carry one
sentence saying the same thing. Nothing about the intake changed — only what the
model is told the result means.

Errors are now a shorter set: `unavailable` when photo storage is unconfigured (the
tool is genuinely non-functional — a minted link would 503 on upload),
`smoke_not_found` for a non-owned/unknown smoke, `photo_limit` at the per-smoke cap.
Scope `journal:write`. The mint/consume link is web-only from there on — its
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
is **optional** and every sub-field within it is optional, so a partial file object
never blocks the call; it is kept out of `required`.

**The published shape is STRICT (2026-08-31, issue #202 experiment 1).** `image` is
a plain optional object admitting exactly `download_url`, `file_id`, `mime_type`
and `file_name`, all optional strings, emitting `additionalProperties: false`:

```json
{ "type": "object",
  "properties": { "download_url": {"type":"string"}, "file_id": {"type":"string"},
                  "mime_type": {"type":"string"}, "file_name": {"type":"string"} },
  "additionalProperties": false }
```

This replaced a `z.preprocess` + `.passthrough()` wrapper that preserved anything
the handle schema rejected under an internal marker so the handler could log its
shape. The reason for the wrapper was observability — a shape the SDK refuses never
reaches the event logger — and that reason no longer holds: the HTTP probe below
(`photo_intake_request`) describes the delivery off the **unparsed** JSON-RPC body,
before validation, so a refused shape is still fully recorded. What the wrapper
bought is now paid for a layer earlier, and the published shape is free to match the
Apps SDK reference exactly, which is the experiment.

**The trade, stated plainly.** On the `image` argument, a host sending `null` (a
plausible "no file attached" shape) or a URL under an undeclared key now gets
`InvalidParams` instead of a mode-B upload link. The request-level
`_meta["openai/fileParams"]` channel is not schema-validated and still accepts
both. A manifest-stability test pins the emitted object whole, so a zod/SDK upgrade
cannot drift it. (`.catch()` cannot be used to soften this at all: it throws
"Dynamic catch values are not supported in JSON Schema" at emission time and would
break `tools/list` for the whole server.) If the experiment does not move intake,
this reverts.

**Two deliveries, one fetch path.** Mode A accepts the file handle from either:

1. the declared **`image` argument** — `{ download_url, file_id, mime_type?,
   file_name? }` a client would fill in for the file param (the Apps SDK path); or
2. request-level **`_meta["openai/fileParams"]`** — the same entry shape (array or
   single object) carried in request metadata.

**Neither has ever been observed carrying a file *here*.** Both are accepted on
the strength of the published specs and of other operators' reports, not of a call
we have seen: the 2026-08-31 Loki capture found no `fileParams` on either channel.
An earlier draft of this section called the `_meta` delivery "production-proven" —
proven for ChatGPT's own apps, perhaps, but never for this server, and the probe
that could have shown it returned the opposite. Keep both readers: the cost is a
branch, other servers demonstrably do receive these handles, and the day one
arrives here we want it to just work. Do not plan on either firing.

In both, `download_url` is a **short-lived signed URL** the server must fetch
promptly. Request `_meta` still takes precedence, with one fix: a *present but
unusable* `_meta` now yields to a usable `image` argument (the old `??` fallthrough
could not tell the two apart), and an array of file params is scanned for the first
usable entry rather than only `[0]`. The tool's JSON schema still never carries
image bytes. Field/handle names (`download_url`, `mime_type`, the single-use upload
link) deliberately track the in-progress MCP file-upload drafts **SEP-2356 /
SEP-1306**, so swapping to the ratified standard later is a mechanical rename, not
a redesign.

**What a handle may carry (widened 2026-08-30).** The server accepts the first
non-empty string among `download_url`, `url`, `uri`, `href`, `file_url` — which key
hit is logged. If the declared content type is missing or `application/octet-stream`,
magic bytes (JPEG/PNG/WEBP/HEIC) decide the type before the shared pipeline runs; a
correct photo used to fail on a bad header alone.

**Inline delivery is deliberately NOT accepted.** A draft of this change also took
base64 bytes in `data`/`blob` and `data:` URLs (the SEP-1306 inline shape). It was
speculative — no host is known to deliver that way to this server — and it could not
work as shipped: the JSON-RPC body is parsed by `express.json()` under a **100KB**
limit, so any real photo was rejected with a 413 raised *before* bearer auth, before
the HTTP probe and before the handler, leaving no record at all. Fitting a 20MB photo
would mean a ~27MB **pre-authentication** buffer on every `/mcp` POST. A speculative
feature that reintroduces unlogged failures subtracts from a change whose whole
purpose is to end them, so it was removed rather than expanded: a `data:` URL is now
refused by the scheme guard and lands as the named `bad_scheme` outcome. If a host
ever does inline a file, `photo_intake_request` records the key it used and the path
can be added deliberately, with a body limit chosen for it.

**SSRF guard.** `image.download_url` is a model-writable argument the server fetches
from inside the cluster, so widening the accepted key set shipped *with* a guard, in
the same change. The guard decides on the **parsed address**, never on the spelling
of the host:

- `https` to a public IP literal, or to a DNS name — the real delivery path.
- `http` to a **loopback address** — test fixtures only, and gated to the test
  runner (`NODE_ENV=test`/`VITEST`) rather than shipped enabled. There is no
  production opt-in; an escape hatch here would be the hole itself.
- everything else is `bad_scheme` → mode B, with no socket opened: any other scheme
  (`file:`, `gopher:`, `data:`), any `http` to a non-loopback host, and `https` to a
  loopback, private (RFC 1918), link-local (RFC 3927, which is where
  `169.254.169.254` lives), unique-local, CGNAT, multicast or unspecified address.

Hostnames are classified with `net.isIP` and, when they are addresses, by their
numeric value — including IPv4-mapped/compatible IPv6, 6to4 and NAT64, whose low
bytes carry an IPv4 address that would otherwise bypass the IPv4 rules. WHATWG `URL`
normalizes the exotic IPv4 spellings (`2130706433`, `0x7f000001`, `127.1`) before the
guard runs. Redirects are followed manually, at most three hops, revalidating the
guard on each; a hop the guard refuses is reported as `bad_scheme` with
`fetch.redirectFailure: scheme_refused`, distinct from a missing `Location` or an
over-long chain.

> **Bug fixed 2026-08-30, worth remembering.** The first version of this guard tested
> `host.startsWith("127.")` — a test of the *spelling*, not the address. It allowed
> `http://127.evil.com/`, `http://127.attacker.internal/` and
> `http://127.0.0.1.nip.io/`, so an attacker-controlled DNS name walked through over
> plaintext http; because the redirect check reused the same function, the
> `https://host/` → `http://169.254.169.254/` bypass the guard existed to close was
> open one DNS name away. It also allowed `https://169.254.169.254/` outright, since
> it stopped looking once it saw https. The tests only tried literal IPs, which is
> why they passed. Each of those strings is now a named regression test.

**Known limit, stated plainly: a DNS name that RESOLVES to a private address is not
blocked.** The guard does not resolve, and resolving would not close the hole —
undici re-resolves when it connects, so a rebinding record can answer public to a
check and private to the socket, and `fetch` offers no way to pin the checked address
into the connection. `https` to an arbitrary DNS name has to stay allowed because the
real delivery path is a signed URL on a CDN domain we cannot enumerate. The
containment that actually holds is the cluster's default-deny egress policy;
`fetch.host` is logged so a name pointed somewhere it should not be is visible after
the fact.

**`file_id` alone is not recoverable, and the server says so.** The file lives in
the end user's ChatGPT workspace; the Apps SDK contract is that the *host* resolves
it and hands the server a short-lived `download_url`. There is no documented
endpoint that turns a conversation `file_id` into bytes for a third-party MCP
server, and this service holds no OpenAI credential of any kind (using one of ours
would be a different account's namespace). So a `file_id`-only handle is a
first-class named outcome (`no_url`, with the arriving key names recorded), not a
bug awaiting a retry.

### Intake diagnostics

Two structured log events answer "why did this call not attach a photo", and they
join on `(sessionId, rpcId)`:

Both are written for **both photo tools** — `add_smoke_photo` and
`open_photo_drop` share one intake path (ADR-014), and each record's `tool` field
names the call it came from, with every other field identical.

- **`photo_intake`** — one line per photo-tool call that runs the intake, every
  mode, success and failure (`add_smoke_photo` with a `photoDropId` claims a drop
  and runs none, so it writes no line). Fields: `tool`, `outcome` (`attached` | `no_delivery` | `not_an_object` |
  `no_url` | `empty_url` | `bad_scheme` | `fetch_failed` | `too_large` |
  `unreadable` | `storage_unavailable`), `channel`
  (`argument` | `request_meta` | `none`), `mode`, the `argument` and `requestMeta`
  *shapes*, the `urlKey` that matched, and a `fetch` sub-record
  (`host`, `scheme`, `status`, `ms`, `timedOut`, `redirects`, `redirectFailure`,
  `declaredType`, `sniffedType`, `bytes`) when a fetch ran. `outcome` describes
  **intake**: a later `smoke_not_found`/`photo_limit` arrives as `tool_error` on the
  same `correlationId`.
- **`photo_intake_request`** — written at the HTTP layer, after bearer auth and
  **before** the SDK validates input, so a call the SDK rejects still leaves a
  record. Fields: `tool`, `paramKeys` (the keys of `params` **itself**, so a file handed
  over somewhere the server never reads it still shows up), `argKeys`, `argImage`
  shape, `metaKeys`, `metaFileParams` shape + `count`. This is the class of call
  that previously left no trace at all, and it is what will settle whether the host
  puts the file somewhere the server never looked.
- **`request_rejected`** — written when `express.json()` refuses the body (over the
  100KB limit, or not JSON). Such a request never reaches auth, the probe or the
  SDK, so without this line it is the one shape that fails with no record at all.
  Fields: `path`, `reason` (the parser's error type), `status`, `contentLength` —
  the body is untrusted and unparsed, so nothing from it is logged. The response is
  a JSON-RPC error envelope rather than Express's default HTML page.

All three obey the **shape-not-values** rule (security-and-observability.md): key
names, JSON types, and a per-key "non-empty string" flag — never a handle's values.
There are exactly two bounded exceptions, both named there: `fetch.host` and
`fetch.declaredType` (truncated to 64 characters, since `mime_type` is
host-writable).

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

`get_curation_queue` (read, `curation:read`) plus thirteen writes on `curation:write`:
`set_listing_match_status`, `set_cigar_facts`, `verify_cigar`, `exclude_cigar`,
`restore_cigar`, `set_product_photo_rights`, `rename_cigar`,
`queue_enrichment_backlog`, and the five taxonomy verbs `register_taxonomy`,
`update_registry_aliases`, `rename_registry_entity`, `assign_cigar_taxonomy`,
`split_cigar` (ADR-012 Wave 3).
These are for an operations agent maintaining the
catalog (DESIGN-003 §Curation); a conversational session never uses them. Every
write carries the mutation envelope plus `runId` and `confidence`, and the adapter
stamps `actor: agent` server-side so the review console can group and score a run.
Scope alone is not enough — each handler also requires an admin principal.

Every cigar in a `get_curation_queue` payload — the `cigars` rows and the cigar
nested in a `match_triage` row — carries `heldLots`: purchase lots pointing at it
across **all** users, and its structural ancestry, which is what the taxonomy
verbs take.

```yaml
cigars:
  - cigarId: cg_01j9x2
    canonicalName: Oliva Free Sampler
    brand: null                 # free text, the owner's string
    brandId: null               # the registry link — what `unbranded` keys on
    lineId: null
    blendId: null
    vitola: null
    nameSource: freeform        # freeform | composed
    heldLots: 3                 # somebody owns this — exclude_cigar will refuse it
```

A `match_triage` row also carries `suggestedParse` when the resolver recorded one
(migration 0027): the brand, line and blend the title anchored to, its vitola and
dimensions, the packaging it stripped, and `residue` — the part of the title
nothing accounted for, which is the most useful field on an ambiguous row. It is
**evidence, never a verdict**: an ambiguous row is ambiguous precisely because the
parse did not settle it, so argue from it, do not apply it.

```yaml
matches:
  - matchId: lm_01
    status: unmatched
    reason: ambiguous
    suggestedParse:
      brandName: Padrón
      lineName: 1964 Anniversary Series
      blendName: Maduro          # what the title named...
      vitolaName: Exclusivo
      cleanedName: Padrón 1964 Anniversary Series Maduro Exclusivo
      residue: ""                # ...and nothing left unexplained
```

### set_listing_match_status — write, idempotent

Rule on one `match_triage` row: `confirmed` keeps the cigar the resolver linked,
`unmatched` clears the link. Confirming a row that points at no cigar is a
`validation_error` — there is nothing to confirm.

```yaml
arguments:
  clientRequestId: 9f2c...
  matchId: lm_01
  status: unmatched
  unmatchedReason: no_anchor      # optional, and only with `unmatched`
  runId: wo-cigar-curate-20260901
  confidence: 0.9

result:
  matchId: lm_01
  status: unmatched
  cigarId: null                   # kept on confirm, cleared on unmatch
  unmatchedReason: no_anchor      # null when none was given
  replayed: false
```

**An unmatch should say why, and the saying is what protects it.** ADR-006's
2026-09-01 amendment splits agent unmatches in two. One carrying an
`unmatchedReason` is a **judgement** — somebody worked the row and concluded
something — and the enrich drain leaves it alone. One carrying none is a **report
on the catalog at the moment it was swept**, and a later enrichment ask is catalog
state that moment did not have, so the drain may link the listing anyway. Both are
legitimate; they are not the same verdict, and this argument is the only thing that
tells them apart. An operations lane working the triage queue should state a reason
on every unmatch, because a nightly sweep and a nightly drain that disagree about
the same rows will otherwise overwrite each other indefinitely.

The vocabulary is the resolver's own, so a curator's account of a row reads the
same way the crawler's does:

| value | means |
| --- | --- |
| `no_match` | nothing in the catalog is this product |
| `no_anchor` | the title names no brand the registry knows — the fix is an alias (`update_registry_aliases`), not a link |
| `ambiguous` | a brand anchored but no single entry under it settled |
| `market_refusal` | the vendor's market contradicts the cigar's evidenced market |

**The column is always written.** An unmatch with no reason writes null — the
supersedable shape, deliberately — and a confirm writes null, because a row that
points at a cigar has no reason for not pointing at one. A reason sent alongside
`confirmed` is a `validation_error` on `unmatchedReason` rather than a silently
dropped argument: under this rule a caller that believes it recorded a reason
believes its verdict is protected.

Recording a reason does **not** put the row back in the queue. `match_triage`
admits a reasoned `unmatched` row only when `decided_by` is `crawler`, so a curator
or agent verdict stays settled whatever it says. The write is audited as
`listing_match.set_status` with the reason in both snapshots, and the console's
Undo restores it along with the cigar, status and decider. Scope `curation:write`,
admin only.

### The structural ladder (ADR-012 Wave 3)

`unbranded`, `unlined` and `unblended` are one backlog worked in order: each kind
is "has the level above, lacks this one", so a row sits in exactly one of them and
moves down as it is structured.

**`unbranded` keys on `brandId`, not on the free-text `brand`** — and the two
disagree for hundreds of rows. A row spelled `Padrón` whose `brandId` is null has
a brand a human can read and no brand the catalog can navigate to, group by, or
match a listing against. Keying the queue on the text counted that row as done;
keying it on the link is what makes the queue empty exactly when the structure is
complete.

Nothing here ever invents a level. A cigar whose line genuinely is not known hangs
off its brand and is a **finished** row, not a gap — `unlined` is a queue of rows
whose line is knowable and unrecorded, and the judgement of which is which is the
curator's, made from evidence, one row at a time.

### exclude_cigar refuses a held cigar

`exclude_cigar` returns `validation_error` with a `cigarId` field message when the
target has **any** `purchases` row, for **any** user:

```yaml
error:
  code: validation_error
  recoverable: true
  action: { type: fix_and_retry }
  fields:
    - path: cigarId
      message: >-
        This cigar is held: 3 purchase lots (23 sticks). Excluding it would hide
        inventory from its owner — rename or merge it instead.
```

**Enforced, not advised, and there is no override.** An excluded cigar leaves every
catalog read, so excluding one somebody bought hides their inventory with nothing
on screen to explain it (#169). Any lot blocks, not just lots with stock left — a
fully-smoked lot is still a journal entry's provenance. `heldLots` is on the
worklist precisely so this is anticipable: skip the row rather than call and be
refused. `mergeCigars` refuses an excluded **target** for the same reason (merge is
console-only; there is no merge tool here), so lots cannot be re-pointed onto a
hidden survivor instead. `fix_and_retry` here means fixing the world, not the
arguments: remove the lots, rename the entry, or merge it into the right one.

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
      triedVendors: [Fox Cigar]   # on `exhausted` / `vendor_unreachable`: who spent themselves here
  replayed: false
```

`enrichedMarkets` and `eligibleVendors` answer different questions and are both
reported. A market is **enriched** when some crawl-enabled vendor covering it has
completed an `enrich` run — that is the enqueue gate, and the same liveness the
exhaustion denominator uses, read as markets rather than as vendors. A vendor is
**eligible** when it is crawl-enabled and its focus covers the row's market: who
COULD look. Eligibility is NOT the denominator — `crawl_enabled` is a registry
flag no crawler consults, so a vendor with a suspended enrich CronJob is listed
in `eligibleVendors` and counts against nothing. Read the two together: a vendor
named there whose market is missing from `enrichedMarkets` is a lane that has
never run.

The per-row `status` is `request_cigar_enrichment`'s taxonomy (`queued`,
`already_queued`, `recently_enriched`, `not_needed`) plus four verdicts only a
bulk press has:

| status | meaning | how to clear it |
| --- | --- | --- |
| `exhausted` | **every lane that runs** spent its own budget on this row (2 completed looks each) and none carried it; `triedVendors` names them | bring up a lane that stocks the brand — the row reopens on its own the night it runs — or press with `retryExhausted: true` |
| `vendor_unreachable` | every lane that runs is retired on this row, but at least one burned its error budget without finishing a look — nobody could look, so nothing was learned about any catalogue; `triedVendors` names them | fix the vendor (sitemap, adapter, product gate), then press with `retryExhausted: true` for a fresh error budget |
| `unverified_name` | nobody has reviewed this canonical name | `rename_cigar` if it is wrong, then `verify_cigar` |
| `no_vendor_coverage` | no crawl-enabled vendor covering that market has completed an `enrich` run | bring that market's enrich lane up |

**A vendor's catalogue is PARTIAL** (ADR-006 amendment 2026-08-30). "No match at
Fox" is evidence about Fox and about nothing else, so the budget is per
*(request, vendor)*: each lane gets its own two completed looks, and a request
retires only once all of them are spent. A request no lane counts against is NOT
exhausted — nobody could look, which is a different fact from "we looked and
found nothing" — and it reopens by itself the moment a lane runs, with no reopen
call and no `retryExhausted` press.

**Both preconditions are enforced, not advised, and neither has an override.** A
queued request that cannot be served is not inert: every drain that looks and
misses spends one of that vendor's two attempts. Enrichment resolves by canonical
name (slug-token ranking, then a pg_trgm similarity floor), which is why an
unreviewed name is refused; and an untyped cigar needs BOTH markets covered,
because enrichment is what would tell us which one it belongs to.

### register_taxonomy — write, idempotent

Find or mint the registry path a catalog entry needs: a brand, the line under it,
the blend under that (ADR-012 Wave 3). **Finding and minting are the same call.**
Structuring a brand top-down means naming the same line for the fifty-two Arturo
Fuente rows beneath it; a create-only verb would make fifty-one of those calls
errors, and an agent that learns to ignore "already exists" is one that ignores
the collision refusal too. `created` says which happened at each level.

```yaml
arguments:
  clientRequestId: 9f2c...        # required; reuse EXACTLY on a retry
  brandId: br_01j9x2              # the marca by id, from a queue row
  brand:                          # ...or by name. Exactly one of the two
    name: Padrón
    aliases: [Padron]             # other SPELLINGS, not slugs
  line:
    name: 1964 Anniversary Series
  blend:
    name: Maduro
    wrapper: Nicaraguan Maduro    # omit any fact not known — never invent one
    blenders: [José Orlando Padrón]
  runId: wo-cigar-curate-20260831
  confidence: 0.9

result:
  brand: { id: br_01j9x2, name: Padrón, slug: padr-n, aliases: [padr-n, padron], created: false }
  line:  { id: ln_01j9x3, name: 1964 Anniversary Series, slug: 1964-anniversary-series, aliases: [...], created: true }
  blend: { id: bl_01j9x4, name: Maduro, slug: maduro, aliases: [maduro], created: true }
  blenders:
    - id: bd_01j9x5
      name: José Orlando Padrón
      created: true               # this call minted the blender
      credited: true              # false when the credit already existed
  replayed: false
```

**Aliases are spellings, not keys.** Every entry is folded server-side into the
matching key the resolver probes for (`Padrón` → `padron`). A caller that passed a
pre-slugged string would be guessing at a normalization it cannot see, and a
display spelling written into a key column is an alias nothing ever probes for —
a silent failure rather than a loud one.

**A refused key is a near-duplicate caught.** An alias already claimed by another
entity at the same level is refused, naming the holder:

```yaml
error:
  code: validation_error
  recoverable: true
  action: { type: fix_and_retry }
  fields:
    - path: aliases
      message: "The matching key 'padron' is already claimed by 'Padrón'."
```

That is the guard that makes minting a brand safe. `brands.slug` is unique but
does not fold accents, so `Padron` and `Padrón` slug differently and the unique
index would admit both; their folded keys are identical, so the second is refused
and the curator is told which marca already exists. **Use the entity named — do
not work around the refusal.**

Scoping differs by level and it is deliberate: brand and blender keys are unique
globally, a line's within its brand, a blend's within its line. Two marcas may
each own a `reserva` and neither has to yield the name. `blend` requires `line`,
and naming the marca twice (or not at all) is a `validation_error`. Scope
`curation:write`, admin only.

### update_registry_aliases — write, idempotent

Add or drop the spellings one registry entity answers to. **This is the tool that
closes a `no_anchor` listing:** the vendor's title named the marca a way the
registry does not know, and the fix is that spelling as a key — never a looser
matcher. Loosening the match is how a flat namespace grew a parallel catalogue per
vendor (ADR-012).

```yaml
arguments:
  clientRequestId: 9f2c...
  level: brand                    # brand | line | blend | blender
  id: br_01j9x2
  add: ["RYJ", "Romeo y Julieta"] # spellings; folded to keys server-side
  remove: ["romeo"]               # too short to anchor safely — drop it
  runId: wo-cigar-curate-20260831
  confidence: 0.9

result:
  level: brand
  id: br_01j9x2
  name: Romeo y Julieta
  aliases: [romeo-y-julieta, ryj]  # the full key set after the edit
  added: [ryj]
  removed: [romeo]                 # each reports only what actually moved
  replayed: false
```

**Target-state over a set, with an envelope.** Adding a key already held and
removing one already absent are both no-ops rather than errors — the lists report
what moved — but the tool still carries a `clientRequestId`, because unlike
`set_want` the *set* it is editing is shared: two concurrent calls adding
different keys are two different intents, not one desired end state.

Two removals are refused, and both protect findability rather than tidiness:

| refusal | why |
| --- | --- |
| the key derived from the entity's own name | it is how the anchor reaches the row by its own name; dropping it leaves an entity that exists and cannot be found. Rename it with `rename_registry_entity` instead — a different, audited act |
| the last remaining key | an empty alias array is a row no probe can ever return |

Scope `curation:write`, admin only.

### rename_registry_entity — write, idempotent

Correct the spelling a registry entity is **displayed** under. The registry shipped
with marcas spelled for a keyboard rather than for a reader — `H Upmann`,
`Partagas`, `Por Larranaga` — and until this verb there was no audited path to fix
one: `register_taxonomy` mints, `update_registry_aliases` edits keys, and
`assign_cigar_taxonomy` moves leaves. None of them touches `name`.

```yaml
arguments:
  clientRequestId: 9f2c...
  level: brand                    # brand | line | blend | blender
  id: br_01j9x2
  name: H. Upmann                 # the corrected DISPLAY spelling
  runId: wo-cigar-curate-20260901
  confidence: 0.97

result:
  level: brand
  id: br_01j9x2
  name: H. Upmann
  previousName: H Upmann
  slug: h-upmann                  # unchanged — reported precisely because it did not move
  aliases: [h-upmann]             # the key set after the rename
  addedKeys: []                   # the fold is identical, so nothing was claimed
  changed: true                   # false when the name already read that way
  recomposedCigars: 4             # composed leaves whose canonical name followed
  replayed: false
```

**The name moves and, as far as possible, nothing else does.** Two things a rename
must not break, and neither of them does:

| stays put | why |
| --- | --- |
| the `slug` | it is a published address — today's brand URL and `brand_images.brand_slug` resolve through it — so re-minting it from the new name would break live links in order to add an accent. Slug renames with redirects are a separate, later act |
| every matching key the entity already holds | those are what vendor titles are probed against, and a vendor writing `Por Larranaga` is exactly the traffic the key exists to catch. Dropping it because the display name grew a tilde would unmatch the listings the rename is meant to make readable |

**The new spelling becomes a key only when it folds to one the entity does not
already answer to.** Six of the seven marcas in the display sweep fold identically
before and after (`fold` drops combining marks, so `Partagás` and `Partagas` are
one key) and claim nothing. `Rafael Gonzales` → `Rafael González` is the exception:
`s` → `z` is not a combining mark, so `rafael-gonzalez` is **added** beside the
`rafael-gonzales` the row keeps. That claim goes through the same collision rail as
a mint — a key another entity at the same level holds is refused, naming the holder,
which is a near-duplicate caught.

**Composed names follow.** A registry name is a name part, so every catalog entry
under the renamed level whose `nameSource` is `composed` is recomposed in the same
transaction and `recomposedCigars` counts the ones that moved. A `freeform` entry is
left alone — that string is the owner's. Renaming a blender recomposes nothing: no
cigar's name is composed from it.

Renaming an entity to the name it already carries writes nothing, records no audit
row, and reports `changed: false`. Scope `curation:write`, admin only.

### assign_cigar_taxonomy — write, idempotent

Place a catalog entry in the taxonomy and set the parts that live on the leaf.
**The one authorized path to `lineId`/`blendId`**, and therefore the one place the
ancestry rule has real work to do.

```yaml
arguments:
  clientRequestId: 9f2c...
  cigarId: cg_01j9x2
  brand: Padrón                   # the spelling; brandId is re-derived from it
  brandId: br_01j9x2              # ...or the id. Never both
  lineId: ln_01j9x3               # null clears; omitted leaves untouched
  blendId: bl_01j9x4
  vitolaName: Exclusivo
  edition: null
  nameSource: composed            # freeform | composed
  preview: false                  # true validates and computes, writes nothing
  runId: wo-cigar-curate-20260831
  confidence: 0.9

result:
  cigarId: cg_01j9x2
  canonicalName: Padrón 1964 Anniversary Series Maduro Exclusivo
  composedName: Padrón 1964 Anniversary Series Maduro Exclusivo
  nameSource: composed
  changedFields: [lineId, blendId, vitolaName, nameSource]
  preview: false
  replayed: false
```

**`composedName` is always reported, whatever `nameSource` says.** On a `freeform`
row it is the name the entry *would* take, which is the whole question a curator
asks before flipping it.

**The preview is a dry run of this exact call.** It loads the same row, applies the
same overlay, runs the same ancestry assertion and composes through the same
function — then returns instead of writing. So a refusal shows up on the preview
too, which is the point: a dry run that answered only the easy half ("what would it
be called?") and hid the half that rejects the write is worse than none. A preview
writes nothing and records no idempotency key, so **the same `clientRequestId`
commits what was just previewed.**

**Ancestry is checked against the row that would result, not the fields supplied.**
Clearing `lineId` while leaving `blendId` in place describes an inconsistent cigar
even though it named one level. A line must belong to the brand and a blend to the
line; a violation is a `validation_error` whose `path` names the level at fault:

```yaml
fields:
  - path: lineId
    message: The line belongs to a different brand than the cigar.
```

**Setting the marca by name re-derives the link.** `cigars.brandId` is a
*projection* of the free-text `brand` (ADR-012), so writing the text recomputes the
link by the one rule every writer of that column shares. A spelling no brand
answers to yields a null link — an unlinked row is a worklist item, a wrongly
linked one is a silent error. Passing `brand` and `brandId` together is refused
rather than reconciled. Flipping to `composed` with no brand at all is refused: a
composition needs something to compose from. Scope `curation:write`, admin only.

### split_cigar — write, idempotent

Break a catalog entry that has been standing for several products into the leaves
it should have been, moving each product's vendor listings onto its own. The
collapse buckets this addresses run up to twelve listings on one row.

```yaml
arguments:
  clientRequestId: 9f2c...
  cigarId: cg_01j9x2              # the bucket
  splits:
    - listingIds: [lm_01, lm_02]  # must currently point at cigarId
      blendId: bl_maduro          # mint a leaf under the bucket's brand...
      vitolaName: Exclusivo
    - listingIds: [lm_03]
      targetCigarId: cg_01j9x9    # ...or move them onto an existing sibling
  runId: wo-cigar-curate-20260831
  confidence: 0.9

result:
  cigarId: cg_01j9x2
  splits:
    - cigarId: cg_01jab1
      canonicalName: Padrón 1964 Anniversary Series Maduro Exclusivo
      created: true
      listingIds: [lm_01, lm_02]
    - cigarId: cg_01j9x9
      canonicalName: Padrón 1964 Anniversary Series Natural Exclusivo
      created: false
      listingIds: [lm_03]
  remainingListings: 4            # listings still on the bucket
  replayed: false
```

**Composed where composition works; one new verb where it did not.** Every
registry row a split needs comes from `register_taxonomy`, and any leaf it does not
mint is one `assign_cigar_taxonomy` already structured. What could not be composed
is the last step: `set_listing_match_status` confirms or clears the link a row
already has and has **no way to give it a different cigar** — the resolution verb
the triage read has documented as deferred since #170. This is that verb, bounded
to the split case, where the destination is a sibling of the row the listing is
already on and the evidence is the listing itself.

**Conservative by construction.** Listings you do not name stay where they are, so
`remainingListings` above zero is the expected outcome, not a failure. Split only
on unambiguous listing evidence; a bucket half-dispersed on good evidence is a
better catalog than one fully dispersed on guesses.

**A minted leaf inherits the bucket's structure; an omitted level is not a
cleared one.** Splitting by vitola says nothing about the line, so a `lineId` or
`blendId` you leave out is taken from the entry being split — carving `Torpedo`
out of `Padrón 1964 Anniversary Series` yields `Padrón 1964 Anniversary Series
Torpedo`, not `Padrón Torpedo`. This is the same omitted-vs-null distinction
`assign_cigar_taxonomy` draws: send an explicit `null` to say the leaf genuinely
has no line. A leaf that came out less structured than its bucket would be a
fresh worklist item minted by the tool meant to clear them.

**Minting is get-or-create, like `register_taxonomy`.** An arm whose composed
identity already names a live entry — by its folded name, or by the same
`{brandId, lineId, blendId, vitolaName, edition}` — re-points onto that entry and
reports `created: false` rather than minting a second one. Two arms naming the
same product in one call collapse onto one leaf for the same reason. The
duplicates this prevents are the hardest kind to find: same marca, same parts,
same name, differing only in id.

Refusals, each refusing the whole call rather than half-applying it:

| refusal | why |
| --- | --- |
| a listing that does not point at `cigarId` | a split re-points its own listings; anything else is a different operation |
| a listing whose `decidedBy` is `curator`/`agent`, or whose status is `confirmed` | somebody already ruled on that link (ADR-006, migration 0017). Bulk evidence work does not overturn a settled verdict — the message names who decided it |
| the same listing id in two splits | a listing names one product |
| a new leaf with no line, blend, vitola or edition of its own | it would be the same product under a second id — the duplicate this wave exists to end, created by the tool meant to prevent it |
| `targetCigarId` alongside any mint part | two instructions in one arm. Both-or-neither, the same rule `assign_cigar_taxonomy` applies to `brand`/`brandId` — an existing sibling already has its parts |
| a `targetCigarId` under a different marca, or where either entry has no `brandId` | the destination is a **sibling**, which is what bounds this to the split case. Unbounded it is a general "move these listings anywhere" verb wearing a split's name. An unbranded row is not a sibling of everything; it is a row whose marca nobody has established yet |
| a minted leaf with no marca to compose from | `Robusto` is a size every marca sells, not a cigar — a leaf named for one is a worse collapse bucket than the row being split. Name it yourself with `canonicalName` and the leaf is `freeform`, which is a curator taking responsibility for the string |
| an arm whose parts compose to the entry being split | re-pointing the bucket's listings at the bucket is a no-op reported as a leaf that was never made |
| parts that name more than one live entry | the duplicates are named; merge them, or pick one with `targetCigarId` |

**Audited and reversible.** Each re-point is audited as `listing_match.set_status`
with the bucket in `before`, which is the action the review console's Undo already
inverts — so a wrong split is walked back listing by listing with no new undo path.
The undo is a **true inverse**: it restores the decider and the resolver's
`suggestedParse`/`unmatchedReason` alongside the cigar and status, so an undone
listing splits again cleanly. Restoring only the cigar and status handed the
listing back stamped `confirmed` by a curator, which the settled-link refusal
above then reads as somebody's verdict — leaving the bucket unsplittable by the
tool that mis-split it.
A leaf minted in error is merged back into the bucket through the existing merge
ledger, which carries its listings home with it (ADR-012: "reversible via the
existing merge/unmerge ledger"). Merges themselves stay human-only in the console;
there is still no merge tool here.

**A split moves listings and nothing else.** Purchase lots and smokes stay on the
row they were logged against — re-attributing somebody's journal entry to a leaf
they never chose is a claim about their memory, not about the catalog. A bucket
that carries history is still the row where a split matters most and a mistake is
least recoverable, so the `cigar.split` audit row carries `heldLots` and `smokes`:
a reviewer can see which splits touched the owner's own history without joining
anything.

A minted leaf is `unverified` on purpose: the curator asserted its **structure**,
which is a different claim from having reviewed the finished entry. Scope
`curation:write`, admin only.

### Working a collapse bucket end to end

The flow the three verbs compose, on a `match_triage` row reported `ambiguous`:

`get_curation_queue` → `register_taxonomy` → `assign_cigar_taxonomy` →
`split_cigar`

1. `get_curation_queue kind: match_triage` returns the ambiguous row; its
   `suggestedParse` names the blend and vitola the title actually carried, and its
   `cigar` is the bucket every candidate collapsed into.
2. `register_taxonomy` finds or mints the line and blend that parse names, under
   the bucket's brand. Repeat per distinct product — it is get-or-create, so the
   second call for a shared line finds the first one's row.
3. `assign_cigar_taxonomy` structures the **bucket itself** onto whichever product
   it should keep, so the row that survives is a leaf rather than a family.
4. `split_cigar` moves the other products' listings onto their own leaves, minting
   each from the ids step 2 returned.

Steps 2-4 are separately idempotent, so a lane interrupted between them resumes by
repeating the step it was on. Do not skip step 3: a bucket left unstructured keeps
matching new listings for every product it used to serve, and the next crawl
rebuilds the bucket the split just took apart.

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
| `purchase_not_found` | no | none — the lot is not the caller's or never existed; re-query `get_my_inventory` |
| `photo_drop_not_found` | no | none — the drop is not the caller's or never existed; `open_photo_drop` returns the user's open drop |
| `version_conflict` | yes | `retrieve_latest_and_retry` via `get_smoke` |
| `idempotency_conflict` | no | new `clientRequestId` for a genuinely new intent |
| `unavailable` | yes | retry once with the same envelope, then tell the user; the fallback below preserves the entry |

Idempotent replay is not an error: same envelope returns the original result
with `replayed: true`.

**In `record_purchase_batch` these payloads arrive per item**, on the line that
raised them, not as the call's own error result — one item's `cigar_ambiguous`
or `validation_error` never fails the batch, and a `validation_error`'s
`fields[].path` is rewritten to `items[i].<field>`. The call errors only for a
failure of the whole batch: an unauthorized token, a malformed or colliding
envelope, a conflicting batch `clientRequestId`.

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
