# ADR-012: Structured catalog taxonomy — brand, line, blend, vitola

- **Status:** accepted
- **Date:** 2026-08-31
- **Amended by ADR-017 (2026-09-03):** a leaf with `vitola_name NULL` is a
  family row — never retyped; a stated vitola specializes it into a sibling
  leaf.

## Context

The owner's organizing principle for the catalog, stated 2026-08-30: cigars are
sold as **Brand → Line → Blend → Vitola** (Drew Estate → Liga Privada → No. 9 →
Toro), and the catalog must be organized that way, with users free to slice,
sort, and filter the resulting views.

The current model cannot express this. Identity is one flat string
(`cigars.canonical_name`); `brand`/`line`/`vitola_name` are unvalidated
free-text decoration with no registry behind them. Production fill rates
(2026-08-30, n=971 active): brand 41% (59% NULL), line 3 rows, vitola 5%,
edition 0. There is no blend concept at all — no column, no table.

Measured failures of the flat model, from tonight's audit:

- **Collapse buckets.** `Padron 1964 Anniversary Natural` is one row holding 12
  vendor listings spanning eleven distinct vitolas plus a different marca;
  `product_photos` is `UNIQUE(cigar_id)`, so one photo and one price band serve
  all of them. `Tatuaje Skinny Monsters Chuck` holds all eight Monsters.
- **The matcher is confidently wrong at scale.** 42% of auto-matches disagree
  with the vendor's own slug; 11.5% have a vitola or wrapper token on one side
  and not the other (`Oliva Serie O Maduro Robusto` ~> `oliva-serie-o-robusto`).
- **Trigram similarity inverts the signal.** The two highest-scoring "duplicate"
  pairs in the whole catalog are `Davidoff Signature` vs `Signature 2000` and
  `Liga Privada No. 9` vs `T52` — different products — while true sibling
  vitolas score below 0.5. `cigar_merges` has 0 rows: nobody can find the real
  duplicates.
- **Every new vendor mints a parallel catalog.** Titles are the only key, and
  vendors title differently: Cuban Lou's minted 56 new rows over ground Fox
  already covered. Two of eight vendors have crawled; enabling the rest
  multiplies a 977-row flat namespace by roughly an order of magnitude.

