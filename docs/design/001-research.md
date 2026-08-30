# DESIGN-001: Makeover research brief

- **Status:** draft
- **Date:** 2026-08-27
- **Scope:** research grounding for the visual redesign of the web app. Not a
  build plan; the implementation sketch at the end sizes the work.

## Where the UI stands

Wireframe is accurate. One 18-line `globals.css` with raw hex, ten neutral-gray
Tailwind strings in `lib/ui.ts`, a single `max-w-3xl` column, browser-default
type, no images, no icons, no brand mark. The journal and catalog are `divide-y`
text lists; the progression is a stack of bordered boxes; the rating is a bare
number. The bones are good — the data model is rich (vitola dims, blend
origins, 100-pt ratings, descriptors, continuous 0–1 progression positions,
per-cigar personal profiles) and every page renders only real data (the
no-blurbs rule held). Everything below builds on those bones; nothing requires
schema changes except image references.

## What the precedents actually do

Verification note: consumer sites are egress-blocked from this pod, so visual
specifics below come from search-verified feature docs plus flagged prior
knowledge; scoring systems and feature claims are source-verified.

**Journaling and collection apps.**

- **Vivino** is camera-first (label scan → match → vendor art) and shows taste
  as horizontal spectrum bars (light↔bold, dry↔sweet) derived from descriptor
  frequency across community reviews. The bars, not the photos, are the
  transferable idea: our descriptors can drive the same derived profiles.
- **Untappd**'s unit is the check-in card (photo, notes, serving, venue,
  rating) and its rating control is a branded glyph — bottle caps in 0.25
  steps, not generic stars. Its year-recap renders one stat per shareable card.
  Transferable: a rating mark with identity, and stat presentation as one hero
  number per beat rather than a dashboard dump.
- **Whiskybase** offers a "collection shelf" view — which silently omits any
  bottle lacking a cutout image. That is the cautionary tale for
  imagery-forward layouts over a sparse catalog.
- **Distiller** shows a spirit's three most predominant flavors, aggregated
  from user tags. Cleanest flavor graphic in the category; our
  `personalProfile.recurringDescriptors` already computes exactly this.
- **Cigar apps** (Cigar Scanner/Cigarista, Boxpressd, Cigar Dojo, Cigarro,
  Cigarbase) are uniformly image-acquisition-first: point camera at band →
  match DB → pull vendor photo. Two validate our signature feature — Boxpressd
  "Timeline Smoke Sessions" and Cigarro's review-by-thirds both capture
  per-third notes. None handle a missing image with anything designed, none
  record continuous positions (all fixed thirds), and none aggregate evolution
  across repeat smokes. Those three gaps are ours to own.

**Editorial cigar design.**

- **halfwheel** publishes anchored 100-pt scores (88 = box-worthy, 86 = 3–5,
  84 = worth a single) and was founded on "better photographs" as the brand
  premise; reviews carry a structured vitals block (wrapper/binder/filler,
  size, factory, price) beside the prose. The vitals-block pattern maps
  directly onto our cigar detail page.
- **Cigar Aficionado** rates blind on named bands (95–100 Classic, 90–94
  Outstanding…) and maintains a defined wrapper-color vocabulary from light
  tan to near-black — a real, domain-native color scale (the archive's own
  cheat-sheet mirrors it: Candela → Connecticut → Corojo → Maduro).
- **Brand sites split into two worlds:** Davidoff is verified white + gold —
  clean-light luxury; the heritage houses (Padrón, Fuente) and the
  lounge/magazine aesthetic lean dark, serif, amber (prior knowledge,
  unverified). Premium does not force dark; it forces restraint. Retail
  packshots — what the crawler will actually fetch — are white-background
  single sticks, band facing camera.
- **Dark-theme practice (well verified):** dark warm gray base rather than
  pure black; elevation via lighter surfaces, not shadows; accents
  desaturated 20–30% vs light mode; one saturated accent reserved for
  meaning.

## Imagery strategy

**Sourcing and rights.** Vendor packshots arrive with the R10 crawler.
Product photos are copyrighted; a personal invite-scale journal using them
with attribution is low-risk but unlicensed. Posture: download at crawl time
only from vendors whose robots/ToS pass the per-adapter check the PRD already
requires; record source URL, vendor, and fetch date per image; attribute on
the offer row; honor takedown by deleting the asset. Public journal pages
(R7) ship with generated placeholders until the rights posture per vendor is
reviewed. Manufacturer press assets, where published, are preferable and
should be flagged as such in the vendor registry.

