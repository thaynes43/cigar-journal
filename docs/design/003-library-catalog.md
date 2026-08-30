# DESIGN-003: The library catalog — one grid, full bleed

- **Status:** accepted (owner directive 2026-08-29; supersessions listed at end)
- **Date:** 2026-08-29
- **Inputs:** owner review of the live v0.23.1 catalog against the
  haynesnetwork Library; an eight-lane audit (code map, requirements diff,
  prod-DB coverage stats, haynesnetwork source read, UX research with
  citations, image-pipeline root cause, curation rethink, backlog review).

## The miss, named

The owner's ask was constant across three recorded statements (PRD-002
Problem, PRD-003 Problem, and the 2026-08-29 review): **one grid whose
contents transform under filters** — inventory and catalog living together,
sliceable like the haynesnetwork Library. What shipped diverged in six ways:

1. **Specced away:** PRD-003 R-UNI-1 / DESIGN-002 §IA translated "one tool
   with filters" into *three switchable views* (Brands default · All ·
   Ledger). The unified grid exists (`CatalogAllGrid`) but is buried behind
   the "All" pill; the landing page is a brand-directory drill-down.
   DESIGN-002's own research table recorded the rule it broke: "combinable
   filters, **not tabs or separate pages**" (Letterboxd).
2. **Specced away:** root shelves render only at `atRoot`
   (`cigars/page.tsx:42`), so the first filter tap *deletes* page content
   instead of transforming a grid.
3. **Built against spec:** PRD-002 conventions specify
   `auto-fill minmax(~132px,1fr)` grids; the build hardcoded
   `grid-cols-2..5` with no `xl`/`2xl` steps and left the app shell's
   `max-w-5xl` (1024px) cap in place (`layout.tsx:20`). Result: 4–5 columns
   in a sea of margin where the reference shows 11–13.
4. **Built raw:** shelves are `overflow-x-auto` with native scrollbars — no
   affordance, no fade, no paddles. On Windows Chrome that is a 15–17px
   layout-occupying bar under every strip.
5. **Specced away:** facet groups are bare segmented pills with aria-only
   labels. The reference labels every rail — a fix haynesnetwork itself had
   to make after shipping the same mistake.
6. **Undelivered:** price sort and tile price-at-a-glance are fully
   implemented and tested in the domain (`catalog-browse.ts:34,286`,
   `OFFER_JOIN` computed on every tile) and never rendered; `totalCount` is
   returned and never read; PRD-002 R-CAT-5's filter set (strength, ring
   gauge, length, country, price range, smoked-by-me) never grew past
   type + ownership.

Data reality underneath (prod, 2026-08-29): 919 cigars, **853 photos — all
from the single Fox Cigar seed crawl**. The owner's humidor holds 82 distinct
cigars; **63 have no photo (all 46 CC + 17 NC)** because the only crawled
vendor is a US NC retailer. 834 rows (91%) have `type=NULL`, so the NC/CC
facet silently excludes most of the catalog; 538 rows have no brand; 1778
listing matches sit at `auto` untriaged; `product_photos.rights` is written
(`pending` ×853) and read nowhere.

## The reference, measured

From the haynesnetwork source (not the screenshot — geometry verified):

- **Full bleed:** no max-width anywhere; `<main>` pads 24px/16px; the grid
  is `repeat(auto-fill, minmax(132px, 1fr))`, gap 12px, fixed 3-col ≤480px.
  13 columns at 1920, 11 at 1630, 8 at 1280, 5 at 768. Tiles multiply,
  never inflate.
- **URL is the single state store**; filter edits `router.replace`, view
  switches `router.push`. Per-user view+sort preference persists
  server-side; explicit URL wins.
- **Labeled rails:** every segmented group carries a leading muted label
  ("On disk", "Wanted") — added by amendment after unlabeled adjacent rails
  "read as competing filters."
- **Chips:** one ghost pill per facet, opening a popover (checklist /
  radio / range); active chip = accent tint + `Label · values` + ✕.
