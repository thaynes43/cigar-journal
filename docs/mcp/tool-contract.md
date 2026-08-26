# MCP Tool Contract

Five tools over the application services. Schemas here are conceptual until
frozen in Phase 4; field semantics and error codes are normative. Governing
decisions: ADR-004 (auth), ADR-005 (integration).

## Principles

1. **The transcript never arrives.** Tool arguments contain only what the
   model synthesizes; design fields so a faithful synthesis is expressible.
2. **Unknown is valid.** Every field the user didn't state is omitted or
   null. A schema that forces the model to invent a value is a defect.
3. **No model-supplied identity.** The authenticated token determines the
   user; no tool accepts a user reference. Cigar ids come only from prior
   tool results, never invented.
4. **Verbatim + normalized.** Descriptors are kebab-case tags for analytics;
   the user's own words always travel alongside and are never rewritten.
5. **Errors are instructions.** Machine-readable code + `recoverable` +
   `suggestedAction`, so the model can self-correct or ask the user.
6. **Reads are frictionless, writes confirm.** Read tools carry
   `readOnlyHint: true` (no ChatGPT confirmation); the one confirmation on
   `save_smoke` is the user's last look before persisting.

Scopes: `catalog:read` (search_cigars, get_cigar), `journal:read`
(get_my_smokes), `journal:write` (save_smoke, update_smoke — including lazy
catalog create inside save).

---

## search_cigars — read

Resolve conversational cigar mentions to catalog entries. Use when a cigar is
named ("I'm smoking an Alma Fuego") or asked about. Not for browsing the
user's history (that's `get_my_smokes`).

```yaml
arguments:
  query: alma fuego            # free text; fuzzy (trigram) matching
  brand: Plasencia             # optional narrowing fields
  limit: 5                     # default 5, max 10

result:
  matches:
    - cigarId: cg_01j9x2
      brand: Plasencia
      line: Alma del Fuego
      vitola: Concepcion
      size: 6.0" x 52
      type: NC
      verification: verified
      userSmokeCount: 3        # this user's smokes of it — cheap context
  guidance: single_match       # single_match | multiple_matches | no_match
```

`multiple_matches`: ask the user naturally (vitola usually disambiguates).
`no_match`: proceed — `save_smoke` creates the cigar from described
attributes; do not retry search with invented details.

## get_cigar — read

Full catalog detail plus this user's personal profile for one resolved cigar.
Use for factual questions or comparisons once a `cigarId` is known.

```yaml
arguments:
  cigarId: cg_01j9x2

result:
  cigar:
    cigarId: cg_01j9x2
    brand: Plasencia
    line: Alma del Fuego
    vitola: Concepcion
    size: 6.0" x 52
    wrapper: Sun Grown Habano
    origin: Nicaragua
    type: NC
    verification: verified
  personalProfile:             # null if the user never smoked it
    smokeCount: 3
    recurringDescriptors: [citrus, baking-spice, earth]
    rating: { average: 87, min: 84, max: 91 }
    lastSmokedAt: "2026-07-30"
```

## get_my_smokes — read

Query the authenticated user's smoking history. Use for "what did I think
last time," "what have I called bready," "what did I smoke last month."

```yaml
arguments:                     # all optional; combine freely
  cigarId: cg_01j9x2
  brand: Davidoff
  descriptor: bready           # matches normalized descriptors
  text: sweeter than           # FTS over narrative + verbatim observations
  smokedAfter: "2026-07-01"
  smokedBefore: null
  minRating: null
  limit: 10                    # default 10, max 25; newest first

result:
  smokes:
    - smokeId: sm_01jab4
      cigar: { cigarId: cg_01j9x2, brand: Plasencia, line: Alma del Fuego, vitola: Concepcion }
      smokedAt: "2026-07-30T21:05:00-04:00"
      rating: 88
      summary: >
        Brighter than previous smokes; tangerine sweetness in the middle
        third, cream on the finish.
      descriptors: [tangerine, cream, cedar]
  totalMatches: 3
```