**Serve via our own proxy; never hotlink.** Hotlinking leaks reader IPs to
vendors, breaks when SKUs vanish, and violates some ToS. haynesnetwork's
poster proxy is the model but with one difference: its upstreams (arr/TMDB)
are durable, so it streams live; ours are scrape targets that disappear, so
we store the bytes at crawl time (content-hash key, object storage or
Postgres large object — decided at ADR time) and serve through an authed
route reusing haynesnetwork's exact cache recipe: strong ETag
(`sha1(source:ref)`), `If-None-Match` → 304 short-circuit,
`Cache-Control: private, max-age=86400, stale-while-revalidate=604800`.

**The no-image design is the centerpiece, not a fallback.** Most cigars will
have no photo for months. The placeholder is a generated **band tile**:
consistent aspect box, warm ground color chosen deterministically from the
brand (hashed within a tobacco-tone ramp; upgraded to true wrapper-shade
mapping — Candela through Oscuro — if/when a wrapper-shade field lands),
brand monogram in the display serif inside a thin double keyline ring evoking
a band, vitola + NC/CC in letterspaced small caps. Rules borrowed from
haynesnetwork's `MediaPoster`: the box reserves its aspect ratio so nothing
reflows; a real image fades in over the tile on load; a 404 shows the tile,
never a broken img; no view ever omits an imageless cigar (the Whiskybase
failure). White vendor packshots sit inside a parchment plate (padded light
well) so they read as framed photographs on the dark theme instead of glaring
rectangles.

**User photos.** Later, smokes accept photos (band, stick, setting) — the
category evidence (Boxpressd) says entry photos, not catalog art, are what
make a journal feed feel alive. EXIF stripped, visibility inherits the
journal's. A user's band photo can stand in as the cigar's tile when the
catalog has nothing, labeled as user-sourced.

## Visual directions

### A — Humidor (dark lounge editorial) — recommended

The evening-ritual aesthetic, done with restraint so it never becomes a
leather-armchair cliché.

- **Color world:** espresso near-black base (warm, not `#000`), surfaces
  stepping lighter for elevation, parchment text, a single amber/gold accent
  (desaturated on dark) reserved for the rating, links, and primary actions.
  The wrapper-shade ramp is the data palette for tiles and chips. Light theme
  is a first-class sibling, not an inversion afterthought: warm paper + ink +
  deeper amber — the Davidoff world by day, the lounge by night.
- **Type:** a high-contrast display serif for cigar names, journal titles,
  and the brand mark (Fraunces-class, self-hosted via `next/font`); a plain
  humanist sans for UI and data; letterspaced small-caps for fact labels
  (WRAPPER · VITOLA · FACTORY — the engraving on a band); tabular numerals
  for ratings and dimensions.
- **Journal:** entries become cards on the dark ground — date rail, serif
  title, first line of the narrative, descriptor chips in tobacco tones, the
  rating in a small circular **band seal**, and a labeled **strength meter**
  (small-caps STRENGTH + five-step fill over mild→full). Originally a
  burn-line sparkline; live use read the unlabeled bar as strength (issue
  #49, 2026-08-28), so the owner's expectation won and the burn line is
  reserved for the detail page.
- **Smoke detail:** a reading page. Narrative set in comfortable measure
  (~65ch) at generous line-height — the prose is the soul and gets the
  center; the facts grid demotes to a labeled vitals strip; the progression
  ribbon is the centerpiece between them; original imported markdown styled
  as an archive plate rather than a `<pre>`.
- **Catalog:** browse-first (the page is currently empty until you type).
  A grid of band tiles ~4-up desktop / 2-up phone — larger than
  haynesnetwork's 9-up because our catalog is hundreds of items where
  recognition beats density. Search filters the grid in place.
- **Cigar detail:** band tile (or photo) as the hero beside the halfwheel
  vitals block; Distiller-style top-3 recurring descriptors leading the
  personal profile; your-smokes list with rating seals; a designed slot
  where vendor offers land at Phase 6.

Risk: dark pages demand photographic discipline we don't control (vendor
shots are white-background) — mitigated by the plate treatment; and warmth
can slide into kitsch — mitigated by keeping the accent count at one and the
sans doing all workhorse duty.