- **One locked tile anatomy:** reserved fixed-ratio art box, caption below
  (never overlaid), badge row hard-capped at 3, state expressed by badge
  tone only — amber "Wanted" tiles coexist with owned tiles in one grid. A
  separate wanted shelf was explicitly rejected there.
- **Sort row:** ghost pill per key, click applies best-first direction,
  second click reverses, reserved glyph slot so nothing shifts.
- **Refetch UX:** previous grid dims to 0.55 opacity in place; skeletons
  hold exact geometry; never a collapsing spinner.
- **Chrome:** avatar-initials dropdown (identity header → destinations →
  Sign out last). No horizontal poster shelves at all — recency is the
  default sort of the one grid.

## IA (replaces DESIGN-002 §IA view model)

**`/cigars` IS the unified cigar grid.** Landing = root shelves (lenses)
above the full, infinite, filterable grid of every catalog cigar with
personal state as badges. No view pill guards it.

- **Presentations, not pages:** `?view=brands` renders the same surface as
  brand group-cards (cover + name + stick/line counts, drill-in to the
  existing brand pages); `?view=ledger` remains the desk-work table —
  deliberately different shape, takes no facets (unchanged). Default
  (`view` absent) is the cigar grid. `/inventory` redirects keep working.
- **Filters transform in place.** Facets/search/sort apply to the grid (and
  re-badge the brand wall) without changing page shape. Active filters or
  search collapse the shelves; the grid persists — filtering never empties
  the page.
- **Labeled rails** (`label-caps` muted lead + existing segmented control):
  `Own` All · Have · Want · Don't have — `Type` Both · NC · CC.
- **Filter chips** (popover pattern, ghost → accent-tinted when active):
  `Brand` (checklist with counts, backed by `BrowseCatalogArgs.brand` —
  router must accept it), `In stock`, `Smoked`, `Favorites` (all four
  domain-ready tri-state booleans; router input currently omits them,
  `server/routers/catalog.ts:24`). Strength / country / ring gauge /
  length / price-range chips follow when the domain grows those filters
  (R-CAT-5 debt, explicitly not this build).
- **Sort row:** Name · My rating · Recently added · **Price** (un-deferred;
  registry row + param parse only — domain path is complete and tested,
  unpriced group after priced under the explicit break per R-UNI-3).
  Default sort: name. Sort persists per the reference only if trivially
  cheap; otherwise URL-only is acceptable v1.
- **Result count:** render `totalCount` (already returned) beside the sort
  row — "N cigars".
- **Type honesty:** until the type backfill lands (curate agent, below),
  the NC/CC rail filters a minority of rows. Ship the backfill in the same
  release wave as the facet promotion; the UI does not pretend.

**Shelves, kept but earned** (R-UNI-4 stands): *In your humidor* ·
*Wanted* · *Recently added*, cap 12, absent-when-empty, root only.
Required affordances, per the UX research consensus:

- hidden native scrollbar (`scrollbar-width: none` + webkit) — licensed
  only by the alternatives below;
- right-edge partial tile bleed + edge fade mask;
- hover-revealed chevron paddles (real buttons, `aria-label`, scroll by
  ~90% of the viewport width);
- touch: free swipe, `scroll-snap-type: x proximity` (never mandatory),
  `overscroll-behavior-x: contain`; reduced-motion drops smooth scroll;
- container `role="region"` + `aria-label` + `tabindex="0"`; tiles stay
  normal links in DOM order — not the APG carousel pattern;
- header row: title + count + **See all →** linking the equivalent filter
  state of the grid below (`?own=have&sort=my-rating` etc.).

## Tile (one cigar card everywhere)

- **Art box: 3:4 portrait** (`aspect-[3/4]`) — the entire photo stock is
  600×800; 16:9 (`aspect-video`, `cigar-still-tile.tsx:59`) crops every
  photo it has. Brand cards share the same 3:4 frame (covers *are* member
  photos). BandTile monogram fills the identical frame when no photo —
  geometry never varies between photo and placeholder tiles.