`summary` is a stored condensation, not the full narrative — responses stay
small. Fetch nothing more unless the user asks; the id can seed
`update_smoke`.

## save_smoke — write, idempotent

Persist one finished smoke. Call once, when the user indicates the smoke is
over — never per observation, never mid-smoke.

```yaml
arguments:
  clientRequestId: 9f41c9d2-6b7a-4c0e-a1e5-2f8f4f6f7a10   # generate once per
                                 # smoke; reuse EXACTLY on any retry
  cigar:                         # exactly one of:
    cigarId: cg_01j9x2           #   resolved id (preferred)
    described:                   #   or attributes when no match existed
      brand: Plasencia
      line: Alma del Fuego
      vitola: Concepcion
      size: null
      type: NC
  smokedAt: "2026-08-26T20:15:00-04:00"   # null if the user never said;
                                 # server records receivedAt regardless
  context:
    location: patio
    pairing: sparkling water
  progression:
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
    rating: 88                   # 0-100 ONLY if the user stated one
    impression: >
      Complex and easy to like; burn issues on this stick only.
  journal:
    title: Alma del Fuego Concepcion — patio evening
    narrative: |
      Full prose entry in the user's voice, preserving their words...

result:
  smoke:
    smokeId: sm_01jc8x
    version: 1
    url: https://cigars.haynesnetwork.com/smokes/sm_01jc8x
    cigar: { cigarId: cg_01j9x2, verification: verified }
  cigarCreated: false            # true when `described` created an
                                 # unverified catalog entry
  replayed: false
```

Rules: `progression` and `journal.narrative` are the only substantive
requirements — everything else may be null/omitted. Sparse is correct;
invented is a defect. If `described` matches an existing cigar strongly, the
server links instead of creating (`cigar_ambiguous` if it can't decide).

## update_smoke — write

Correct an existing smoke ("actually the Robusto", "change my rating to 9…
make that 90"). Field-scoped patch; only provided fields change. Use
`get_my_smokes` first if the `smokeId` isn't already known from this
conversation.

```yaml
arguments:
  smokeId: sm_01jc8x
  patch:
    assessment: { rating: 90 }
    cigar: { cigarId: cg_01j9x7 }        # re-point to the correct vitola
    appendProgression:                    # add, never rewrite, history
      - stage: final inch
        descriptors: [leather]
        verbatim: Draw tightened up right at the end.

result:
  smoke: { smokeId: sm_01jc8x, version: 2 }
  changedFields: [assessment.rating, cigar, progression]
```

Deletion is web-only. Imported Smokes accept patches to structured fields but
their original markdown is immutable.

---

## Errors

```yaml
error:
  code: cigar_ambiguous
  message: Multiple catalog cigars match "Atabey".
  recoverable: true
  suggestedAction: ask_user_to_choose
  candidates:
    - { cigarId: cg_01k2m1, brand: Atabey, line: Ritos, vitola: Ritos }
    - { cigarId: cg_01k2m2, brand: Atabey, line: Hechos, vitola: Hechos }
```

| code | recoverable | suggestedAction |
|---|---|---|
| `validation_error` | yes | fix listed `fieldErrors`, resend |
| `unauthenticated` | no | tell user to reconnect the connector |
| `unauthorized` | no | scope/ownership — do not retry |
| `cigar_not_found` | yes | use `search_cigars` or `described` |
| `cigar_ambiguous` | yes | ask_user_to_choose |
| `stale_version` | yes | re-read via `get_my_smokes`, re-patch |
| `unavailable` | yes | retry once, then tell the user; the fallback below preserves the entry |

Idempotent replay is not an error: same `clientRequestId` returns the
original result with `replayed: true`. No stack traces, no SQL, no internal
ids beyond the public ones.

## Fallback without write tools

If the client cannot call write tools, the model emits the exact `save_smoke`
`arguments` YAML as chat text; the site's import page accepts that payload
and executes the same application command with the same validation. One
schema, two doors.