### B — Ledger (typographic field notes)

The mkdocs archive grown up: warm paper-first, ink text, tobacco-brown
accent, ruled hairlines, ledger tables with tabular numerals, small-caps
labels; photographs appear as tipped-in plates when they exist and are never
missed when they don't. It degrades perfectly from day one and is the
cheapest to execute, but it treats photography — the owner's explicit ask —
as decoration, and its shareable ceiling is "handsome document" rather than
"place other smokers want to poke around." Its typographic system is worth
keeping wholesale; as the whole identity it undersells the ambition.

### C — Poster wall (the haynesnetwork feel) — evaluated honestly: no

Transplanting the look fails on three facts: (1) the poster grid is tuned
for dense 2:3 portrait art that *always exists* (arr/TMDB upstreams,
132px-min 9-up walls) — on day one we would render a wall consisting
entirely of fallbacks; (2) cigar packshots are long thin horizontal objects
that crop terribly into portrait cards; (3) our primary surface is the
journal — prose plus structured data — not an art wall.

What transfers is the engineering philosophy, and it should transfer
wholesale: the token contract (`tokens.css` as the only file allowed raw
hex, semantic `--color-*` roles, `data-theme` switching with a pre-hydration
stamp so there is no theme flash), the hex-lint script in CI, the reserved
aspect-ratio art box with designed fallback and fade-in reveal, the ETag/304
proxy caching recipe, closed card components with no children passthrough,
and the no-layout-reorientation rule (interactions recolor, never reflow).

### Recommendation

**A, carrying B's typographic discipline for the prose surfaces and C's
infrastructure.** The goal is a journal the owner proudly hands to other
smokers: that argues for atmosphere (A) over document (B), and the band-tile
system means A's imagery-forward feel works at zero photos. The smoke detail
page — the thing a shared link lands on — is where A and B merge: lounge
chrome, ledger typography. Public pages and OG share cards (band tile +
seal + title) fall out of the same components.

## Signature element: the burn line

No competitor shows flavor evolution within a smoke; ours records continuous
0–1 positions, not fixed thirds. Make the timeline the product's signature.

- **The ribbon.** A horizontal stylized cigar as the axis — foot at left,
  band and cap at the right end. Position 0–1 maps along the stick. The
  smoked portion (through the last entry) renders as an ash-to-ember
  gradient with a small ember dot at the last position. Entry markers sit on
  the stick; stage labels (Opening, First third…) beneath; each marker's
  descriptors, specific descriptors, and verbatim line in a card connected
  by a hairline leader. Desktop lays cards below the ribbon; mobile falls
  back to a vertical rail with the same marks.
- **Degradation is designed, honestly.** Entries without positions space
  evenly in order — labels only, no percentage axis implied. One entry or
  overall-descriptors-only: no ribbon at all, just the descriptor chips.
  Never a fake axis.