- **Caption below the art** (unchanged discipline): name · `vitola · type`
  subtitle; when a current offer exists, per-stick price joins the subtitle
  in tabular numerals (`$8.40 /stick`) — muted, not a badge, so the
  badge cap holds. Delivers R-PRICE-2 from data already on every tile.
- **Badge row cap 3, priority unchanged:** remaining ×N · Want (accent) ·
  rating seal; favorite stays the ember heart on the art corner
  (design.test.tsx pins these semantics — keep them).
- **Grid mechanics:** `repeat(auto-fill, minmax(160px, 1fr))`, gap 3–4;
  fixed 3-col ≤480px (small-viewport fallback so minmax never overflows).
  ~5–6 columns at today's 1024, ~11 at 1920. `auto-fill`, not `auto-fit`
  (sparse filter results must not inflate tiles). Skeletons +
  dim-in-place refetch behavior stays.

## Layout (replaces the shell cap)

The `(app)` shell drops `max-w-5xl`; it provides gutters only
(`px-4 sm:px-6 lg:px-8`). **Measure moves to the routes:** catalog surfaces
run full bleed; journal, smoke detail/forms, cigar detail, auth keep their
current narrow measures (`max-w-2xl/3xl/sm`) by wrapping their own content.
The header inner container widens to match the shell. Wide content inside
narrow routes (ledger, tables) keeps its own `overflow-x-auto`.

## Chrome: user menu (replaces the flat right cluster)

Right cluster becomes: record pencil (unchanged) + **avatar-initials
button** (accent circle, display-name initial) opening a `role="menu"`
popover: identity header (name, email) → **Settings** → **Ledger** →
admin-only **Catalog review** → divider → **Sign out** (last). Esc returns
focus; click-outside closes. Curation leaves the top nav entirely; nav is
wordmark (→ Journal) · Catalog. Anonymous header unchanged.

