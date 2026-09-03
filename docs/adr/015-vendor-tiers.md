# ADR-015: Vendor tiers — one price authority, photos from any source, a catalog fed by many

- **Status:** accepted
- **Date:** 2026-09-02

## Context

The 2026-09-02 crawl audit (issue #270) found the fleet is two vendors deep:
Fox Cigar (NC) and Cuban Lou's (82 listings, no Habanos single sticks). 921 of
1,000 catalog cigars carry a product photo; the 79 without are exactly the
brands Fox does not stock (Caldwell, the Tatuaje Monster releases) and the
Habanos marcas no crawled source can answer. Prices show from Fox alone
because Fox is the only vendor with an offers walk. Two NC adapters are
dormant behind a parser gap (#252) and a missing live probe; no CC source
exists at all.

The owner's ruling (2026-09-02): add Cuban sources in **tiers** — the
r/cubancigars price-match-approved stores first, then anyone for pictures —
fall down the tier list when the top source has no photo, and stop seeding
the catalog root from one vendor: lower tiers still contribute brands and
sticks.

Today's rules pull against that. `mayWriteCatalogPhoto` decides the one
`product_photos` slot by market focus alone, first writer wins and nothing
ever replaces a photo; the enrich drain's open set has no notion of "a better
source has not looked yet"; `display_enabled` and `approval_status` exist but
no ordering ties them to who is asked first; and each vendor needs its own
CronJob pair in haynes-ops because the CLI takes one `--vendor` (#156).

## Decision

- **A vendor has a tier, and the tier is the order of authority.**
  `vendors.tier` (smallint, 1 is highest). Tier 1 is the price authority:
  the r/cubancigars approved list for Habanos (`approval_status =
  'approved'`, attributed per ADR-006) and the owner's linkout NC shops. Lower
  tiers are sources for photos and catalog structure. Tier is admin data in
  the registry, seeded from the adapter's posture on first resolve, exactly
  as `focus` is.
- **Prices are recorded from every crawled vendor and displayed only from
  tier 1.** `display_enabled` stays the display gate and is true only for
  tier 1; lower tiers' offers are kept (so a promotion is a flag flip, not a
  re-crawl) and never rendered. Every read that puts a price in front of a
  user requires it (`@cj/domain` `offer-display.ts`, wired 2026-09-02 —
  before that the column was written and read by nothing). What is gated is
  DISPLAY alone: a lower tier's offers still count as stocking evidence for
  the evidenced market and the stockist facts, and admin surfaces see them.
  An observation that names no vendor (chat, ADR-009 `source_name`) belongs
  to no tier and is never gated; one whose named source RESOLVED to a
  registry vendor is that vendor's price and takes that vendor's gate, so a
  shop cannot be display-grade through chat and hidden through the crawl.
- **Photos fall down the tier list.** The enrich drain for a vendor of tier
  *t* may take an ask only when every enabled vendor of a higher tier that
  covers the ask's market has already looked and missed (`enrichment_attempts`
  with a terminal miss, or retired) — the top source is always asked first,
  and a lower tier fills only what it could not. A photo written by a lower
  tier is **replaceable by a higher tier**: the slot is no longer
  first-writer-forever; a higher-tier capture supersedes a lower-tier photo
  (old objects deleted, audited), never the reverse, and `rights =
  suppressed` is final regardless of tier. Curators still outrank every
  tier.
- **The catalog is fed by every tier.** A seed walk from any enabled vendor
  may create catalog rows — brand, line, leaf — under matching v2's
  alias-anchored resolution, which refuses or triages a near-duplicate
  rather than minting it. Structure has no tier; only prices and the photo
  slot do.
- **One crawl over the fleet, in tier order.** The CLI gains
  `--all-enabled`: with `--mode enrich` it drains vendors serially in tier
  order (the ordering is what makes fallback a property of one run rather
  than of a CronJob calendar); with `--mode offers` it walks every enabled
  vendor serially. `vendors.crawl_enabled` becomes the real gate it always
  looked like (closes #156), and haynes-ops carries two controllers — a
  daily enrich and a weekly offers — instead of a pair per vendor. Serial
  execution inside one pod keeps the per-domain politeness the cadence
  model was built on and removes the concurrent-drain slot race the old
  per-vendor calendar existed to avoid. Per-vendor deadlines become a
  per-vendor page cap and a fleet-level `activeDeadlineSeconds`.
- **The approved list is synced by the backend, not pasted.** The owner's
  ruling (2026-09-02): the tool periodically checks the r/cubancigars wiki and
  updates vendor recommendations from what the wiki recommends; a one-time
  snapshot from the admin is not the design, and neither is opening the
  dev pod's egress. A weekly `wiki-sync` job in the crawl role reads the
  online-stores wiki — and the Stock Watch page — through Reddit's **official
  Data API** (an app registered by the owner, app-only OAuth, identifying
  user agent, well under the free-tier rate), parses the store list with the
  existing `approved-import` parser, and applies additions and revocations
  to `approval_status` automatically, audited and attributed (ADR-006's
  "admin-reviewed diff" is superseded for this feed; the admin still decides
  crawl enablement, which needs an adapter and a passing probe). The
  anonymous `.json` path stays refused. Until the app credentials exist the
  job cannot run; `--import-approved <file>` remains as the manual fallback.

## Consequences

- Caldwell-class gaps close as soon as a stocking NC vendor is enabled; the
  Cuban half of the queue closes when a tier-1 Habanos store is probed and
  enabled. Both need their adapters and their in-cluster probe (the crawl
  pods' namespace carries no egress policy, so reachability is not a step) —
  the tier does not remove onboarding, it orders it.
- `product_photos` gains `vendor_tier`-aware replacement; the object store
  sees deletes from the crawler for the first time (photos only).
- More sources means more near-duplicates offered to curation; matching v2
  is the guard, and the duplicate queue is where a lower tier's naming lands.
- The two-controller layout changes the haynes-ops HelmRelease notes
  wholesale; the per-vendor suspend switch becomes `crawl_enabled` in the
  registry (audited), which the admin console should expose — follow-up.

## Alternatives considered

- One tier, approved-only — leaves every non-approved photo source on the
  floor for a queue the approved stores may not answer; rejected by the
  owner.
- Photo fallback by CronJob calendar (tier 1 Monday, tier 2 Tuesday…) —
  fallback as an accident of scheduling; a slipped run reorders authority.
- Keep first-writer-wins for the slot and only order the drains — a lower
  tier that answers first (a new tier-1 store enabled later) would then be
  permanent; replacement is what makes the order recoverable.
- Paste the wiki once, or open the dev pod's egress to Reddit — rejected by
  the owner: the backend is what keeps the registry in step with the wiki.
- Crawl the wiki over Reddit's anonymous `.json` path — refused; the official
  API is the route, and it costs one app registration.

## Amendments

- **2026-09-03 — the nopCommerce variant-price extractor, and one listing may
  now write several offers (issue #270, first unattended fleet run).** This ADR
  named the extractor and left it unbuilt, so Small Batch Cigar — a tier-1
  linkout shop — crawled for a night with every offer priceless. Its cigar
  pages are nopCommerce GROUPED products: the parent has no price of its own,
  publishes `offers.price: "0.00"`, and puts one priced row per pack size in the
  page's HTML. Live-read in-cluster: `Sobremesa Solita Short Churchill - Pack of
  5` at $71.00 (`Low stock`) beside `… - Box of 14` at $198.00 (`In stock`).
  - **The source is DECLARED, never sniffed.** An adapter may name a
    `variantPrices` source (`"nopcommerce-variant-overview"` today), read only
    through that declaration, exactly as `productMarkup` and `categorySource`
    are. Small Batch is the only declarer; every other vendor's HTML is never
    read for money.
  - **A grouped listing writes ONE OFFER PER PACK.** Each variant carries its
    own packaging tier through the same `parsePackaging` vocabulary a listing
    name goes through, so each is its own observation series (ADR-009 keys the
    24h dedupe on packaging) and per-stick derives per pack (DESIGN-005). The
    parent writes no offer of its own: it is not a thing for sale.
  - **The placeholder refusal is unchanged.** A parent at `0.00` whose page
    states no pack price is still a placeholder, still stores a NULL price, and
    still fails the probe bar. What changed is that the parent's zero is no
    longer the last word on a page that states prices elsewhere.
  - **A page that carries the vendor's taxonomy and no product is a READ of the
    catalogue.** Small Batch's brand and line indexes sit at one-segment slugs a
    Mode-B gate cannot tell from products, and the drain's shortlist for a
    brand-only ask is made of them. Scoring those looks as `error` (the rule
    written for 2 Guys' gift-registry pages, which carry no structured markup at
    all) meant the ask never retired, the same eight pages were re-fetched every
    night, and `ERROR_BUDGET` would have retired it as `blocked` — "nobody could
    reach this vendor" — about a shop we had read eight pages of. A JSON-LD
    BreadcrumbList with no Product now completes the look as a `miss`.

- **2026-09-03 — a vendor's rate limit is a fact about the vendor, and the
  fetcher honours it (issue #270).** Cigarworld.de's robots.txt names no
  `Crawl-delay`, and its Apache runs a page-view counter regardless: crossing it
  returns `429` with `Retry-After: 6` and a `PageViewCount restriction` body.
  Measured in-cluster, 26 requests at the adapter's 4s interval trips it, and at
  that interval it never recovers — every further request feeds the same window.
  The first unattended fleet drain fetched 29 pages and then took 47 consecutive
  429s, which the run reported as a bare `errors=47`.
  - The polite fetcher now **retries a 429/503 once after the delay the vendor
    named** (default 5s, capped at 60s) and puts that delay on the **shared
    limiter**, not just on the one call — the vendor's rule is about the client,
    not about a URL. A second throttled response is returned rather than thrown:
    one page error is the right price for one page, and a throw costs the vendor
    its whole run.
  - Cigarworld's `minIntervalMs` rises 4s → 8s, the interval a bounded fetch Job
    measured clean. A full seed of its 6,603 gated URLs is therefore ~14.7h and
    needs a deliberately raised page cap and a matching deadline.
  - Run stats gain **`errorKinds`** (`http-429`, `fetch`, `photo`…), printed
    under the count as `errors by kind:`. The previous total was one number over
    three unlike failures with the cause discarded, and diagnosing this one took
    an in-cluster fetch Job to recover a status code the run had already seen.

- **2026-09-03 — the adapters' `crawlEnabled` constants follow the registry
  rows (issue #270).** The operator probed and enabled all eight vendors through
  2026-09-02 while the constants sat at their pre-probe `false`, so the first
  fleet run printed a `vendor posture drift` paragraph for seven of eight
  vendors — none of them a fault, and loud enough to bury a real drift. The
  constants are aligned to the rows the operator chose, and
  `vendor-posture.test.ts` pins each against a transcript of the prod registry so
  the report stays empty. Registration is still insert-if-absent and a new
  adapter still ships `crawlEnabled: false` until its own probe passes: what
  the constant does for an existing row is get compared, and it should agree.
