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
  rating in a small circular **band seal**, and a one-line burn-line
  sparkline (below) as the recurring identity element.
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
- **The sparkline.** A one-line miniature (thin stick, marker dots, ember)
  on journal cards and your-smokes lists — legible at 16px tall, and the
  recurring brand mark of the whole app.
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
  `RatingSeal`, `BurnLine` (ribbon + sparkline variants), `VitalsBlock`,
  re-tinted `Chips`.
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