**`/settings` v1** (the surface three backlog items were waiting on):
display name; journal visibility (public/private — the #97 flip finally
gets a UI instead of raw SQL); timezone (fixes #49's UTC dates). Invites
and SSO linking shipped here in #46 (ADR-010): a `Sign-in` section listing
linked identities (Password, plus Authentik when SSO is configured), and an
admin-only `Invites` section. Registration itself lives outside the shell,
at `/invite/<token>`.

## Curation → Catalog review + the curate agent

The owner's ruling: **users never do catalog data entry; agents do.** No
gamification — automation. The console inverts from "do the work" to
"review the agent's work":

- **Move + rename:** `/curation` → `/admin/catalog`, "Catalog review",
  reachable only from the user menu.
- **Fix the rights bug first:** `rights` is never read; `suppressed` would
  still serve (`product-photos.ts:19-32`, serving routes check principal
  only). Reads filter `suppressed` everywhere; public serving (when it
  exists) requires `approved`.
- **Missing human primitive:** `setListingMatchStatus`
  (confirm/unmatch) — service + adminProcedure; the API both humans and
  the agent call. Add `cigars.catalog_status` (`active|excluded`) +
  `excludeCigar` for non-cigar pollution; a `renameCigar` service for
  canonical names.
- **The `curate` batch role** (Dockerfile ROLE DISPATCH like `crawl`;
  Sonnet 5 per the API-pricing policy): LLM triage of the 1778 auto
  matches (confirm/unmatch), brand/line backfill of the 538 unbranded
  rows (via the existing fill-nulls-only `update_cigar`), **type
  classification of the 834 NULL rows**, non-cigar flagging, photo
  suppress for obvious mismatches. High-confidence auto-applies; the rest
  become proposals.
- **Attribution + reversibility:** `audit_log.actor` gains `agent`; add
  `run_id`, `confidence`, and a `reverts` self-link. Merge stops
  hard-deleting (tombstone the source) so Undo is real. Review UI = two
  lists: pending proposals (approve/reject, before/after diff) and recent
  agent runs (undo).
- **Unmerge (per-merge ledger + LIFO):** the tombstone preserves the
  *data*; a `cigar_merges` row per merge preserves *which rows moved*,
  which is otherwise unrecoverable — after the merge a re-pointed smoke is
  indistinguishable from one the survivor always had, and the
  want/favorite de-dupe deletes rows outright. The ledger holds the exact
  ids the merge re-pointed plus full payloads of the deleted marks;
  `unmergeCigars` claims it single-use (conditional `undone_at`) and puts
  them back. Consequences that are rules, not implementation detail:
  **(1)** rows created on the survivor after the merge are never touched —
  the ledger is an explicit id list, so no "move everything pointing at
  the target" query exists; **(2)** neither side of a merge may already be
  a tombstone — a tombstone is never re-merged and never a target — but
  chains of any depth still form as survivors are themselves merged later
  (A→B, then B→C, then C→D), and a chain unwinds **LIFO**, newest merge
  first, because A→B's rows now sit at the far end of it; **(3)** unmerge
  is not forced to be byte-exact — a row a curator moved on, a photo slot
  the tombstone re-took, a mark the user re-created, and a purchase lot
  whose every consumption belongs to a smoke that is *not* returning
  (sending that lot back alone would inflate the user's humidor count) are
  each skipped with a reason and counted in the audit and the console,
  never overwritten; a lot **both** sides drew from has no exact inverse
  short of splitting the user's purchase row, which is an owner decision,
  not the unmerge's — it goes back with the source, the cigar the user
  actually bought and the only one they can attribute the next stick from,
  leaving the survivor's own consumptions unmet; **(4)** a merge audited
  before the ledger existed reports non-reversible rather than guessing. Merge and unmerge are actor
  `web` with no `run_id`, so they get their own **Recent merges** console
  section — they can never surface under "Recent agent runs".
- **Humans stay in the loop only for:** merges, rights takedowns,
  exclusions that would hide an owner-held item, and any low-confidence
  proposal. Renames are deliberately absent from that list — the agent
  owns name cleanup (`rename_cigar` on the MCP curation surface), the
  human owns the review and the Undo. Unmerge stays out of MCP for the
  same reason merge is: handing the agent unmerge would hand it the merge
  lever backwards, letting it reverse a curator's verdict.

## Product images: coverage plan

Photos arrive only via vendor listing matches from **one** NC adapter, so
the Cuban humidor can never be photographed by the current pipeline. The
sequence (rights-honest, fastest visible fix first):

1. **Rights enforcement + upload path (web):** curator/admin product-photo
   upload (rights=`approved`, source recorded) reusing the existing
   `@cj/photos` pipeline and bucket. The only path that fixes the owner's
   46 CC cigars immediately with a clean rights story. The existing
   photo-upload-link flow extends to product photos.
2. **Agent photo attach:** the curate agent may propose a photo for a
   photoless cigar (brand/manufacturer press imagery or a listed vendor's
   product shot), always carrying `source_url`; below-threshold or
   ambiguous → proposal queue. Owner's 2026-08-29 direction authorizes
   sourcing from retailer/brand sites; per-site robots/ToS reads remain
   mandatory before any automated fetch (ADR-006 rule).
3. **NC adapters:** 2 Guys Cigars and Small Batch Cigar next (same
   sitemap+JSON-LD shape as Fox), each after a live robots/ToS read from
   the crawl pod. **Cigars International is dropped** (bot defenses +
   sister-site ToS scraping ban).
4. **CC sources:** per ADR-006 the registry decision stands — Cuban Lou's
   (WooCommerce, softest target) for catalog/photo depth with
   unapproved-source labeling; the r/cubancigars approved list synced via
   the official Reddit API remains the price-display gate. Photos always
   record their source and honor suppress.
5. **Brand-wall fallback:** Wikidata brand imagery (CC-licensed) as cover
   fallback where no member cigar has a photo — a logo beats a monogram.
6. `#97` items (unsuspend crawl CronJobs) stay owner-gated and unchanged.

### Who owns the enqueue (#154)

The worklist above lists the photoless holdings and offers a manual upload;
`queue_enrichment_backlog` is the other half — one press turns the whole list
into `enrichment_requests` rows for the crawler's enrich runs. Two surfaces,
one domain service, so they cannot drift:

- **The console button is the operator press**, in the "Missing photos" section
  header. Not data entry — one action over a list the console already renders.
- **The MCP tool is the same press on the agent surface**, under the curate
  agent's existing `curation:write` token and that run's id. It is *not* part of
  the daily run: the server instructions tell the agent to report the worklist
  and leave the press to the operator, because a press has an ops prerequisite
  (below) that no agent can check from the conversation.

It rides `curation:write`, not the `journal:write` the ADR-009 repair tools
use: it is curator-gated, worklist-scoped and run-attributed. That choice is
load-bearing — the curate agent's token already holds `curation:write`, so
nothing needs re-consenting, and the agent never has to be handed
`journal:write` (which would give a catalog agent `save_smoke`,
`record_purchase` and `set_want` over the owner's journal).

**Two preconditions, enforced by the service rather than documented.** A queued
request the crawler cannot serve is not inert: every drain that looks and misses
spends one of that vendor's two attempts (`ATTEMPTS_PER_VENDOR`, migration 0023),
and the row retires once every lane that runs is spent. So a press writes a row
only when both hold, and reports every other row with the reason:

1. **The name has been reviewed** (`verification = 'verified'`, the signal
   `verify_cigar` sets). Enrichment resolves a cigar by its canonical name twice
   over — slug-token ranking of candidate URLs, then a pg_trgm
   `similarity(canonical_name, listing.name) > 0.55` floor before it will link.
   The photoless holdings carry reversed, doubled and misspelled names
   (`Choix Supreme Rey Del Mundo`, `Trinidad Trinidad Reyes`,
   `Rockey Patel Rocky Patel Edge`), and none of them has a listing match, so a
   press over them is two no-match passes and a dead row. `rename_cigar` has
   existed since v0.26.0; what is missing is the **use** of it. Rows that fail
   this report `unverified_name`.
2. **Some crawl-enabled vendor covering the cigar's market has completed an
   `enrich` run.** Not `crawl_enabled` alone: Cuban Lou's is crawl-enabled today
   and has only ever run a `seed`, while the one enrich CronJob is NC-only — so
   41 of the 58 photoless holdings are CC rows that a press would feed to a
   crawler that cannot carry them. An untyped cigar needs both markets covered,
   because enrichment is what would say which it is. Rows that fail this report
   `no_vendor_coverage`, and the gate opens by itself the first night that
   market's enrich lane runs. There is no override argument for either gate: the
   way past them is to do the thing they assert.

Both gates are now **per-vendor** underneath (ADR-006 amendment 2026-08-30,
migration 0023). A vendor's catalogue is partial, so "no match at Fox" is
evidence about Fox and nothing else: each vendor carries its own attempt budget
against a request, and the row retires only once every one of them is spent.

The denominator is **liveness** — crawl-enabled, focus covers the market, and the
lane has completed an `enrich` run (or has already looked at this very request).
It is the same predicate as the queue gate above, read as vendors rather than as
markets. It is deliberately NOT `crawl_enabled` alone: nothing in the crawler
reads that flag (#156), so an enabled vendor with a suspended CronJob would hold
every matching row open forever — which, with 890 untyped rows needing both
markets and Cuban Lou's lane suspended, is the whole catalogue. Enabling a vendor
does not by itself retire anything; its lane RUNNING does, and that lane's first
night also reopens every row it has not looked at, with no reopen job.

Two outcomes are reported apart from `exhausted` because they are different
facts. A row no lane counts against stays open. A row every counted lane failed
to REACH (`ERROR_BUDGET` burnt, zero completed looks) reports
`vendor_unreachable` — calling it `exhausted` would assert a catalogue fact
nobody established. `retryExhausted` clears both. The console's report says which
vendors spent themselves (`triedVendors`) and which could have looked
(`eligibleVendors`), because a retirement that does not name a vendor tells an
operator nothing they can act on.

## Build waves (each a dispatchable lane; docs-first satisfied by this doc)

1. **Frame (web):** shell width + per-route measures; auto-fill grids;
   default-view flip + URL contract (`view` param inversion, redirects);
   labeled rails; shelf affordances; 3:4 tile + tile price + result count;
   price sort un-defer. Tests: current suite pins tokens/atoms/domain only
   — view composition and widths are free to change; add coverage for the
   new URL contract.
2. **Chrome (web):** user menu; `/settings` v1; `/admin/catalog` move.
3. **Primitives (domain/db):** rights-honored reads; `setListingMatchStatus`;
   `catalog_status` + `excludeCigar`; `renameCigar`; audit columns
   (`agent`, `run_id`, `confidence`, `reverts`); tombstone merge.
4. **Curate agent (ops/mcp):** the batch role + review/undo queue.
5. **Images (crawler/web):** upload path; agent attach; 2 Guys + Small
   Batch adapters; Wikidata fallback.
6. **Facet chips (web):** router accepts the overlay booleans + `brand`;
   chip components; counts. (After wave 1 so the grid contract is stable.)

## Strings (implementers use exactly or flag)

| Surface | String |
|---|---|
| Rail labels | `Own` · `Type` · `Sort` |
| Chip labels | `Brand` · `In stock` · `Smoked` · `Favorites` |
| Result count | `{n} cigars` |
| Shelf overflow link | `See all` |
| Tile price (subtitle) | `${n} /stick` |
| Sort keys | `Name` · `My rating` · `Recently added` · `Price` |
| Price-sort break | `No current offer` |
| User menu | `Settings` · `Ledger` · `Catalog review` · `Sign out` |
| Menu trigger | initials circle, `aria-label` = `Account menu` |
| Settings page | `Settings`; sections `Profile` · `Journal` · `Time` · `Sign-in` · admin-only `Invites` |
| Sign-in methods | `Password` (no action) · `Authentik` with `Link` / `Unlink` |
| Invite form | `Email` + `Create invite`; minted link row `Copy link` |
| Invite table | `Email` · `Status` · `Expires` · `Revoke`; statuses `Open` · `Redeemed` · `Expired` · `Revoked` |
| Invite page | `Email` (read-only) · `Display name` · `Password` · `Create account` |
| Journal visibility control | `Public` / `Private` |
| Admin page | `Catalog review` |
| Merge section | `Recent merges`; action `Unmerge`; states `Unmerged` · `Blocked by a later merge`; moved-row chips `Smokes` · `Purchases` · `Listing matches` · `Offers` · `Photos` · `Gap-fill requests` · `Wants` · `Favorites` |
| Review lists | `Proposals` · `Recent agent runs`; actions `Approve` · `Reject` · `Undo` |
| Brand imagery (review) | `Brand imagery`; actions `Choose` · `Approve` · `Suppress` |
| Paddle buttons | `aria-label` = `Scroll left` / `Scroll right` |

## Supersessions and what stands

- **Supersedes:** PRD-003 R-UNI-1's three-view model (one grid, two
  presentations, ledger unchanged); DESIGN-002 §IA's "Brands (default)"
  landing, root-only-shelves *as sole content*, and the flat nav row
  (Curation link + bare Sign out); DESIGN-002's unlabeled facet segments.
- **Stands:** URL-as-state and minimal-param emission; ownership/type
  facet semantics and owner-approved labels; absent-when-empty and honest
  degradation; badge discipline (cap 3, want=accent, favorite=ember);
  token contract (no raw hex — CI-pinned); wait states; ledger as the
  desk-work table; keyset paging; `/inventory` redirects; R-WANT/R-FAV/
  R-CONS/R-DET/R-PRICE requirements themselves.
- **Deferred-list cleanup:** web price sort and favorites facet/shelf are
  un-deferred into waves 1 and 6; `get_cigar_prices` is struck outright
  (superseded by shipped `get_offers`).
