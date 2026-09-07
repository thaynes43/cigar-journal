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

- **2026-09-07 — every reported reason carries the error's `cause` chain
  (issue #270).** The 02:00 enrich fleet reported 2 Guys as `status=failed` /
  `error: fetch failed`, which read as an upgrade regression; the shop's TLS
  certificate had expired, and Node's fetch says that same sentence for a dead
  host, a DNS failure and a bad certificate alike, parking the fault on `cause`.
  Every summary site — the run-fatal `error:` line, the per-kind `errorSamples`
  reasons, the fleet roll-up, and the `crawl_runs.error` column — now formats
  through one `describeError` helper that appends the chain, code first:
  `fetch failed (CERT_HAS_EXPIRED: certificate has expired)`. Bounded at five
  causes and cycle-safe, so the line stays one line.

- **2026-09-06 — a page budget is not an outage, and the error line now says
  what the errors were (issue #270).** The first unattended fleet **offers** walk
  reported five-figure error counts on vendors where nothing had failed: Small
  Batch `errors=10453`, 2 Guys `errors=3357`, Cigarworld `errors=6101`. Every one
  of them was the enumeration the run never got to, and 2 Guys is the case that
  proves it with no residual: its own `sitemapSampling.productLocs` is **3852**,
  its four sitemap samples plus robots spent 5 of the 500-page budget leaving
  **495** product fetches, and `3852 - 495 = 3357` — the reported error count,
  exactly. `adapter.maxPages` is a safety cap the
  fetcher enforces by **throwing**, and the seed/offers walk wrapped the fetch and
  everything downstream of it in a single `catch` that counted any throw as one
  `fetch` error — so a capped vendor spent its budget and then charged itself one
  error for each of the thousands of URLs it never reached.
  - The walk now **breaks** on `MaxPagesExceededError` and records the remainder
    as **`locsBeyondBudget`**, reported on its own line. A non-zero value is a
    capacity statement — this vendor publishes more than one run can walk — whose
    fix is a raised cap plus a matching deadline, or the resumable chunking still
    tracked under #270. It is never a failure.
  - The single catch is split: `fetch` keeps its meaning (a throw out of the
    fetcher), and a throw **after** the page is in hand — parse, normalize, or the
    write — is the new kind **`ingest`**. Counting the second as the first said
    "we could not reach the vendor" about a vendor we had just read.
  - `errorKinds` gains **`errorSamples`**: up to five exemplars *per kind*, each a
    URL and a reason (`ECONNRESET`, `timeout`, `status 429`), printed one per line
    under `errors by kind:`. The 2026-09-03 amendment below made the error line
    say *how many of what shape*; it still could not say what any of them
    actually said, which is the question an operator asks first. Per-kind rather
    than per-run, so a flood of one kind cannot crowd out the only instance of
    another.
  - Why this mattered on the night: the same run was Small Batch's **real**
    failure — 500 pages fetched, **zero listings parsed** — and a summary that
    cannot tell a budget from an outage is exactly the summary that buries it.

- **2026-09-06 — a page budget applied to an ordered enumeration is a permanent
  truncation, and for Small Batch it truncates to zero (issue #270).** The same
  fleet offers walk that produced the phantom errors above also produced Small
  Batch `pages=500 listings=0 offers=0`, and that half was real. Diagnosed live
  in-cluster: the site is healthy — robots 200, sitemap 200 with 11,290 locs,
  every product page 200 with `cf-mitigated: null`, no challenge, no changed
  markup, no broken selector.
  - **The sitemap is in nopCommerce entity order — categories and brand/line
    landing pages first, products second** — and `filterProductUrls` preserves
    document order. Bisected live: the **first 2,123 gate-accepted URLs are all
    landing pages**, which answer 200 with a `BreadcrumbList` and no `Product`,
    so `extractProductMarkup` returns null and the walk drops them **silently**
    — no listing, and correctly no error. `maxPages: 500` buys robots + sitemap +
    498 landing pages, and the walk stops **1,625 URLs short of the first
    product**. It is deterministic: it would have done this every Sunday forever.
  - **No gate can fix it.** Brand pages (`/caldwell`), line pages
    (`/all-pro-series`) and products (`/powstanie-sbc26`) are all one-segment
    slugs with identical `changefreq`, as the adapter already documents. The cap
    also cannot simply be raised: a full pass is 10,951 × 3s ≈ **9.1h** against
    the fleet CronJob's 8h `activeDeadlineSeconds`, shared serially by nine
    vendors. **The fix is the resume cursor** — `vendors.crawl_cursor` already
    exists and halfwheel already uses it — which turns `maxPages` into a chunk
    size instead of a wall. That is the #270 resume/chunking item, and it is now
    load-bearing rather than a nicety.
  - **`--probe` cannot catch this, structurally.** The probe samples *spread*
    indices and the walk takes *document order*, so the probe passes on a vendor
    whose offers walk yields nothing. A probe verdict is evidence about a
    vendor's markup, never about what a budgeted walk will reach.

- **2026-09-06 — two vendors were publishing facts the extractors could not
  see (issue #270).** Both found while diagnosing the walk above, both confirmed
  against the live pages and against what the run actually wrote.
  - **J.J. Fox stock.** Its pages carry
    `<meta itemprop="availability" content="https://schema.org/InStock">` — and
    only that. `metaContent` identifies a tag by `property ?? name`, which is all
    of OpenGraph and none of schema.org microdata, so all 223 offers were written
    `in_stock = NULL`. Not "out of stock": **unknown**, on a vendor that said so
    on every page. Availability now falls back to an `itemprop` read; OpenGraph
    still wins where both exist, so no working vendor changes.
  - **Montefortuna price.** Its `priceSpecification` is neither a spec nor an
    array of them but an object wrapping one under the numeric key `"0"`, with a
    *different* `priceCurrency` on the wrapper. `firstOf` returned the wrapper,
    whose only own scalar is that currency — so all 194 offers were written
    `price = NULL` with `currency = 'EUR'` on pages showing `$446`. The
    specification is now resolved one level down to the node that carries a
    price, **and the currency is taken from that same node**: a number labelled
    with a neighbour's currency is worse than no number, because the display
    layer would believe it. Nothing was dropping the price on tier grounds —
    tier 2 is a *display* rule, applied at read time, not a write-time refusal.

- **2026-09-06 — the seed/offers walk resumes from `vendors.crawl_cursor`: a
  page budget is a chunk, not a wall (issue #270).** The amendment above
  diagnosed the truncation and named the fix. This is the fix, and it is what
  makes a vendor larger than one run reachable at all.
  - **The walk starts after the last URL the previous COMPLETED run of the same
    vendor+mode reached**, and wraps to the top when the enumeration ends.
    `seed` and `offers` carry separate positions — separate budgets, separate
    `crawl_runs` histories — and `enrich` carries none: it drains the gap-fill
    queue with targeted lookups and walks no enumeration at all.
  - **The position is a URL, not an index.** Sitemaps change between Sundays: a
    shop that adds nine products at the top shifts every index below them, and
    an index cursor would skip nine URLs — or re-walk nine — with nothing able
    to notice. A URL is checkable. On resume it is looked up in the FRESH
    enumeration and the walk starts after it; a URL the vendor has retired
    resolves to nothing, so the walk starts from the top and SAYS SO
    (`cursorMissing`) rather than restarting in silence. It also survives a
    sampling vendor whose enumeration order genuinely varies between runs, which
    no index could.
  - **One jsonb, three lanes, and every write MERGES.** The column now holds
    `{"archivePage": 87, "offers": {"lastUrl": …, "total": …, "finishedAt": …}}`.
    The reviewer's cursor (#199) and a shop's position share the row, so a
    whole-object write from either lane would send the other back to the top of
    its walk. No migration: 0038 made the column deliberately uninterpreted, an
    existing `{"archivePage": N}` reads unchanged with the shop key simply
    absent, and there is nothing to backfill.
  - **Written only in the run's completion transaction**, exactly as the review
    cursor is. A failed or deadline-killed run leaves the cursor where it was
    and re-walks that chunk — a cursor advanced by a run that then died would
    skip those pages in silence, which is the one failure mode a resumable walk
    has.
  - **A wrap is a full pass.** Reaching the end of the enumeration inside the
    budget resets the position to the top (an explicit `lastUrl: null`, keeping
    the pass's length and finish for the record) and records `passCompleted` in
    the run stats. That stat is how an operator tells a vendor one run covers
    from a vendor that has only ever seen its first 500 URLs.
  - **`--from-top` and `--limit`.** `--from-top` ignores the stored cursor for
    one run — re-reading a vendor's head after a reshuffle — and still records
    where it stopped: skipping the read is a one-run decision, skipping the
    write would pin the lane at the top permanently. `--limit N` takes the next
    N FROM the resume position; a limited run that re-walked the head of the
    sitemap every time is the defect this change exists to remove. The summary
    line is `walk: resumed at 2,124 of 10,951 (cursor <url>)`, or `from top`,
    plus `pass completed` when it wrapped.
  - **Operator seed — Small Batch, once, after this deploys.** Nothing seeds a
    cursor automatically, and a lane with no stored position starts at the top:
    for Small Batch that is one more 500-page pass through landing pages. The
    boundary was bisected live on 2026-09-06 in the sitemap's gate-accepted
    order — `accepted[2122] = /all-pro-series` is the last landing page,
    `accepted[2123] = /powstanie-sbc26` the first product — so seeding the
    offers cursor to "after `/all-pro-series`" puts the very next chunk on
    products:

    ```sql
    UPDATE vendors
       SET crawl_cursor = coalesce(crawl_cursor, '{}'::jsonb)
                          || jsonb_build_object('offers', jsonb_build_object(
                               'lastUrl',    'https://www.smallbatchcigar.com/all-pro-series',
                               'total',      10951,
                               'finishedAt', '2026-09-06T00:00:00.000Z'))
     WHERE name = 'Small Batch Cigar';
    ```

    `total` and `finishedAt` are provenance only — the resume reads neither —
    and the URL must match the sitemap's `loc` byte for byte. That is what makes
    the seed self-checking: the next run's summary must read `walk: resumed at
    2,124 of …`, and `from top … gone from the enumeration` there means the
    string missed and the seed should be re-applied with the loc as published.

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
