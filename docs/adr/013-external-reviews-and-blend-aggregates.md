# ADR-013: External reviews, blend aggregates, and reviewer sources

- **Status:** accepted
- **Date:** 2026-08-31

## Context

Owner ruling, 2026-08-31: a personal review scores **one cigar experience** —
a dud stick of a beloved blend scores low, and that divergence is signal, not
noise. Separately, the catalog should carry review scores from the wider world
— crawled from reviewer sites and looked up by agents during enrichment — and
present a Rotten-Tomatoes-style aggregate for the whole blend, propagating up
the taxonomy so lines, brands, and blenders can be compared.

Today none of this exists: ratings live only on `smokes`, there is no external
review concept, and the crawler knows only vendors (ADR-006). And with the
flat catalog, a single smoke's rating currently decorates collapse-bucket rows
serving up to a dozen distinct products — the exact misrepresentation the
owner is ruling against. This ADR depends on ADR-012: blend identity must
exist before anything can aggregate at the blend.

## Decision

**1. A journal rating is a property of one smoke of one leaf cigar.** No
surface may present a single smoke's score as the score of a blend, line, or
brand. Per-cigar and higher-level numbers are always aggregates, always
labeled with their population and sample count.

**2. External reviews are ingested as `review_observations`** — the ADR-009
price-observation pattern applied to reviews: source, URL, reviewer/author,
score with its native scale (normalized to 0–100), review date, optional short
excerpt, and target linkage at the most specific level the source states (leaf
cigar preferred, blend fallback). Idempotent on `(source, url)`; provenance
kept. **Scores, links, and short excerpts only — never full review text**:
reviewer content is copyrighted, and the aggregate is our product, not their
prose.

**3. Two aggregates, never mixed** (the Rotten Tomatoes model): a **critic
score** over external observations and a **journal score** over users' smoke
ratings. Both compute at the blend and roll up line → brand → blender by
aggregating the underlying observations — no averages of averages. Roll-ups
render only with their sample counts; a blend with two data points looks like
what it is.

Amended 2026-08-31 (owner ruling): the journal population aggregates one voice
per journal — each user's ratings of the target average first, and the sample
count is journals, not smokes. A prolific logger counts once; every individual
smoke review remains fully visible on its own surfaces.

**4. Sources get a kind.** The crawl registry distinguishes `vendor`
(listings + offers), `reviewer` (review observations — halfwheel first), and
`reference` (specs and imagery — Habanos S.A. materials, Wikidata). Reviewer
and reference crawls inherit ADR-006 discipline: robots, probes, budgets,
per-source gates — plus egress allowlist additions through GitOps before any
fetch can succeed.

**5. The domain speaks the industry's language, both hemispheres.** Cuban:
marca, vitola de galera vs vitola de salida, Edición Limitada, Regional
Edition, Añejados; institutional blending credited to the marca, not a person.
Non-Cuban: master blender and factory culture, wrapper varietals (Corojo '99,
Criollo '98, Connecticut Broadleaf vs Shade, San Andrés). A vocabulary
reference lands in the taxonomy Wave 0 docs and binds enrichment agents,
curation, and UI copy.

## Consequences

- Schema and ingestion land **after** taxonomy Waves 1–2 (#196) — aggregation
  is meaningless without `blend_id`. Migration numbers pre-assigned from
  **0028**.
- Enrichment gains targets: filler/binder/wrapper, blender credit, and
  external scores; curation worklists gain missing-FBW and missing-blender
  kinds (ADR-012).
- UI and MCP surfaces show labeled critic/journal aggregates at cigar, blend,
  line, brand, and blender levels; sorts and facets can use them.
- New crawler adapters and egress entries per reviewer/reference source; each
  is its own gated enable, like vendors.
- Blender comparison is NC-territory by nature; Cuban roll-ups stop at the
  marca. The UI must not render an empty "blender" level for Habanos.

## Alternatives considered

- **One blended score per blend** — hides exactly the critic/user divergence
  the owner wants visible; RT's two-population model chosen instead.
- **Attach external reviews only at the leaf** — reviewers usually score one
  vitola but readers ask about the blend; most-specific linkage with blend
  fallback loses nothing and aggregates cleanly.
- **Store full review text** — copyright exposure for no product value beyond
  the score, link, and excerpt.
- **Roll up by averaging child averages** — over-weights sparse children;
  aggregates always recompute over raw observations.