- **Detail page only.** A one-line sparkline miniature originally carried
  the mark onto journal cards, but at 16px with no label it read as a
  strength meter (issue #49). Cards now carry the labeled strength meter;
  the ribbon appears only where its stage labels and rail give it context.
- **The aggregate (Phase 7).** On cigar detail, overlay all smokes'
  progressions: descriptor bands showing where flavors typically enter
  ("cocoa arrives in the second third in 3 of 4 smokes"). This is the
  cross-smoke view no competitor has and the payoff of continuous positions.

## What the makeover touches

- **Foundation:** token layer in `globals.css` (semantic `--color-*` +
  structural tokens, `data-theme` dark/light, pre-hydration stamp + toggle),
  hex-lint script in CI, two self-hosted fonts via `next/font`, `lib/ui.ts`
  rebuilt on tokens.
- **New components:** `BandTile` (placeholder/art box + fallback + plate),
  `RatingSeal`, `BurnLine` (detail-page ribbon), `StrengthMeter`,
  `VitalsBlock`, re-tinted `Chips`.
- **Pages restyled, structure intact:** app shell/header, journal list,
  smoke detail, catalog (becomes browse grid + filter-in-place search),
  cigar detail (hero + vitals + profile + offers slot), record/edit forms
  (skin only — no form-logic changes), signin, empty states (action-first
  copy only, per the no-blurbs rule).
- **Later wiring, designed-for now:** image assets on cigars + authed proxy
  route (crawler phase), smoke photo upload, public-page OG cards, stats
  page (histogram, wrapper/origin buckets, heatmap).
- **Not touched:** data model (beyond image refs), tRPC surface, form
  behavior, component-library adoption (none).

## Amendment — measured palette criteria (2026-08-30, issue #49)

Direction A named the wrapper-shade ramp as the data palette and the chips as
"tobacco-tinted" but fixed no numbers, so both drifted. Measured against the
live catalog before the walkthrough:

- 19% of catalog names hash to stops 7–8, which sat at **1.32:1 / 1.25:1**
  against the dark page and card grounds — a tile there is a hole, and
  `BandTile` painted no edge of its own at thumb or hero size.
- Stops 4 and 5 carried their monogram ink at **3.94:1 and 4.43:1**, below
  text contrast, and the `vitola · type` footer is real information.
- The eight stops' worst adjacent separation was **ΔE 8.8** (CIE76), all
  seven adjacent pairs under 11 — eight stops reading as roughly four shades.
- `--chip` was `--paper-200` / `--espresso-800`: **1.12:1** against the card it
  sits on, and byte-identical to `--raised` on paper. The filled tier and the
  keyline tier were the same object; only the italic separated them.

### The criteria, and the arithmetic they force

Every stop must clear **1.6:1 against both `--bg` and `--surface` in both
themes** and **4.5:1 against its own monogram ink**. Those two floors are not
independent: the first bounds a stop's luminance from both ends
(Y ∈ [0.045, 0.513]), the second splits what remains into two disjoint bands —
**L\* 56.8–76.9** for stops taking the dark ink and **L\* 25.2–44.2** for the
light ink — with a dead zone between them no stop may occupy. Four stops per
band is what fits, so the 1–4 / 5–8 ink split is that arithmetic's output, not
a convention: each stop clears 4.5:1 against exactly one of the two inks, and
`token-contrast.test.ts` asserts precisely that rather than the split itself.

1.6:1 is not a WCAG figure. No single ramp value can reach the 3:1
non-text threshold against an espresso ground and warm paper at once while a
tile keeps one theme-constant colour, so the floor buys "still an object, not a
hole" and `BandTile` now paints its own hairline `border-line` edge when it owns
its box. Tiles rendered `shape="fill"` stay edgeless — all four call sites frame
them in `border border-line` already.

**Adjacent separation lands at ΔE 11.1, not the 12 the fix was scoped at.** With
~6 L\* units per step inside each band, reaching 12 needs roughly 10 units of
extra a/b separation per step, and a muted tobacco chroma envelope yields about
7. The two ways past that were both rejected on rendered evidence: alternating
chroma ±8 hits ΔE 12.3 but makes every other stop read as a mistake rather than
a step, and sweeping hue below ~35° hits 12.7 by turning the oscuro end
burgundy. A monotone 110°→38° hue sweep at C\* 31–38 is the ceiling for a ramp
that still reads as one ordered leaf family, so 11 is the recorded criterion.
The remaining separation is carried by the edge and by the caption beneath the
art — which is also the honest answer to sibling tiles, below.

Chips take the tobacco tint the direction always specified
(`--tobacco-wash-light` / `--tobacco-wash-dark`), at **≥1.5:1** against both
grounds with the label still at 4.5:1. That restores the two-tier read without
touching the stored vocabulary: normalized descriptors are kebab-cased, so
`Chips` now renders `dark-chocolate` as "dark chocolate" — a label transform
only, lowercase so the normalized tier keeps the verbatim tier's voice.
`normalizeDescriptor` and every query path and MCP payload are unchanged.

`--wrapper-leaf` is a ramp stop, so the retune restyles the burn-line rail;
the leaf's separation from both ends of the ash→ember gradient is asserted
alongside the ramp rather than left to be noticed later.

### Not fixed here

Identity is hashed from the house and the monogram is the house's two initials,
so at catalog scale the grid renders **runs of byte-identical tiles** — 30
consecutive Arturo Fuente, 26 La Aroma de Cuba, and in the owner's own photoless
humidor H Upmann ×4 and Ramon Allones ×4 adjacent. 824 of 967 names (85%) share
a mark with a sibling. That is the identity algorithm working as designed, and
changing it is a design decision rather than a contrast fix; the caption below
the art is what differentiates siblings today.