`docs/ddd/contexts-and-aggregates.md` currently rules the opposite way ("Real
cigar naming resists a Brand → Line → Vitola hierarchy, and no field may be
invented to satisfy taxonomy"). That ruling conflated two claims. *Do not
fabricate unknown facts* stands. *Known facts need no structure* does not — the
facts are already in the data, crammed into one string where neither the
matcher nor the UI can use them.

## Decision

**The leaf stays `cigars`, redefined as: one blend in one vitola — the thing
you light.** All thirteen FK-bearing tables (smokes, purchases, wants,
favorites, listing_matches, product_photos, …) keep pointing at `cigars.id`.

**Three reference entities above the leaf**, each with canonical name, stable
slug, and an alias list:

| entity | parent | carries |
|---|---|---|
| `brands` | — | country, website, imagery (absorbs `brand_images`), aliases (`Padrón`/`Padron`, `RYJ`) |
| `lines` | `brands` | description, aliases (`Liga Privada`, `Acid`, `1964 Anniversary Series`, `FFOX`/`Fuente Fuente OpusX`) |
| `blends` | `lines` | wrapper/binder/filler, strength, blend notes, marketing photo, aliases (`No. 9`, `T52`, `Maduro`, `Natural`) |
| `blenders` | — | the person or team credited with the blend, aliases; joined to `blends` via `blend_blenders` (collaborations exist, and a blender's work spans brands) |

**Filler, binder, and wrapper tobacco are a required documentation target on
every blend** (owner ruling 2026-08-31): they are the data that lets similar
blends correlate to similar tasting notes. Required-target means enrichment
pursues them and a curation worklist tracks the gaps — never that a value is
invented. Cuban blends typically credit no individual blender; that field
stays NULL and blender-level views roll up NC-side only.

The leaf carries `brand_id`, `line_id`, `blend_id` (all nullable FKs, ancestry
consistency enforced), plus `vitola_name` (normalized text), `length_inches`,
`ring_gauge`, `edition`. **There is no global vitolas table** — a vitola is a
size label within a blend, not an entity. Wrapper variants marketed as separate
products (Padron Maduro/Natural) are distinct blends, because that is how they
are sold.

**Every level is nullable; nothing is invented.** A cigar with unknown line
hangs directly off its brand; unknown stays NULL. Structure stores known facts
in the right shape — it never fabricates them. This supersedes the contrary
sentences in `docs/ddd/contexts-and-aggregates.md:47-55`,
`docs/ddd/ubiquitous-language.md:10`, `docs/prd/002:R-CAT-2`, and
`docs/flows/002-cigar-resolution.md:20-22`; the "no invented facts" house rule
itself is reaffirmed.

**`canonical_name` becomes a maintained projection.** A new `name_source`
column distinguishes `freeform` (today's rows — the string remains
authoritative) from `composed` (structured rows — the name is recomposed from
brand + line + blend + vitola + edition, and `renameCigar` becomes an edit of
the parts). Search, MCP contracts, and history keep working over the projection
throughout the transition.

**Packaging is never identity** (folds in #164): pack/bundle/tubo/N-ct listings
attach to the base leaf cigar and their packaging facts live on the offer,
where `parsePackaging` already puts them. Existing packaging-SKU catalog rows
are merged into their base rows where one exists, else stripped and renamed —
this supersedes the 44-row exclusion batch in
`.agents/reference/catalog-exclusions.md` (merge beats exclude: history and
offers re-point instead of hiding).

**Matching v2 replaces trigram-first.** Listing resolution anchors on a brand
alias, then resolves line and blend by alias within that brand, then vitola and
packaging by token, with trigram demoted to ranking residue within the resolved
scope. The crawler persists `categoryPath` breadcrumbs (currently parsed and
discarded — the one structured taxonomy signal vendors give us) as parse
evidence. Seed mode never mints a catalog row from an unparsed title again:
no brand anchor → triage with the suggested parse attached. The
`numbersCompatible`/`packagingCompatible` string heuristics retire once
structural comparison covers their cases.

**The matching vocabulary lives in code, and the code is the authority.**
Deciding whether a name word is a size, a container, a wrapper, an alternative
spelling of one of those, or the product's own identity is a matching rule, and
it is exercised on every listing and every described cigar. Four sets exported
from `@cj/domain` are that decision, and nothing else is:

| set | answers |
|---|---|
| `VITOLA_TOKENS` (`catalog-parse.ts`) | is this word a size? — derived from `VITOLA_TERMS`, including the modifiers (`petit`, `gran`, `double`, `short`, `extra`) that multi-word entries split into |
| `PACKAGING_TOKEN_LABELS` (`catalog-parse.ts`) | is this word a container, and what does an offer record it as? |
| `VARIANT_TOKENS` (`name-heuristics.ts`) | is this word a wrapper or shade a brand sells as a separate product? |
| `SPELLING_VARIANTS` (`name-heuristics.ts`) | is this word another spelling of one of the above, or of an identity word? |

`docs/ddd/cigar-industry-vocabulary.md` remains the reference for what the trade
terms MEAN and which level they map to; it does not enumerate the tokens and is
not expected to. Duplicating these tables into prose would produce two
vocabularies that drift, which is the failure `PACKAGING_TOKEN_LABELS` was
consolidated to end — a term strippable by one pass and unrecorded by the other.
A word gains or loses vocabulary status by editing the set and the tests that
pin it (issue #237).

**Gate:** no new vendor is enabled (2 Guys, Small Batch) before matching v2 and
the packaging fold land. Re-probes may proceed; enabling waits. Expanding the
crawl first would pour thousands of listings through the matcher this ADR
retires.

## Consequences

- Navigation and slicing become structural: brand page → lines → blends →
  vitola chips; facets and group-by over real keys instead of string prefixes.
  The UI treatment needs a DESIGN-004 before the web wave builds.
- Dedup becomes structural: siblings share `(blend_id)`; cross-vendor identity
  stops depending on title spelling; `getBrand`'s O(n) slug scan dies.
- Blend-level facts and photos get one home instead of being duplicated or
  dropped; `product_photos UNIQUE(cigar_id)` stops being a collision surface
  for eleven products.
- The backfill is real curation work: 565 unbranded rows, collapse-bucket
  splits that re-attribute listing matches — and, for a handful of rows, the
  owner's own purchase and smoke history. Splits are audited, conservative
  (only on unambiguous listing evidence), and reversible via the existing
  merge/unmerge ledger.
- All four identity write paths (MCP described-cigar, crawler seed, importer,
  curation) and the browse/search/MCP read surfaces change. Sequenced in
  waves; the durable plan is backlog issue #196, with migration
  numbers pre-assigned from **0026** (0025 is claimed by held PR #192).
- ADR-006's listing-matching clause ("normalized canonical name … + trigram")
  is amended by this ADR.
- ADR-013 builds on this structure: external review observations and
  critic/journal aggregates at blend, rolled up line → brand → blender
  (backlog #199, gated on Waves 1–2 here).

## Alternatives considered

- **Keep flat, tune trigram thresholds** — the failure is inversion, not
  calibration: distinct blends outscore true siblings; no threshold fixes that.
- **Normalize into text columns only (no tables)** — no aliasing, so
  `Padrón`/`Padron` keep forking groups; no stable slugs for URLs/facets; no
  home for level facts; brand resolution stays a full-table scan.
- **Full product/variant split (new parent table takes the FKs)** — re-homes
  thirteen FK tables and breaks the MCP tool contract for the same navigation
  this design gets while keeping `cigars.id` stable.
- **Global vitolas table** — invents an entity where the industry has a
  per-blend size label; dims belong on the leaf.
- **Blend as text on the leaf** — no alias matching at exactly the level where
  string matching fails worst (No. 9 vs T52), and blend facts/photos would
  stay homeless or duplicated across vitolas.
