# Domain Model Examples

Conceptual YAML for the important structures, ahead of schema freeze. Nulls
are deliberate: the model favors accurate partial information over false
completeness. Nothing here obliges an implementation column-for-column.

## User and identities

```yaml
user:
  userId: us_01h2q7
  displayName: Tom
  journalVisibility: public          # private is the default
  role: admin
  identities:
    - { provider: local, email: manofoz@gmail.com }
    - { provider: authentik, subject: "ak-oidc|4f21..." }
  mcpGrants:
    - { client: chatgpt-web, scopes: [catalog:read, journal:read, journal:write], grantedAt: 2026-09-14 }
```

## Cigar — well-known product with blend data

```yaml
cigar:
  cigarId: cg_01j9x2
  canonicalName: Plasencia Alma del Fuego Concepcion   # required, human-facing
  brand: Plasencia                                     # recommended
  line: Alma del Fuego                                 # optional
  edition: null
  vitola: { name: Concepcion, lengthInches: 6.0, ringGauge: 52 }
  type: NC
  manufacturer: { name: Plasencia, factory: null }
  productionCountry: Nicaragua
  tobacco:
    wrapper: { country: Nicaragua, region: Ometepe, varietal: null }
    binder:  { country: Nicaragua, region: null, varietal: null }
    filler:
      - { country: Nicaragua, region: Ometepe, varietal: null }
      - { country: Nicaragua, region: Jalapa, varietal: null }
  blendNotes: null                   # official description, when known
  releaseYear: null
  verification: verified
```

## Cigar — taxonomy-resistant, lazy-created mid-conversation

No line exists and none is invented; `canonicalName` is the identity.

```yaml
cigar:
  cigarId: cg_01k2m1
  canonicalName: Atabey Divinos
  brand: Atabey
  line: null
  edition: null
  vitola: { name: Divinos, lengthInches: null, ringGauge: null }
  type: CC
  manufacturer: null
  productionCountry: null
  tobacco: null
  verification: unverified           # curation queue picks it up
```

## Smoke — fully populated (live conversational save)

```yaml
smoke:
  smokeId: sm_01jc8x
  version: 1
  cigar: { cigarId: cg_01j9x2, canonicalName: Plasencia Alma del Fuego Concepcion }
  smokedAt:
    value: 2026-08-26T21:47:12-04:00
    source: system-finalized         # user never stated a time; server
    precision: approximate           # stamped finalization — not hallucination
  context: { location: patio, pairing: [sparkling-water] }
  overallDescriptors: [spice, cream, citrus, earth]
  progression:
    - stage: opening
      approximatePosition: 0.05
      descriptors: [spice]
      verbatim: Spice was immediate but never especially intense.
    - stage: middle
      approximatePosition: 0.50
      descriptors: [cream, citrus]
      specificDescriptors: [tangerine]
      verbatim: >
        Smoother now, with a bright fruit sweetness closer to tangerine
        than dark fruit.
    - stage: finish
      approximatePosition: 0.90
      descriptors: [earth, toasted-bread]
      verbatim: Warmer and more savory at the end.
  construction: { draw: excellent, burn: good, smokeOutput: high, notes: null }
  assessment:
    strength: medium-full
    body: full
    liked: true
    rating: null                     # user never gave a number — stays null
    impression: Complex and easy to like; a great NC after a CC stretch.
  journal:
    title: Alma del Fuego Concepcion — patio evening
    narrative: |
      Prose in the user's voice, preserving their words...
  provenance: { source: llm-conversation, client: chatgpt-web }
```

## Smoke — sparse but valid

"Smoked a Davidoff 2000. Creamy, bready, excellent draw. Really liked it."

```yaml
smoke:
  smokeId: sm_01jd44
  version: 1
  cigar: { cigarId: cg_01j711, canonicalName: Davidoff Signature 2000 }
  smokedAt: { value: 2026-08-27T18:03:55-04:00, source: system-finalized, precision: approximate }
  overallDescriptors: [cream, bread]
  progression: []                    # nothing invented
  construction: { draw: excellent }
  assessment: { liked: true, rating: null }
  journal: null
  provenance: { source: llm-conversation, client: claude-code }
```

## Smoke — imported historical entry

```yaml
smoke:
  smokeId: sm_01hxk2
  version: 1
  cigar: { cigarId: cg_01j5aa, canonicalName: God of Fire Serie B }
  smokedAt: { value: 2025-11-16, source: legacy-document, precision: day }
  overallDescriptors: []             # importer does not synthesize
  progression: []
  assessment: { rating: 82 }         # from the brand-index table
  journal:
    title: Series B 11/16
    narrative: null                  # prose lives in originalJournal
  originalJournal:
    markdown: |
      ## Review 1 - Double Robusto - 11/16/2025
      Well constructed and easy to like expensive stick...
  provenance:
    source: legacy-import
    originalPath: archive/docs/nc-reviews/god-of-fire/series-b.md
    importedAt: 2026-10-01T12:00:00Z
```

## Purchase and market data

```yaml
purchase:
  purchaseId: pu_01k9d0
  cigar: { cigarId: cg_01j2b8, canonicalName: Ramon Allones Specially Selected }
  purchasedAt: 2025-10-14
  quantity: 25
  packaging: box
  boxDate: 2025-02-01
  humidorAt: 2025-10-16
  pricePerStick: 1.12
  vendor: { vendorId: vn_01a1, name: "..." }

offer:                               # append-only crawl observation
  vendor: { vendorId: vn_01a1 }
  listingUrl: https://vendor.example/liga-privada-no-9-toro
  seenAt: 2026-09-03T04:10:00Z
  price: 15.49
  currency: USD
  inStock: true
  match: { cigarId: cg_01j0f2, status: auto }   # auto | confirmed | unmatched
```
