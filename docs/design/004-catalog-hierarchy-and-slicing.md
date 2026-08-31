# DESIGN-004: Catalog hierarchy and slicing

- **Status:** accepted
- **Date:** 2026-08-31
- **Builds on:** ADR-012 (the taxonomy), ADR-013 (score aggregates), DESIGN-003
  (the library catalog — grid, tiles, toolbar anatomy), PRD-002 R-CAT-2/R-CAT-5.
- **Method:** mechanics are ported from the haynesnetwork Library **source**
  (the owner's reference app), not re-derived from prose. Each ported mechanic
  cites its source below; each deliberate divergence says why.

The owner's organizing principle: the catalog reads the way cigars are sold —
**Brand → Line → Blend → Vitola** — and every view can be sliced, sorted, and
filtered. This document is the UI contract for #196 Wave 4.

## D-01 One surface; hierarchy state is URL state

`/cigars` is the only catalog surface. The four hierarchy levels are URL
params — `brand`, `line`, `blend`, `vitola`, each holding one slug — and a
**drill is nothing but setting one of them**. Filters, sort, and search
compose with drills by construction because they are all just params on the
same URL: shareable, Back/Forward-safe.

`/cigars/brands/[slug]` retires to a 307 redirect (`/cigars?brand=<slug>`);
its current behavior of dropping every active facet on entry is a defect this
design removes. `/cigars/[id]` stays the leaf detail route. The ledger view
and the three root shelves are unchanged.

## D-02 The view selector: grouping dimensions

The existing leftmost `.seg`-equivalent (`Segmented`, DESIGN-003) grows from
`All · Brands · Ledger` to:

```
All · Brands · Lines · Blends · Vitolas · Ledger
```

`All` = the flat leaf grid. `Brands/Lines/Blends/Vitolas` = grouped views
(`?by=brand|line|blend|vitola`) rendering **aggregate group cards**. `Ledger`
is untouched (`?view=ledger`). The legacy `?view=brands` canonicalizes to
`?by=brand` on load (replace, no history entry). Default stays `All` with
shelves at root. The selector row pans horizontally when crowded, never wraps
(port: `.library-chipbar` overflow idiom, app.css:1662-1700).

## D-03 Group screens are whole-screen swaps, not shelves

Port of the haynesnetwork grouping mechanic (library-client.tsx:1091,
group-card.tsx:46-66): a grouped view replaces the grid with **one grid of
group cards** — never section headers, never per-group sub-grids, never
collapsible shelves.

**Group card anatomy** (new component, sibling of `brand-poster-tile`):
- The catalog's 3:4 frame and grid geometry (`CATALOG_GRID` — deliberate
  divergence from haynesnetwork's 2:3: consistency inside this app wins).
- Art: a rotated cover-fan of up to three member product photos (port the
  `.group-card__cover--0/1/2` transform ladder, app.css:2047-2117); a themed
  glyph tile when no member has a photo, and always for the Vitolas dimension
  (abstract dimension — never fake art; hnet `WallGroupingArt` rule).
- Label = the group name. For `line`/`blend` groupings at root, a sub-label
  carries the parent (`Liga Privada` / `Drew Estate`) because line and blend
  names collide across brands.
- Subtitle = `N cigars`.
- Badges, same row/cap/tone grammar as the leaf tile (max 3): `N in humidor`
  (ok) · `N wanted` (warn). Absent when zero. Score badges arrive with
  ADR-013, labeled, never before.

## D-04 Drill: preserving push; dimension switch: clean push

Two history behaviors, ported exactly (library-client.tsx:287-298, :539-552,
:1091):

- **Dimension/view switch** (`by` or `view` change): a **clean PUSH** — active
  facets, sort, and search drop; the new shape starts fresh.
- **Drill in** (click a group card) and **drill out** (back header): a
  **preserving PUSH** — the click adds exactly one hierarchy param and, where
  the level below offers groupings, retargets `by` to that level's default;
  everything else on the URL survives. Back restores the group screen.
- **Refinements** (facet, sort, search): REPLACE, `scroll: false`, defaults
  omitted from the URL, invalid tokens read as absent.

A drilled screen opens with a drill header: back label (`All brands` /
parent's name), the entity name, and its cigar count. The drilled dimension's
own chip hides — the drill *is* that filter (port: books-browser.tsx:258-267).

Levels and their registry (port of the per-level `ViewLevelKey` idiom,
library-view-registry.ts):

| level | groupings offered (`by`) | default | sorts | chips offered |
|---|---|---|---|---|
| root | brand · line · blend · vitola | — (All) | leaf set | Brand, Line, Blend, Vitola + toggles |
| brand drill | line · blend | All | leaf set | Line, Blend, Vitola + toggles |
| line drill | blend | All | leaf set | Blend, Vitola + toggles |
| blend drill | — | All | leaf set | Vitola + toggles |
| any grouped view | — | — | Name (asc-first) · Count (desc-first) | none (group cards don't facet v1) |

Leaf sort set is unchanged (`name · my-rating · recently-added · price`) and
gains **direction**: the `field:dir` token, two-state pill cycle entering at
the registry's `firstDir` (`name` asc-first, the rest desc-first), with the
fixed-width arrow slot so the glyph never nudges neighbors (port:
sort-btn__arrow, app.css:1729-1735; DESIGN-003 already carried this as debt).
Brand-drill's default flips from `All` to `Lines` by one registry constant
once Wave 3 backfill makes lines meaningful — revisit then, not before.

Amended 2026-08-31: the drill-link mechanic is ported (card click → hierarchy
param push); the preserving behavior is this design's deliberate divergence
from library-client.tsx:1091, which builds its drill link clean. Preserving is
the point — see D-01's brand-route defect.

## D-05 Unfiled — the honest divergence

haynesnetwork skips null group keys entirely (books-query.ts:185-230: no
"Unknown" bucket). Ported as-is that mechanic would hide most of this catalog
(brand 41% filled, line 3 rows). **Divergence:** every grouped view appends
one trailing muted glyph card, label `Unfiled`, with its count, whenever the
null-key population is non-zero. It drills to the leaf grid scoped to that
gap (`line=unfiled` — a reserved slug meaning IS NULL at that level, beneath
any ancestor params). It renders last regardless of sort, and never when the
count is zero.

Unfiled is the catalog telling the truth during backfill and a standing
curation prompt — R-CAT-2's honest collapse, applied to grouping.

## D-06 Chips: the hierarchy as filters

Chips for `Brand`, `Line`, `Blend`, `Vitola` join the existing toggles. Each
is **single-select** and writes the same param a drill writes — chip and
drill are one mechanism with two entrances. Options are scoped by the levels
already set (the Line chip under `brand=drew-estate` offers only Drew Estate
lines) and carry counts computed against the *other* active facets. This
needs the catalog's first facet-options procedure
(`catalog.facetOptions`), replacing the Brand popover's unscoped
`catalog.brands` feed.

- Popover anatomy ports `FilterChip`: pill reads `Label · Value` with caret;
  ✕ clears only when non-empty; fixed-position popover with the
  viewport-clamping function (FilterChip.tsx:46-60) — bottom-start, 320px
  max, 390px-viewport-safe.
- Empty-option facets at the current scope **hide** (the books-wall rule —
  with our sparse data, explain-yourself chips would dominate the row; the
  hnet *arr rule is noted and not taken).
- `Clear all` (≥2 active chips) stays — a shipped DESIGN-003 addition
  haynesnetwork lacks; it earns its place because our chips are one-tap
  toggles.
- **Multi-select hierarchy filtering is deliberately not offered.** One value
  per level keeps chip and drill the same state and the drill header honest.
  The upgrade path, if wanted later, is splitting filter params from drill
  params and porting the repeated-param checklist verbatim
  (library-client.tsx:463-469) — nothing in this design blocks it.

Own/Type rails, search debounce, and the three root shelves are unchanged.

Amended 2026-08-31: scoped facet counts are a new mechanic, not a port —
haynesnetwork deliberately has none so its chip row cannot reflow. Chip
visibility resolves as: only the drilled dimension's chip hides; ancestor
dimensions are removed by the level table and replaced by the drill header.
Consequence: at the root a set vitola renders as the pill (it changes no level
and owns no header); inside a drill, Vitola is the only chip that renders
Label · Value.

## D-07 Names on tiles: composed rows drop what the header already says

Inside a drill, a `name_source='composed'` leaf renders its caption from the
parts below the drilled level — inside Liga Privada, the tile says
`No. 9 · Toro`, not the full composed name. `freeform` rows always render
`canonical_name` raw: truncated honesty beats wrong parsing. The subtitle
keeps `vitola · type`. Group-card labels follow the same rule via D-03's
sub-label.

## D-08 The leaf detail page

`/cigars/[id]` gains, in order:
- A breadcrumb under the title: `Drew Estate › Liga Privada › No. 9 · Toro`,
  each ancestor linking to its drill URL. Levels absent from the row are
  absent from the breadcrumb — nothing renders as `Unknown`.
- Facts table rows for wrapper/binder/filler, strength (from the linked blend
  row), and blender credit — absent-when-empty, never placeholders. No
  blender row ever renders for a Cuban blend (ADR-013).
- A reserved score slot: **two labeled aggregates with sample counts**
  (`Critics 91 · 12 reviews` / `Journal 8.6 · 3 smokes`) landing with ADR-013.
  Until then the slot renders nothing. A single smoke's rating never appears
  as a blend-, line-, or brand-level number anywhere in the catalog — the
  tile's existing rating seal stays what it is: the viewer's own per-cigar
  rating.

## D-09 URL contract summary

```
?by=brand|line|blend|vitola      grouped view (absent = flat All)     [clean PUSH]
?view=ledger                     the ledger table (unchanged)         [clean PUSH]
?brand= ?line= ?blend= ?vitola=  hierarchy state — drill or chip      [drill: preserving PUSH; chip: REPLACE]
   value `unfiled`               IS NULL at that level (D-05)
?sort=field:dir                  leaf sorts + direction (absent = name:asc) [REPLACE]
?q= ?own= ?type= ?instock= ?smoked= ?favorites=   unchanged           [REPLACE]
```

Precedence, ported verbatim (library-preferences.ts:76-108): **URL wins
per-dimension → stored preference → default, and a URL-derived resolution is
never written back.** v1 has no stored preferences (DESIGN-003's URL-only
rule stands); the resolver ships with the stored tier empty so preferences
can land later without a contract change.

Amended 2026-08-31: explicit-default tokens (by=all, own=all, type=all,
sort=name:asc) parse to the default and are written only by a future
stored-preference canonicalizer; a bare URL stays 'no choice'. Group-card
ordering rides gsort, leaving sort to the leaf.

## §Strings

Seg: `All · Brands · Lines · Blends · Vitolas · Ledger`. Chips: `Brand`,
`Line`, `Blend`, `Vitola`, `Clear all`. Group subtitle: `{n} cigars · 1 cigar
singular`. Badges:
`{n} in humidor`, `{n} wanted`. Unfiled card: `Unfiled` + count subtitle.
Drill back labels: `All brands`, `All lines`, `All blends`, `All vitolas`,
else the parent entity's name. Sort labels unchanged; direction is the ▲/▼
glyph only. No helper blurbs anywhere — the controls explain themselves or
they are wrong.

## Out of scope

Blender-level browsing and score roll-up surfaces (ADR-013 / #199);
multi-select hierarchy filters (D-06); the R-CAT-5 numeric facets — strength,
country, ring gauge, length, price range — now unlocked by structured keys
but still deferred until enrichment fills them; server-stored view
preferences; A–Z jump; shelf redesign.

## Build notes (Wave 4)

New: group-card component, drill header, `catalog.facetOptions` procedure,
registry expansion to the level table in D-04, the `unfiled` reserved slug,
breadcrumb + facts + score slot on the detail page, brand-route redirect.
Changed: seg options, chip row, sort pills gain direction, tile caption
elision. Test pins to port from haynesnetwork's e2e: the 390×844 clamped
popover and one-row chip bar (library-grid.spec.ts:221-253), plus URL-contract
round-trips per level. UI lanes produce before/after screenshots from the
local preview rig, per the repo standard.
