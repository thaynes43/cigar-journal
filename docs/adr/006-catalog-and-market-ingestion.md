# ADR-006: Catalog seeding and the market subsystem

- **Status:** accepted
- **Date:** 2026-08-26

## Context

No clean open cigar dataset exists. Owner decisions (2026-08-26): seed and
enrich the catalog by crawling the vendor sites he buys from; market features
(periodic price/inventory crawls, price comparison, aggregated review data)
are MVP scope; and no Smoke may exist without a backing catalog Cigar, so
conversational lazy-create is mandatory regardless of crawl coverage.

## Decision

- **Catalog sources, in trust order:** curation (admin UI) > crawl ingestion
  > conversational lazy-create. Lazy-created cigars are `unverified` and
  enter the curation queue; verification and duplicate-merge are
  curator-only, and merges re-point Smokes, Purchases, and Listing Matches.
  The queue's trigram candidate generator inevitably surfaces sibling
  products sharing a brand/line prefix, so two guards keep the backlog
  honest: number-distinct pairs (the resolver's number-token guard — "No. 9"
  vs "T52", "1964" vs "1926") are suppressed automatically, and for wordy
  siblings (Natural vs Maduro) a curator records a **dismissal** ("not
  duplicates") — a persisted, id-ordered pair verdict
  (`duplicate_dismissals`) the queue excludes from then on; rows cascade
  away when either cigar is merged or deleted.
- **Vendor registry is admin-managed data, not config** (owner, 2026-08-26):
  admins add, remove, and per-vendor enable crawling and price display from
  the UI. For Cuban vendors the registry tracks an **approved** status
  synced against the r/cubancigars online-stores wiki — credited on the
  site wherever the approved list appears — via an admin-reviewed diff, not
  a blind auto-sync (the wiki is an input; admins decide). Crawl sources
  need not be approved vendors (Cuban Lou's is crawled for inventory depth
  while off the approved list); data from unapproved sources is labeled as
  such wherever shown.
- **Initial vendors** (owner, 2026-08-26): NC — Fox Cigar, 2 Guys Cigars,
  Cigars International, Small Batch Cigar, Holt's. CC — the r/cubancigars
  approved list plus Cuban Lou's (inventory depth, unapproved). Research
  posture per site, the Reddit-API sync method, and catalog-DB candidates
  (Cigar API + Wikidata) are in
  [`.agents/reference/vendor-sources.md`](../../.agents/reference/vendor-sources.md);
  each adapter still requires a live robots/ToS read from the crawler's own
  environment before it is built. Crawlers work from sitemap enumeration +
  JSON-LD Product parsing (no vendor exposes a structured product API).
- **Crawler:** per-vendor adapters (small, disposable) run as CronJobs via
  the image's `crawl` role, only for registry vendors with crawling enabled.
  Crawl #1 is the catalog seed; subsequent runs append `offers` rows
  (price, stock, seenAt) — an append-only time series. Raw payloads land in
  JSONB for reprocessing; adapters are rate-limited and honor robots.txt.
  A third-party catalog database (product data independent of
  price/availability crawling) remains a research item — if a viable one
  exists, it slots into the trust order alongside crawl ingestion.
- **Listing matching:** vendor listing → catalog Cigar via normalized
  canonical name (plus brand/vitola where known) + trigram similarity;
  confident matches auto-link,
  the rest queue for manual confirmation. Match status (`auto`/`confirmed`/
  `unmatched`) is never silently overwritten by later crawls.
- **Price comparison (MVP):** per-cigar current offers across vendors +
  simple price history from `offers`. **Review aggregation (R11, later):**
  derived descriptors/statistics only — no verbatim third-party review text
  stored (IP exposure).
- **Track separation:** Market never blocks the journal core; it reads
  Catalog and proposes enrichment but never writes Smokes.

## Consequences

The catalog reflects what the owner can actually buy, and every journal
entry has real backing data. Costs: per-vendor adapters rot as sites change
(accepted — small and disposable); cross-vendor matching is the hardest data
problem in the system and the manual queue is the safety valve; unverified
LLM-created cigars accumulate until curated.

## Alternatives considered

- Bulk-import a community/review database — licensing murk, huge irrelevant
  tail, still needs lazy-create; rejected by owner in favor of vendor crawl.
- Manual curation only — breaks the frictionless mid-smoke flow.
- Verbatim review aggregation — IP risk without matching product value.

## Amendments

- **2026-08-29 (owner) — vendor expansion + Cuban Lou's posture.** More NC
  vendors join the initial set (2 Guys Cigars, Small Batch Cigar built as
  adapters alongside Fox). **Cuban Lou's: photos + price seeds YES, purchase
  destination NO** — its offers feed price-at-a-glance/history and its images
  feed product photos, but it is never presented as a place to buy. A new
  `vendors.purchase_linkout` flag (migration 0018, default true) carries this:
  `false` drops the listing link-out and renders the row as plain,
  unapproved-labeled text (Cuban Lou's stays `approval_status='unapproved'`).
  The r/cubancigars online-stores wiki remains the approved-list source via an
  admin-reviewed diff of a locally-supplied snapshot (no Reddit API in this
  lane; never the anonymous scrape path), attributed to the wiki. Provenance
  guard hardened: `listing_matches.decided_by` (migration 0017,
  crawler|curator|agent) makes the crawler preserve ANY non-crawler decision on
  re-crawl, not just `confirmed`.
- **2026-08-29 — adapter crawl-shape capabilities + probe verdict rule.** Live
  in-cluster probes turned up two vendor shapes the single `productPathPrefix`
  field could not express, so the adapter contract gains two generic
  capabilities (the core still branches on FIELD SHAPE, never on a vendor slug):
  - **Product gate, two modes.** Mode A is the prefix that already existed (Fox
    `/shop/`, Cuban Lou's `/` over a product-only sitemap). Mode B is an
    exclusion gate — `nonProductPathPattern` plus `productPathSegments` depth
    bounds — for a store whose products are ROOT-LEVEL slugs with no shared
    prefix (Small Batch). The modes are mutually exclusive in the type. The
    coarse path the robots gate is asked about is now its own concern
    (`robotsProbePath`, default `/`), since Mode B has no prefix to reuse.
  - **Sitemap sampling.** `sitemapSampling: { samples, intervalMs? }` unions N
    root fetches for a vendor whose sitemap CONTENT varies per request (2 Guys:
    1,462 `/store/` locs on one fetch, 6,356 locs with none on the next).
    Opt-in, clamped to 8. For a sampling vendor an empty union FAILS the run
    (`SitemapEnumerationEmptyError`) rather than recording a "succeeded, 0
    listings" row that reads as healthy; a non-sampling vendor still
    succeeds-with-zero.
  - **Probe verdict.** `--probe` now samples up to three index children and
    three product URLs, and passes only when robots allows the gate, the
    enumeration yields product URLs, and at least `min(2, sampled)` product
    pages parse. One parse proves the JSON-LD extractor works but not that the
    enumeration selects products; two prove both, and requiring all three would
    re-import the false negative. The fetcher's page cap for a probe is derived
    from those bounds, not fixed.
  - **The two samples pick differently, on purpose.** PRODUCT URLs are picked by
    a midpoint spread that never returns index 0: the observed false negatives
    were both position-0 index/redirect rows, and sitemaps park those at the
    front. A sitemapINDEX's CHILDREN have no such convention and are picked in
    three ranks. First, catalog-shaped names — `product`/`shop`/`store`/`catalog`
    in the child's FILE NAME, minus the Woo taxonomy names (`product_cat`,
    `product_tag`, `product_brand`) that match the same words while enumerating
    term archives, and which would otherwise fill the budget and crowd out the
    one child holding products. That rank is capped at `budget - 2`. Second, the
    FIRST and LAST child, which a midpoint pick cannot reach past 6 and 7
    children. Third, the interior. The cap is what makes the endpoint guarantee
    real: at a budget of three or more both ends are always fetched, so the name
    hint can only add to the positional pick, never displace a child it would
    have found. A bounded probe still cannot cover a large index: it reports the
    index size (for a sampling vendor, the distinct children the root served
    across samples), the children it sampled, and any child that answered
    non-200, so a `needs-attention` says which it was.
- **2026-08-29 — Wikidata/Wikimedia Commons as an official-API source
  (issue #127).** Brand imagery for the wall's uncovered shelves comes from
  Wikidata (`wbsearchentities`, `wbgetentities`) plus Wikimedia Commons
  (`imageinfo`), under the **same posture this ADR already rules for the
  r/cubancigars wiki**: the official documented API, an identifying
  User-Agent, attributed wherever shown, never bulk republication. It is
  explicitly **not a vendor** — no `vendors` row, no adapter, no sitemap or
  robots-gated HTML walk, and **no `crawl_runs` row** (`crawl_runs.vendor_id`
  is `NOT NULL`; loosening it to admit a non-vendor would erode the vendor
  model). The durable record is the `brand_images` rows plus the run report;
  `brand_images.run_id` is the grouping key if run history is ever wanted.
  `query.wikidata.org` (SPARQL) is deliberately not used: it adds a hostname
  and harsher throttling while answering nothing a claims check does not.
  The class QIDs the disambiguator runs on are **data seeded by a live
  crawl-pod `--brand-images --probe` run**, not guesses — the same
  live-verification rule this ADR imposes on every adapter. An unseeded
  allowlist makes the job **refuse to run** rather than write: with no
  qualifying class every brand would read `no_match`, and that row *is* the
  30-day negative cache, so a seeded follow-up run would then find no work and
  report a clean, empty success. `--dry-run` writes nothing and stays available.

- **2026-08-30 — Mode A gains an optional exclusion (issue #127).** The prefix
  gate is now **prefix AND NOT pattern**: `nonProductPathPattern` is legal on a
  Mode-A adapter, applied after the prefix test. It is still *required* in Mode
  B, where it is the whole gate; the mode discriminator is therefore
  `productPathPrefix`, not "carries a pattern". `productPathSegments` and
  `robotsProbePath` stay Mode-B-only — a depth bound on a prefix adapter would
  be an unbacked guess at that vendor's product depth, and the robots gate must
  keep asking about the coarse prefix even when the URL filter is narrower.
  - **Why.** A prefix broad enough to be right can also be broad enough to admit
    a non-catalog subtree. 2 Guys' `/store/` is the correct product prefix and
    also matches `/store/go/registry/<n>/`, gift-registry pages. The alternative
    — inventing a tighter prefix — is the same class of guess that produced the
    defect, and we have zero live-confirmed 2 Guys product URLs to write one
    from. Moving the vendor to Mode B is worse still: it would drop a shared
    prefix we *have* confirmed and force the pattern to enumerate every
    non-product family on the site.
  - **Standing requirement for EVERY `nonProductPathPattern`, both modes.** Each
    top-level alternative anchored at `^`; every reserved word terminated at a
    full segment boundary `(?:\/|$)` and **never** `\b`; no `g`/`y` flags. `\b`
    also fires at a hyphen, which is how Small Batch's `^\/cart\b` silently ate
    `/cart-blanche-robusto/`. The asymmetry is the reason: under-matching only
    wastes fetches (normalize + `isCigarListing` still gate the writes), while
    over-matching drops real products with no note, error or stat. The runtime
    guards in `product-url.test.ts` now run on any adapter carrying a pattern,
    in either mode; scoping them to Mode B would have shipped the first Mode-A
    pattern unguarded.
  - **The 2 Guys facts behind it (in-cluster probe, 2026-08-30).** robots
    unchanged and permissive. The 2026-08-29 sitemap content variance did **not**
    reproduce: four samples returned an identical 6,356 locs, `new=6351/0/0/0`,
    `varied=no`. Sampling is nevertheless kept — one clean observation does not
    disprove an intermittent behaviour, and three extra root fetches are noise
    against a multi-hundred-page walk. The gate was the real blocker: 1,462 locs
    passed `/store/`, and all three spread picks were registry pages with no
    Product JSON-LD, so `parsed=0`. That `needs-attention` was **true but
    misattributed** — it read as "this vendor has no JSON-LD" when the fault was
    the enumeration. The crawl consequence was larger than the probe's: a seed
    run would have fetched ~1,400 customers' registry pages at >=2.5s each, a
    courtesy problem as much as a wasted-budget one, and the reason the fix
    belongs in the gate rather than in the probe's sampler.
  - **Probe diagnosability.** `--probe` now prints a **path-shape census**: the
    commonest first-two-segment keys among the URLs the gate accepted and among
    those it rejected, with a `(+N keys, M urls)` tail. It is pure computation
    over URLs already fetched — no extra requests. It exists because the live
    verification this ADR mandates costs an in-cluster Job per round-trip: the
    census would have named `/store/go` on the first probe, and where a gate
    admits nothing it names where the products actually live instead of
    requiring another run to find out.

- **2026-08-30 — a vendor's catalogue is PARTIAL (owner ruling; issue #158).**
  A vendor carries some brands and not others. That is the normal case, not a
  defect and not a crawl failure. Concretely: Red Anchor is stocked by 2 Guys
  and not by Fox, and both are NC US retailers in good standing. Everything
  downstream of this ADR had been built as if any enabled vendor could satisfy
  any cigar, which is how the enrichment attempt budget ended up vendor-blind.
  Five consequences, each load-bearing for the code:
  - **`focus` is a coarse MARKET signal, never a coverage guarantee.** It is
    sound as a *negative* filter — a CC-only vendor will not carry an NC cigar,
    so never spend a look there — and unsound as a positive one. `focus` says
    which market a vendor trades in; it says nothing about which brands within
    it. The registry has no brand-coverage field and deliberately gains none:
    it would be hand-maintained fiction, and it would rot the first time a
    vendor changed stock.
  - **"No match at vendor V" is evidence about V only.** Never about the cigar,
    never about the canonical name, never about any other vendor. This is the
    sentence the code has to obey, and the one every rule below is derived from.
  - **Therefore an attempt budget, a staleness rule, or an `exhausted` state
    that does not NAME A VENDOR is meaningless.** A single `EXHAUST_ATTEMPTS = 2`
    shared across a growing fleet is a request retired after one look from each
    vendor — a cigar Fox will stock next week, permanently retired on Tuesday
    because Cuban Lou's looked first. Retirement is per (request, vendor), never
    per request; the request-level state is a rollup over those, and it must be
    RECOMPUTABLE rather than merely stored, because its denominator changes
    without any request being touched. Migration 0023 adds `enrichment_attempts`
    for this; `enrichment_requests.status` becomes a cache of the rollup.
  - **THE DENOMINATOR IS LIVENESS, NOT `crawl_enabled`.** One sentence, to be
    checked against the code: *a request is `exhausted` when at least one lane
    counts against it and every counted lane has completed its full attempt
    budget on it — where a lane counts if it is crawl-enabled, its focus covers
    the cigar's market, and it has either finished an `enrich` run or already
    recorded a look at this very request.* `crawl_enabled` cannot be the
    denominator: no crawler consults that flag (issue #156 — the CronJob list is
    the real crawl gate), so flipping it true schedules nothing and a vendor
    enabled in the registry with a suspended lane can never fill it. Note this
    amendment makes the coverage rollup the column's FIRST reader, and only as a
    negative filter: turning it off drops a vendor from the fleet, turning it on
    still does not make one run. That asymmetry is the point — it is exactly why
    the flag can gate who is *listed* and never who has *looked*. Prod is exactly
    that shape: Cuban Lou's is crawl-enabled with a suspended enrich CronJob and
    only a `seed` run, and it sat in the denominator of every untyped cigar —
    890 of 977 catalog rows. Never `exhausted`, therefore permanently
    `already_queued`, therefore permanently out of `retryExhausted`'s reach.
    The earlier draft of this amendment called liveness-as-denominator circular.
    It is not: **the drain does not gate on liveness** — its open set admits
    `exhausted` rows and its only per-vendor filter is that vendor's own budget
    — so a lane that has never run still picks work up on its first night, and
    reopens what it has not looked at. The second clause (a look already recorded here) exists because a
    lane's own first run is still `running` while it drains, and without it that
    first night would read as a lag in the cached status. **Live** read as
    MARKETS stays the queue gate, unchanged; it is the same predicate at a
    different granularity, not a second one.
  - **Zero counted lanes is NOT exhaustion, and neither is a burnt error
    budget.** "Nobody could look" is a different fact from "we looked and found
    nothing", and laundering one into the other is exactly what this amendment
    forbids. Two distinct states, neither of them `exhausted`:
    **open** — no lane counts at all; the request stays open and self-heals when
    a lane goes live.
    **blocked** — every counted lane is retired, but at least one burned
    `ERROR_BUDGET` without finishing a look. Its ledger holds zero completed
    looks, so `exhausted` next to a `triedVendors` list would read as a catalogue
    fact that was never established. It surfaces as `vendor_unreachable` on the
    backlog press and is cleared by the same `retryExhausted`, which files a
    fresh ask with a fresh error budget. A single eligible vendor whose sitemap
    404s for three nights is this state, not exhaustion.
  - **Two photo tiers, never conflated (owner, 2026-08-30).**
    **Catalogue photo** — `product_photos`, `cigar_id` UNIQUE + `vendor_id` +
    `source_url`: exactly ONE per catalog cigar, vendor-sourced at crawl,
    third-party bytes under the `rights` gate (`pending`/`approved`/`suppressed`)
    and the per-vendor rights posture this ADR already sets. It is the product's
    identity shot, not a picture of anyone's cigar.
    **Review photos** — `smoke_photos`, `smoke_id` + `user_id` + `kind` +
    `caption`: MANY per smoke, and many smokes per cigar. Owner-authored, no
    third-party rights story, never a display substitute for the catalogue photo
    and never promoted into `product_photos`.
    So one generic catalogue entry with one vendor photo sits under an unbounded
    fan of owner review photos. **Enrichment fills the first tier only:** a cigar
    with forty review photos is still `productPhoto`-missing and still a
    legitimate enrichment request. The rights asymmetry is why the tiers cannot
    share a table — suppressing a vendor's bytes must never touch a user's
    photographs — and it is why a partial catalogue matters at all: the photo a
    request exists to fetch can only come from a vendor that stocks the cigar.
  - **The live probe that motivated this** (2026-08-30, in-cluster Job on the
    v0.27.0 crawl image, against 2 Guys Cigars). Two facts, both recorded
    because they are the concrete instance of the ruling above:
    **(1) The sitemap variance is gone.** Four samples returned an identical
    6,356 locs with `varied=no`; the 1,462-vs-0 alternation recorded on
    2026-08-29 did not reproduce. The sampling added for that alternation works
    and is no longer what blocks this vendor.
    **(2) The `/store/` product gate is wrong.** The prefix also matches
    `/store/go/registry/<n>/` — gift-registry pages with no `schema.org/Product`
    — so the spread sampler drew three of them and the probe returned a FALSE
    `needs-attention` on the product check over a TRUE failure of the gate. The
    adapter had been tuned as if enumerating a vendor's URLs were the same as
    enumerating its products. Correcting the gate was its own change (PR #179,
    the Mode-A exclusion amendment above); it did not ride the ledger work, and
    enabling 2 Guys is deliberately NOT how the per-vendor design is validated —
    the reopen path lands it automatically when 2 Guys does come up.
  - **What that shape means for the miss/error line, and it is not what the first
    draft of this amendment said.** 1,462 locs passed the gate and every one of
    them ANSWERED 200; they simply carried no Product, so `parsed = 0`. An
    over-matching gate therefore produces a large enumeration of reachable pages,
    not an empty one — so a rule that only calls an empty enumeration an `error`
    scores this as a `miss`, burns two real attempts, and then reports "2 Guys
    looked and does not carry it": manufactured evidence about a vendor, which is
    the thing this amendment exists to forbid. **The line between a completed
    look and a failed one is a PARSED PRODUCT, not a 200** — the same `parsed`
    count `--probe` reports, and the signal that was true on the live probe while
    the `needs-attention` beside it was misattributed. Three shapes are `error`:
    an empty enumeration, no candidate that answered 200, and candidates that
    answered 200 with nothing a product parser could read. A parsed product that
    is an accessory, or that misses the similarity floor, is a MISS: we did read
    the vendor's catalogue, and what it holds is not this cigar. "No candidate
    scored above zero" is a miss too — the enumeration IS the vendor's product
    list, and nothing in it resembled the cigar. **The residual, stated rather
    than papered over:** that last rule assumes the enumeration really is
    products, and a broken gate can defeat it, because zero ranked candidates
    means zero fetches and so nothing for the parsed-product test to run on. No
    drain-time check can close that; the pre-enable `--probe` and its path-shape
    census are what close it, which is why this ADR requires live verification
    before a vendor is enabled and why a gate correction never rides a ledger
    change. Widening the rule instead — calling "nothing scored" an error —
    would mean a vendor that simply does not stock a brand could never retire
    the request, which is the hang this amendment exists to remove.
- **2026-08-30 — the evidenced market, write authority, and per-request lane
  liveness (issues #170, #157, #155, #185).** The 2026-08-30 per-vendor ledger
  amendment above put ONE market predicate in the drain and the rollup. That was
  necessary and not sufficient: the predicate read `cigars.type`, and 884 of 971
  active catalogue rows have no type. The rest of this entry is what the same
  ruling looks like once it is applied to the catalogue we actually have.
  - **Three predicates, named and separated.** They had been one word,
    "coverage", and collapsing them is what let a CC-focus vendor fill an NC
    cigar's one catalogue-photo slot:
    **(1) Eligibility** — who MAY be asked? A liberal negative filter
    (`coversMarketSql`), in the vendor fleet and the drain's open set.
    **(2) Queue gate** — may we file an ask at all? A conservative positive
    claim (`liveEnrichMarkets`, `marketCovered`), at enqueue time.
    **(3) Write authority** — may THIS vendor write THIS artifact to THIS
    cigar? At the write sites, and **split by reversibility** (below).
    Predicates 1 and 3 read the evidenced market; predicate 2 deliberately does
    not (see the stated inconsistency below).
  - **The evidenced market.** `cigars.type` is not the cigar's market — it is the
    market someone RECORDED. So: *the evidenced market is `cigars.type` if set;
    else the single market shared by every single-market vendor that already
    stocks the cigar; else unknown.* This is not a new inference, it is this
    ADR's own negative filter run backwards: the ADR already rules that a CC-only
    vendor will not carry an NC cigar, so an NC-only vendor stocking X means X is
    not CC. A `focus='both'` vendor contributes nothing (a both-market vendor
    stocking a cigar says nothing about its market), and disagreeing sources
    resolve to unknown rather than to a winner. On prod it resolves 878 of the 884
    untyped rows — 821 Fox-only to NC, 56 Cuban Lou's-only to CC — with no new
    column, no backfill and no hand-maintained coverage table, which this ADR
    forbids. It **self-heals**: every crawl that links a listing sharpens it, and
    `cigars.type` overrides it outright, so a curator always has the last word.
    A wrong auto-link — the very defect #170 is about — does become evidence, and
    that is bounded in the right direction: the value can only ever EXCLUDE a
    vendor, never authorize a write its own focus would not already allow. The
    failure mode is an ask the right vendor is never sent, which surfaces as an
    open row naming who is awaited, not as a wrong photo.
  - **Write authority, split by reversibility.** The two crawler writes are not
    the same kind of thing. `listing_matches` + `offers` NAME their vendor, are
    revisable by a curator (`decided_by` already protects a non-crawler verdict)
    and are re-written on the next crawl. `product_photos` is `UNIQUE(cigar_id)`,
    inserted `onConflictDoNothing`, and **nothing in the crawler ever deletes
    one**: one global slot, first write wins, forever. So:
    *a vendor may LINK to a cigar when its focus does not CONFLICT with the
    cigar's evidenced market (unknown permits); it may fill the cigar's single
    catalogue-photo slot only when the evidenced market is KNOWN and its focus
    covers it.* A vendor with no single market (`both`, or no recorded focus) has
    none to conflict with, so the guard is inert for it rather than asserting an
    authority the market predicate does not have — the moment such a vendor is
    added, #170 reopens for that lane, and no guard here can close it.
  - **Self-evidencing (option A), and its residual.** The photo guard reads the
    market AFTER the listing match is committed, so a single-market vendor that
    links a cigar nobody else stocks becomes its own sole evidence and may
    photograph it. That costs the working Fox lane nothing while still refusing
    the conflict case. **The residual, stated:** the first vendor to discover a
    cigar can always photograph it, so a CC lane that name-matches a Nicaraguan
    brand nobody else stocks still fills the slot. Closing it needs INDEPENDENT
    evidence — `cigars.type`, or a different vendor already stocking it — which
    trades catalogue completeness for the photo tier's integrity and is an owner
    call, not one this lane made.
  - **`findCatalogMatch` is the other half, and the half that already fired.**
    Both live cross-market rows in prod came from the seed/offers path, not from
    the drain: `Petit Royales Romeo y Julieta` (`type='CC'`) auto-linked by an
    NC-focus vendor to its Altadis `Romeo y Julieta 1875` listing, and a Cuban
    Lou's listing match plus offer on the Fox-created `Romeo y Julieta Mini Red
    Aroma`. The guard there REJECTS the candidate rather than re-ranking to the
    best market-compatible one: rejection can only remove a link, while
    substitution could invent new ones, and the 0.55 similarity floor is a
    verified false-positive source. In `seed` mode a refusal falls through to
    creating a cigar, which is the right answer — a listing whose market
    contradicts its best match is a different cigar.
  - **The 0.55 floor is untouched, deliberately.** `similarity('Romeo y Julieta
    Mini White Original', 'Romeo y Julieta Mini') = 0.5833` is a real
    within-market false positive and a separate defect. The market predicate
    rejects CROSS-market mis-matches only; shipping it does not make mis-matching
    solved, and folding a threshold change in here would let it ride as a market
    fix.
  - **One runner per (vendor, mode) (#157).** The atomic ledger increment means
    no look is lost, but two overlapping same-vendor runs still select the same
    rows and fetch them twice — burning both nights of `ATTEMPTS_PER_VENDOR` in
    one evening and doubling the polite load on the vendor. The fix is a
    session-level advisory lock per (vendor, mode), held for the whole run; not
    acquired means log, exit 0, and **write no `crawl_runs` row** (a row for a run
    that looked at nothing is a lie in the audit, and liveness is read from
    succeeded enrich runs). `FOR UPDATE SKIP LOCKED` is the wrong tool one level
    down: the drain holds each request across seconds of deliberately polite HTTP,
    so a row lock would be held across network I/O for minutes. Per (vendor,
    MODE) because Fox's 04:00 `offers` lane has a 9,000 s deadline and can still
    be running at 06:00 — a per-vendor lock would make a correctness fix silently
    cancel a nightly job. **Known bounded cost:** a pod lost with its node can
    leave a half-open connection holding the lock until Postgres reaps the
    backend, and that lane skips until then. It self-corrects with no manual step.
    **No reaper for `in_progress`:** the drain stopped writing that state and 0023
    normalized the legacy rows, so a reaper would guard a state nothing writes.
  - **Stranded runs (#155), in two layers.** A signal handler closes the graceful
    case — `activeDeadlineSeconds` sends SIGTERM and waits out the grace period —
    with one idempotent `UPDATE ... WHERE id = $1 AND status = 'running'`, which
    is what makes it safe to race with normal completion. A startup sweep closes
    the ungraceful case (SIGKILL, OOM, node loss). The sweep carries **no age
    ceiling** and needs none: it runs under the lane lock, so by construction
    nothing else can be running this lane and a `running` row for this (vendor,
    kind) is stranded rather than concurrent. That is strictly better than a
    ceiling, which would be a constant that has to track the slowest legitimate
    run and is wrong on both sides of the guess. Neither layer can corrupt the
    exhaustion denominator: liveness reads only `succeeded`, so the sweep moves a
    row between two equally uncounted states.
  - **Liveness is per REQUEST, not per vendor (#185).** "Has this lane ever run an
    enrich pass?" is monotone: once true it is true forever, so a lane that runs
    once and stops counts against every ask filed afterwards and none of them can
    ever reach `exhausted` — nor, therefore, `retryExhausted`. A lane now counts
    against an ask when it has already recorded a look there (the clause that
    carries a lane's own first night, while its run row is still `running`) **or**
    it started a succeeded enrich run since the ask was created. **`started_at`,
    not `finished_at`:** the drain's open-set SELECT happens near the start of a
    run, so a run that began before the ask existed never saw the row however late
    it finished.
  - **What #185 does NOT fix, and why no better proxy ships.** An ask filed
    *before* a lane's last run that the lane never reached still counts that lane,
    forever. At `ENRICH_DEFAULT_LIMIT = 10` a lane reaches ten asks a night, so on
    prod's shape that residual is most of the queue: the rule fixes the inflow and
    almost nothing of the standing backlog. A **recency window** ("count only if
    the lane ran in the last N days") would close it and is **rejected**: it needs
    a constant tracking the slowest lane's schedule, has to be revisited on every
    cadence change, and is still a proxy for the thing #156 will actually record.
    What ships instead is visibility plus the lever that already exists — the
    backlog press now reports `awaitingVendors` on `already_queued` rows, naming
    the counted lanes that owe a look, and `crawl_enabled = false` on a suspended
    lane drops it from the fleet and frees every ask it was holding, today, with
    no migration. #156 remains the real fix.
  - **`liveEnrichMarkets` stays monotone, and the asymmetry is deliberate.** The
    queue gate is evaluated at ENQUEUE time, when the ask does not exist, so "has
    a lane run since now?" is never true and a per-request rule there would refuse
    every ask forever. The postures differ because the costs of being wrong
    differ: a stale `true` in the gate only PERMITS filing an ask, which stays
    open and self-heals; a stale `true` in the denominator BLOCKS retirement
    forever. Monotone is acceptable for a gate that opens a door and unacceptable
    for a counter that closes one.
  - **A real inconsistency, recorded rather than left implicit.** `marketCovered`
    — the enqueue gate — still reads `cigars.type`, while the drain and the
    exhaustion denominator read the evidenced market. On the evidenced market the
    gate would accept prod's 821 Fox-evidenced untyped rows the moment it shipped:
    ~800 new asks and, at ten a night, months of nightly Fox crawling. That is a
    crawl-volume and vendor-courtesy decision, not a correctness one, and it wants
    the owner's sign-off in its own change. Until then the enqueue gate and the
    exhaustion denominator read the market from two different sources, which is
    defensible only because they are different predicates with opposite postures.
  - **Rejected alternative: backfill `cigars.type` from vendor focus.** Writing an
    inferred market into a curator-trust-order, user-visible field from a signal
    as coarse as a vendor's focus is manufacturing catalogue facts, which this ADR
    forbids. It would also freeze at the moment it ran, while the derived value
    sharpens with every crawl and is overridden the moment a curator types the
    cigar. Migration 0025 adds two read-path indexes and writes nothing.
  - **Two live rows are NOT repaired here.** `Petit Royales Romeo y Julieta` is
    still linked to Fox's `/shop/cigars/romeo-y-julieta-1875-petit-bully-2/`, and
    Cuban Lou's still holds a listing match and an offer on `Romeo y Julieta Mini
    Red Aroma`. This change makes both unreachable going forward and repairs
    neither; a curator ruling and a follow-up are required, or the fix will read
    as ineffective.
