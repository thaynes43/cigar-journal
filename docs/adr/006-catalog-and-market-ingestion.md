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
  *Amended 2026-08-31 by ADR-012 — see "matching v2" below.* The
  name-plus-trigram resolver is retired; status handling is unchanged.
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

- **2026-09-02 — vendors are TIERED, and three of this ADR's rules are now read
  through the tier (ADR-015, issue #270).** Nothing here is retracted; what
  changes is the ordering laid over it. `vendors.tier` (migration 0034, 1 is
  highest) decides (a) which vendors' offers are DISPLAYED — prices are recorded
  from every crawled vendor and shown only from tier 1, through the
  `display_enabled` gate this ADR already defines; (b) who the enrich drain asks
  FIRST — a vendor of tier *t* may take an ask only once every enabled
  higher-tier vendor that covers the ask's evidenced market has looked and
  missed, so the per-vendor ledger below is what fallback is computed from; and
  (c) the one catalogue-photo slot, which stops being first-writer-forever — a
  higher-tier capture REPLACES a lower tier's photo (never the reverse, and
  `rights = 'suppressed'` and a curator's upload are final whatever the tier).
  The `--vendor` CLI gains `--all-enabled`, which walks the enabled fleet
  serially in tier order in one process (closes #156), because that ordering is
  what makes fallback a property of one run rather than of a CronJob calendar.
  Catalog STRUCTURE is untiered: a seed walk from any enabled vendor may still
  create brand/line/leaf rows under matching v2's alias-anchored resolution. See
  ADR-015 for the decision and its alternatives.

- **2026-09-01 — "curator outranks crawler" was written about a HUMAN, and a
  reasonless bulk agent unmatch is not one (issue #245).** The amendment above
  fixed which pages the drain fetches. This one fixes what it is allowed to write
  when it gets there, and the two together are what make an enrich look capable
  of finishing. `upsertListingMatch` returned any `decided_by != 'crawler'` row
  untouched, so the drain read `match.status === 'auto' && match.cigarId ===
  ask.cigarId` as false and returned `declined` → scored `miss`. Note the
  asymmetry that hid it: `existingCrawlerLink` returns null for a non-crawler
  row, so the candidate cleared admission, the page WAS fetched and parsed, and
  the refusal landed at the last step — a miss that burns one of
  `ATTEMPTS_PER_VENDOR` with the vendor genuinely read, which is a *plausible*
  verdict rather than an obviously false one and therefore worse to spot.
  - **What the 883 rows actually are, checked before the rule was changed.**
    `audit_log`, action `listing_match.set_status`, 2026-08-29 16:17 → 2026-08-31
    10:22: **883 rows, every one `actor='agent'`**, zero `curator`, across exactly
    three `run_id`s — `wo-cigar-curate-20260829` (291 rows in 33 s),
    `wo-cigar-curate-20260830` (300 in 71 s), `wo-cigar-curate-20260831` (292 in
    36 s). Roughly nine verdicts a second: three curation-lane bulk batches, not a
    human working one at a time. Each `before`/`after` pair shows a crawler `auto`
    link being cleared to `unmatched` with `cigar_id` null and **no
    `unmatched_reason`** — nobody wrote down why, because there was nothing to
    write down. Prod's whole `listing_matches` table is three shapes: 994
    `crawler/auto`, 883 `agent/unmatched` (reason null, cigar null), 4
    `crawler/unmatched`. **There is not one `decided_by='curator'` row on prod.**
  - **The ruling: scope the guard to the verdict's MEANING** (issue #245 option
    1). An agent `unmatched` carrying neither a reason nor a cigar says "nothing
    in the catalogue explained this listing" — a report on the catalogue at the
    moment it was swept, not a refusal of a link that did not exist yet. A later
    enrichment ask is catalogue state that moment did not have, so the enrich
    drain — **only the drain, only on `unmatched` → `auto`, and only into a row of
    exactly that shape** — may claim it. Everything else stays untouchable, and
    each for its own reason: a `decided_by='curator'` row because the original
    rule is about human authority and still holds; an agent row carrying a reason
    because someone recorded WHY, which is intent; an agent row carrying a
    `cigar_id` because it points somewhere, and repointing it is the theft
    `existingCrawlerLink` already guards against one authority over; any
    `confirmed` row, ahead of all of it. The entitlement is an explicit
    `claimAgentUnmatched` flag passed by the single call site in
    `tryEnrichCandidates` — the seed and offers walks pass nothing and are
    refused exactly as before, so a re-crawl still cannot touch an agent verdict.
  - **A claim RETURNS THE ROW TO THE CRAWLER** (`decided_by='crawler'`), rather
    than writing a link under an authority that did not write it. That is what
    keeps the claim from being a one-way door: an ordinary crawler-owned row is
    re-decided by matching v2 on every re-crawl and re-annotated by the seed walk,
    where a claimed row left as `agent` would be frozen forever. It also
    incidentally converges with option 3's data outcome, one row at a time and
    only where an ask paid for the evidence, with no migration.
  - **The supersession is audited, because it is the only write in `match.ts`
    that overrides another actor.** It emits `listing_match.set_status` with the
    crawler's established shape — `actor='import'`, null `user_id`, the
    `crawl_runs` id in `run_id` — and the `before` snapshot carries
    `decided_by='agent'`, `status='unmatched'` and the null `cigar_id`, which is
    the whole of the verdict being replaced. It cannot ride the existing unlink
    condition (`row.cigar_id != null && changed`): a claim's prior `cigar_id` is
    null by definition, which is precisely what that test excludes.
  - **What this does to the amendment below.** That one measured the drain's
    reach as "only **4 listings of 1,881** are crawler-owned and unclaimed" (Fox
    930 `crawler/auto` / 865 `agent/unmatched` / 4 `crawler/unmatched`; Cuban
    Lou's 64 / 18 / 0) and concluded the drain's job is UNCLAIMED-LISTING
    COVERAGE. The census was right and the conclusion was drawn one ruling too
    early: 883 of those 887 claimed-and-unreachable rows were never a verdict of
    the kind the guard exists to protect. The drain's job is now unclaimed
    listings **plus reasonless agent unmatches** — 887 of 1,881 rather than 4.
    Its flagship example changes with it: Fox's Corona Doble listing was
    `decided_by = agent` and is now claimable, so `Drew Estate Liga Privada No. 9`
    is fulfillable from Fox tonight. The Corona Viva half of that example is
    unchanged and still correct — a crawler link to the more specific vitola,
    skipped by the theft guard.
  - **`declined` survives, narrower and honest.** It now means a genuinely
    protected row: a curator's verdict, a reasoned agent unmatch, or an agent row
    already pointing at another cigar. Those still cost a fetch before the refusal
    (the `existingCrawlerLink` asymmetry is unchanged) — an honest miss bought at
    the price of one page, and prod holds no row of the last kind today.

- **2026-09-01 — 2 Guys' product gate is re-derived from a live read, and the
  vendor is blocked on something else entirely (issue #217).** The 2026-08-31
  re-probe of the #179 build returned `product-locs=0`: all 1,466 `/store/` locs
  are the `/store/go/` registry family, so the prefix was not merely polluted, it
  was wrong. In-cluster Jobs then fetched robots.txt, the sitemap and 18 pages
  from it. Three rulings come out of that read.
  - **The shape, measured.** 6,356 distinct locs = 1 root + 4,888 ONE-segment
    slugs + 1,467 `/store/go/registry/<n>/`. No other depth, no query strings, no
    file extensions. Of the one-segment slugs, **3,841 end in `-<digits>` and
    1,047 do not**, and that suffix is the NitroSell product code — it is
    repeated as `og:upc` on every product page sampled. Five sampled slugs WITH a
    code: all 200, all `og:type=product`. Thirteen WITHOUT: six 404 (the sitemap
    enumerates dead slugs), six category/brand/site pages, and one real product
    carrying a non-numeric code.
  - **The gate is Mode B, and it does NOT enumerate families — it requires the
    product code.** `productPathSegments: {min:1,max:1}` plus
    `/^\/store(?:\/|$)|^\/(?![^/]*-\d+\/?$)/i`. Enumerating brand/promo families
    was the obvious move and the measurement refuses it: ~500 of the 1,047 are
    arbitrary line-landing slugs (`perdomo-30th-maduro`) that no keyword
    separates from a product slug, and the keywords that look usable are traps —
    `^\/cigars-` would drop nine URLs that DO carry a product code. A negative
    lookahead is unusual in a field named for rejection; it is the same statement
    as the positive finding, and it keeps the standing pattern requirements
    (every top-level branch anchored, segment boundaries not `\b`, no `g`/`y`).
    Two imprecisions are accepted and recorded in the adapter: it admits nine
    category pages whose title ends in a number, and it drops a product whose
    code is alphanumeric. Both sit on the cheap side of the asymmetry the
    2026-08-30 amendment states, except the second — which is why the accepted
    count (3,841 of 4,888) is the number to watch on the next probe.
  - **The vendor's real blocker is the PARSER, and it is not fixed here.**
    2 Guys serves **no `application/ld+json` at all** — zero blocks in all 18
    pages fetched, product pages included. What a product page carries instead:
    `og:type=product`, `product:price:amount` + `product:price:currency`,
    `og:availability`, `og:upc`, `og:brand`, and a
    `<div itemscope itemtype="https://schema.org/Product">` whose only itemprop is
    `name`. Its breadcrumb is deliberately "Home / <brand>" with no category
    trail (the page says so: *"ticket 126909: Home and brand URL instead of
    Breadcrumbs on product pages"*); CATEGORY pages keep a real
    `Home > Cigars > <line>`. So a probe on the corrected gate reads
    `sampled=3 parsed=0` with "no schema.org Product JSON-LD" — now a TRUE and
    correctly-attributed line, where the same words were misattributed on
    2026-08-30. **This ADR does not yet rule on whether OG/microdata is an
    acceptable structured source**, nor on where a category comes from when the
    product page states none; both are open, and until they are answered
    `crawl_enabled` for this vendor cannot go true whatever the gate says.
  - **robots, read live for the first time.** Two `User-agent: *` groups (RFC
    9309: combined, which `parseRobots` does) — one `Disallow: /store/filtered/`,
    one **`Crawl-delay: 5`** — plus a long named-bot blocklist we are not on. The
    parser ignores crawl-delay by design, so the ask is honored in the adapter:
    `minIntervalMs: 5000`. Rate asked for by a vendor's own robots.txt wins over
    our 2.5s floor, always upward.
  - **Registration reconciles by REPORT (the #179 rider).** `resolveVendor` stays
    insert-if-absent — the registry is admin-managed and a crawl must not
    overwrite an admin's decision — so flipping a posture constant in an adapter
    still changes nothing for a vendor that already has a row, which is every
    vendor we ship. A run that resolves an existing row now COMPARES the six
    posture fields it would have seeded and prints what differs, naming the row
    value, the adapter value, and the fact that the row wins. The operator still
    performs the change; they are no longer told about it by a crawl that quietly
    did nothing.

- **2026-09-01 — the drain's prefilter joins matching v2, and a look that read
  nothing stops claiming it did (issue #240).** The amendment below put the
  drain's *comparison* on matching v2 and left the step in front of it alone: a
  private slug-token prefilter chose which of a vendor's ~2,000 product URLs were
  worth fetching, and `coversAsk` only ever saw what it handed over. Four nights
  of prod drains ran green — `errors=0`, jobs complete — and enriched **nothing**:
  all 58 rows in `enrichment_attempts` read `last_outcome = 'miss'`, 100%, while
  the offers walk over the SAME two vendors and the same URLs auto-matched 992
  listings. The 06:00 Cuban Lou's run logged `requests=48 looked=48 matched=0`
  against a crawl that fetched 242 pages: most of those "looks" opened no page at
  all.
  - **The prefilter was a second matcher, and it disagreed with the first on
    every axis that matters.** It lowercased, split on `[^a-z0-9]+`, kept tokens
    of three characters or more, scored an unweighted set overlap and took the
    best eight. So: `ó` was a *separator*, and `Bolívar` arrived as `bol` + `var`
    and met `bolivar-belicosos-finos` on neither; `vi`, `no`, `9`, `54` — the
    short tokens that in this trade ARE the identity — were dropped by the floor;
    a brand word scored exactly as high as an identity word, so Fox's five Tabak
    Especials each scored 2 on `{drew, estate}` and, ties keeping enumeration
    order, filled the shortlist while `liga-privada-no-9-corona-doble` was never
    fetched — the amendment below's own flagship case, lost one step before the
    rule written to fix it saw a candidate; and trade vocabulary (`robusto`,
    `toro`, `the`) scored at all, so an ask for a marca a vendor has never
    stocked still drew eight pages of unrelated cigars.
  - **The fix is subtraction, not a new rule.** The prefilter now reads
    `fold`/`foldTokens` for its keys, `enrichAsk`'s already-computed required keys
    for identity, the ask's registry brand aliases for the marca, and
    `isIdentityBearing` — the same list `coversAsk` uses — for what counts as a
    word about a product. Ranking is three tiers read in order (identity, then
    bare ordinals as a tie-break, then marca); admission is identity **or** marca,
    so a vendor's brand shelf still earns a look and a `miss` stays reachable.
    **No stemming and no fuzz:** `monster` does not meet `monsters` here, exactly
    as it does not in `coversAsk`, and the day that becomes wrong the fix is one
    alias in the registry rather than two rules to keep in step. The invariant is
    that the prefilter can never drop a pair `coversAsk` would have linked.
  - **"No candidate scored above zero" is NOT a miss — this reverses the ruling
    in the 2026-08-30 amendment below.** That ruling rested on one premise, which
    it stated and which prod falsified: that a zero-length shortlist means the
    vendor's shelf holds nothing like the ask, rather than that our own shortlist
    is broken. It named the residual precisely — "zero ranked candidates means
    zero fetches, and no drain-time check can close that" — and located the
    guarantee in the pre-enable `--probe`. The probe checks the *gate*; nothing
    checked the *prefilter*, and the prefilter is what was wrong. A verdict about
    a catalogue that our own shortlist can manufacture is not evidence about that
    catalogue.
  - So a look that fetched no page records **`no_candidate`** (migration 0030),
    which burns neither `attempts` nor `errors` and is not counted as a look. It
    is written to the ledger rather than dropped, because "which lane came up
    empty-handed, and when" is what separates a shop that does not stock the brand
    from a registry that has not learned its aliases; the run reports it as its own
    counter. `exhausted` goes back to meaning what this ADR says it means: a vendor
    was read, and the cigar was not there.
  - **The hang the old ruling existed to prevent is real and is accepted here in a
    smaller form.** An ask no lane can name never retires. It costs zero fetches a
    night, and the levers are the ones this ADR already documents — an alias in the
    registry, or a lane that stocks the brand — but it does hold its place in the
    oldest-first open set, so a queue with many such asks drains fewer new ones per
    run. That is a visible, bounded cost paid to stop the ledger recording
    inventions; the alternative was a queue that clears itself by writing false
    sentences about vendors.
  - Migration 0030 also clears the miss/error ledger off every still-open ask, so
    the standing backlog retries under the fixed matcher rather than re-retiring on
    verdicts the defect wrote. Match and photo-refusal rows are kept, and
    `enrichment_requests.attempts` is re-derived from what survives.

- **2026-08-31 — the enrich drain rides matching v2, and its open set is 50
  (issue #233).** The amendment below retired the trigram resolver for the
  seed and offers walks and left the drain behind: `tryEnrichCandidates` was
  still comparing the ask's flat `canonical_name` to a vendor title with a
  hardcoded `similarity(...) <= 0.55`. That is not a tuning miss, it is the
  inversion ADR-012 names, and the 2026-08-31 bootstrap drains recorded it —
  `Drew Estate Liga Privada No. 9` was written to the ledger as a **miss at
  Fox**, a shop stocking `Liga Privada No. 9 Corona Viva` and `Corona Doble`.
  A `miss` is stored as evidence *about a catalogue*, so a matcher defect was
  being laundered into a false claim about a vendor — the exact laundering the
  per-vendor ledger amendment below forbids.
  - **The drain asks a different question from the walk, so it does not call
    `resolveListing`.** The walk asks "which row IS this listing?" and answers
    with one leaf. The drain already knows the row and asks "does this listing
    DEPICT it?". `resolveListing` resolves the Corona Viva title to the Corona
    Viva leaf, which is not the blend-level ask, so identity-equality says no
    while the right answer is yes: one catalogue photo per row (ADR-007) means
    a blend-level ask wants a photo of any of its vitolas.
  - **Coverage is one-way.** Every identity key the ask carries must appear in
    the candidate; the candidate may carry more. So a vitola listing under a
    blend-level ask matches, and a blend-level listing under a vitola-level ask
    does not. This is deliberately the asymmetric form of `numbersCompatible`,
    which is mutually contained and would reject the very case at issue.
  - **The brand gate is a contradiction test, not an anchor requirement**, and
    the registry forces that rather than taste choosing it: prod holds 96 brands
    and — until the Wave 3 backfill — zero lines and zero blends, so `Liga
    Privada No. 9 Corona Viva` anchors no brand at all (the marca is Drew Estate
    and the title never says so). A candidate anchoring a DIFFERENT brand is
    refused; one anchoring nothing is carried on key coverage alone. Same
    positive-evidence rule the seed path already applies when `no_anchor`
    annotates instead of unlinking. Line and blend are compatibility, not
    coverage: a candidate resolving to a different line or blend id is refused.
  - **The line span is struck only when a `line_id` could catch the mistake.**
    Striking it says "a vendor omitting the family is not naming a different
    cigar" — true only while the `lineId` arm can refuse a candidate that names a
    DIFFERENT family. Struck unconditionally against a registry with no lines in
    it the two halves come apart, and the result is a cross-line admit: prod's
    fourteen `Tatuaje Monster Smash` rows carry the free-text line, so `Monster
    Smash Frank` reduces to `frank`, which Fox's `Tatuaje Skinny Monsters Frank`
    covers exactly — nine live admits, a sibling family answering each other's
    photo asks. So the strike waits for the guard that makes it safe: nothing is
    struck until the Wave 3 backfill, and the pairing is the rule.
  - **A candidate that anchors no brand must be earned by a real name.** With no
    marca to agree on, coverage alone admits the pair, so an ask whose required
    keys are grammar and ordinals admits nearly anything: `Diplomaticos No 2`
    reduces to `no 2` and the live row `Mark Twain Memoir No. 2 Gordo` covers it
    exactly. Such a candidate is refused unless the ask retains at least one
    identity-bearing key — not a stopword, a bare ordinal, or trade vocabulary.
  - **One identity language (#235), as an invariant rather than a filter.** The
    drain refuses any pair `identityTokensCompatible` refuses; a matcher
    admitting pairs the strong-link guard rejects would be a second opinion about
    product identity, which is what the Face/Bride defect cost. It is recorded
    here that the rule is SUBSUMED by one-way coverage today and cannot fire —
    the compared query is the required keys, so coverage passing means every
    query token is shared and the residue is empty. Deleting it fails no test,
    measured. It is kept to stop the two rules diverging if coverage is ever
    loosened. What the ordering does buy is real: the residue is taken AFTER the
    brand span comes off, because raw, `Drew Estate Liga Privada No. 9` against
    `Liga Privada No. 9 Corona Viva` leaves `{drew, estate}` — the marca the
    title never states — and refusing that would kill the correct match this
    amendment exists for.
  - **Trigram is demoted to a ranker** over candidates already admitted. It can
    reorder a shortlist; it can no longer open or close a door.
  - **The drain will not repoint a crawler link that already resolves
    elsewhere.** Coverage being one-way makes the drain a *worse* authority on
    "which row is this listing?" than the walk, so without this the looser rule
    would migrate vitola links — and the offer history hanging off them — onto
    blend rows, silently and stickily (the title anchors no brand, so the next
    walk reads `no_anchor`, annotates, and leaves the theft standing). Such a
    candidate is skipped; the look moves on. Scored `miss`, on the same footing
    as the declined-upsert case: we read the catalogue and a previous walk had
    already answered the question.
  - **A miss stays a miss where a miss is true.** Fox carries eight `Tatuaje
    Skinny Monsters` and no Bride; Cuban Lou's only Hoyo is the *non-Cuban*
    `Classic No. 450 EMS Robusto` against a `CC` ask. Both are pinned as
    negative tests, because `product_photos` is `UNIQUE(cigar_id)`, first write
    wins, and nothing in the crawler deletes one — a looser matcher that put a
    sibling monster's picture in The Bride's only slot would be unrecoverable.
  - **Registry gaps are closed with aliases, never with a looser rule.** The ask
    `HdM Epicure Especial` names a marca no alias holds, so `hdm` survives as a
    required key and nothing can cover it. `enrichAsk` reads `brands.aliases`,
    so a curator adding `hdm` fixes it as data with no code change.
  - **`ENRICH_DEFAULT_LIMIT` 10 → 50**, `ORDER BY created_at` unchanged. At ten
    asks a night the backlog outran the drain, and the ceiling was set when most
    looks were being discarded by the floor anyway. The bound that matters is
    politeness: one look reads at most `MAX_ENRICH_CANDIDATES` (8, in practice
    ~5) product pages, so 50 looks is ~250 pages and at most 400 — against a
    seed/offers walk that reads every product URL a vendor publishes (Fox's flat
    sitemap is ~2,035 locs) on the same interval. The drain remains the small
    walk of the two. The DEFAULT is inert on its own — the CronJobs pass
    `--limit` explicitly — so the ceiling only moves when the ops side does, and
    the arithmetic above is what licenses that change rather than this constant.
  - **WHAT THE ENRICH PATH IS FOR, stated because fixing the matcher does not by
    itself fill the ask that motivated it.** Both of Fox's covering listings for
    `Drew Estate Liga Privada No. 9` are spoken for: the Corona Doble row is
    `decided_by = agent`, so the write declines to it, and the Corona Viva row is
    a crawler link to the more specific vitola, so the theft guard skips it. Both
    refusals are correct. The ask still records a miss — the change is that the
    miss is attributable to OWNERSHIP rather than manufactured by a threshold.
    Across the two enabled vendors only **4 listings of 1,881** are
    crawler-owned and unclaimed, the one state the drain can freshly link (Fox
    930 `crawler/auto`, 865 `agent/unmatched`, 4 `crawler/unmatched`; Cuban Lou's
    64 / 18 / 0). So the drain's job is UNCLAIMED-LISTING COVERAGE, plus listings
    already pointing at the ask itself. A blend-level ask whose covering listings
    all belong to other rows is structurally unfulfillable here, and its photo
    comes from the Wave 3 structuring that gives the blend a `blend_id` and lets
    its vitola siblings share one photo home — not from a bigger drain.
    *Superseded 2026-09-01 by the #245 ruling — see the top amendment. The census
    holds; the conclusion drawn from it does not. The 883 `agent/unmatched` rows
    counted here as claimed were a curation-lane bulk sweep carrying no reason and
    no cigar, which is not the verdict this guard exists to protect, and the drain
    may now claim them. The Corona Doble in the sentence above is one of them, so
    this very ask is fulfillable; the Corona Viva half is unchanged.*
  - The #170/#192 market and photo-authority gates are untouched, and the
    `match | miss | error | photo_refused` outcome vocabulary is preserved.
    (Extended with `no_candidate` on 2026-09-01 — see the top amendment.)
- **2026-08-31 — listing matching superseded by ADR-012 (matching v2).** The
  "normalized canonical name + trigram similarity" resolver above is retired:
  it inverts at scale (distinct blends outscore true sibling vitolas), so
  every vendor mints a parallel catalog. Matching v2 anchors on a brand alias,
  resolves line and blend by alias within that brand, then vitola and
  packaging by token, with trigram demoted to ranking residue inside the
  resolved scope; `categoryPath` breadcrumbs are persisted as parse evidence
  instead of discarded, and seed mode never mints a row from an unparsed
  title — no brand anchor means triage with the suggested parse attached.
  The rest of this ADR — trust order, vendor registry, crawl shape, offers as
  a time series, match-status preservation, track separation — is unchanged.
  See [ADR-012](012-structured-catalog-taxonomy.md); no new vendor is enabled
  until matching v2 and the packaging fold land.
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
    the vendor's catalogue, and what it holds is not this cigar. ~~"No candidate
    scored above zero" is a miss too — the enumeration IS the vendor's product
    list, and nothing in it resembled the cigar.~~ **REVERSED 2026-09-01 (#240);
    see the top amendment.** The residual this paragraph then went on to state —
    "zero ranked candidates means zero fetches, and no drain-time check can close
    that" — is exactly what happened, and the guarantee was located in the wrong
    place: the pre-enable `--probe` checks the GATE, and it was the PREFILTER that
    was broken. Four nights of prod drains wrote 58 of 58 `miss` without opening a
    page for most of them. Such a look now records `no_candidate`, burns nothing,
    and never retires the ask. The hang this paragraph feared is real and is
    accepted in the smaller form the new amendment describes: an ask no lane can
    name stays open at zero fetches a night.
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
    resolve to unknown rather than to a winner. On prod it resolves 822 of the 884
    untyped rows — Fox-only to NC — with no new column, no backfill and no
    hand-maintained coverage table, which this ADR
    forbids. It **self-heals**: every crawl that links a listing sharpens it, and
    `cigars.type` overrides it outright, so a curator always has the last word.
    A wrong auto-link — the very defect #170 is about — does become evidence, and
    that is bounded in the right direction: the value can only ever EXCLUDE a
    vendor, never authorize a write its own focus would not already allow. The
    failure mode is an ask the right vendor is never sent, which surfaces as an
    open row naming who is awaited, not as a wrong photo.
  - **`vendors.focus` is a claim about inventory and must be checked against the
    inventory** (added 2026-08-31, before this lane shipped). The evidenced market
    is only ever as sound as that column, and the first live reading of it was
    wrong: Cuban Lou's was recorded `'CC'` on the strength of its name while its
    catalogue carries Perdomo, Gurkha, CAO, Rocky Patel, Quorum and
    Dominican/Nicaraguan bundles beside genuine Habanos. Of the 57 untyped cigars
    it alone stocked, ~39 were thereby evidenced CC and were not Cuban. The failure
    then **sealed itself**: an evidenced-CC row drops Fox — the only live enrich
    lane — from its own fleet, so the vendor that could have contradicted the claim
    could never be asked. Migration 0025 records the shop as `'both'`, which
    collapses every one of those inferences to unknown with **no algorithm change**
    (`focus='both'` already contributes no evidence).
  - **Evidence comes only from crawl-enabled vendors, and that is what un-seals
    it** (added 2026-08-31). Correcting the one row above removes today's seal but
    does not stop the next one: `approved-import` stamped `focus='CC'` on every
    vendor it added (removed in #210 — it mints `NULL`, unknown, since appearing on
    the wiki is not evidence of what a shop stocks), so the next approved Cuban shop
    would have re-formed the seal the day it landed. Removing that stamp narrows the
    path without closing it — curation and crawled evidence still set `focus`, and a
    genuinely CC-focused shop is a row the registry is *supposed* to hold. "No
    CC-focus vendor exists right now" is a fact about the registry, not a property
    of the design. The structural statement is instead:
    *linkage evidence is read only from vendors with `crawl_enabled = true`* — the
    same set the fleet is drawn from, because a vendor that cannot be asked cannot
    be evidence either. Two consequences, and both are the point: a mis-focused
    shop can only ever seal rows while it is enabled, and **disabling it frees
    every row it sealed**, today, with no migration — which is the lever this ADR
    already promises and, before this, did not actually deliver. `cigars.type`
    still overrides everything, and remains authoritative by construction.
    **The rule this establishes:** a shop that trades in both markets
    is recorded `'both'`, whatever its name suggests; recording it as one market
    manufactures evidence, and the cost is paid by a *different* vendor's lane.
    **The residual, named and not fixed here:** `vendors.focus` conflates *what a
    vendor sells* with *what it is authoritative about*. Those come apart exactly
    at `'both'` — the shop genuinely sells NC and CC, yet is a weaker photo
    authority than a focused vendor precisely because its posture rules nothing
    out. Write authority is currently derived from the sales claim plus a
    pre-emption test rather than recorded directly; separating them (an explicit
    authority column, or per-market vendor postures) is a schema question left open.
  - **Write authority, split by reversibility.** The two crawler writes are not
    the same kind of thing. `listing_matches` + `offers` NAME their vendor, are
    revisable by a curator (`decided_by` already protects a non-crawler verdict)
    and are re-written on the next crawl. `product_photos` is `UNIQUE(cigar_id)`,
    inserted `onConflictDoNothing`, and **nothing in the crawler ever deletes
    one**: one global slot, first write wins, forever. So:
    *a vendor may LINK to a cigar when its focus does not CONFLICT with the
    cigar's evidenced market (unknown permits); a SINGLE-MARKET vendor may fill the
    cigar's single catalogue-photo slot only when the evidenced market is KNOWN and
    its focus covers it; a vendor with NO single market (`both`, or no recorded
    focus) may fill it only when no single-market vendor already stocks the cigar.*
    The last clause replaces an earlier ruling that the guard should be **inert**
    for a market-agnostic vendor, on the reasoning that it has no market to
    conflict with. That was right about the market and wrong about the slot:
    `focus='both'` does not mean "no opinion to check", it means THE NEGATIVE
    FILTER IS UNAVAILABLE — nothing about the vendor's posture can rule out a bad
    name-match — which is when the one permanent slot deserves more care, not less.
    Inertness also made `both` the most privileged focus a vendor could hold, which
    is backwards. So the guard asks the question that is still answerable: is there
    a vendor here whose focus *does* cover this cigar's market? If so it is the
    better authority and must not be PRE-EMPTED (overwriting is already impossible
    — `UNIQUE(cigar_id)`, and an occupied slot returns early — so winning an empty
    slot first is the whole risk). If not, the market-agnostic vendor is the only
    source there is and its own product page beats an empty slot. Deliberately keyed
    on the stockist fact, not on `market == null`, since unknown covers both "no
    evidence" (permit) and "two focused vendors disagree" (refuse).
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
    verified false-positive source. **A refusal is not a miss, and never creates**
    (corrected 2026-08-31). The two used to collapse to one `null` return, so in
    `seed` mode a refusal fell through to creating a cigar — justified as "a
    listing whose market contradicts its best match is a different cigar". That
    holds only while the market evidence is sound, and the evidence was wrong often
    enough to sink it (see the `vendors.focus` ruling above). When a refusal is
    false, creating turns a recoverable bad link into a **permanent duplicate**:
    the link would have been named, revisable and re-written next crawl, whereas a
    spurious catalogue row is none of those and is invisible at the point it is
    made. So the result type distinguishes `none` / `match` / `refused`; a refusal
    leaves the listing `unmatched` with no cigar, in `seed` mode exactly as in
    `offers`, and it lands in the triage queue a curator already works. The count
    is reported per run (`links refused (market)`) because that queue growing is
    something an operator must be able to see — and a lane refusing a lot is more
    likely to have a wrong `vendors.focus` than a wrong catalogue.
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

- **2026-09-01 — the Wikidata taxonomy is seeded (issue #127).** A prod
  `--brand-images --probe` (namespace `frontend`, image v0.33.0) over the
  coverless brands produced the first observed QIDs, and they are now committed
  in `packages/crawler/src/core/wikidata-taxonomy.ts` with the English label the
  probe printed beside each: `tobaccoClass` `Q110684031` (cigar brand),
  `tobaccoIndustry` `Q907703` (tobacco industry), three `genericBrand` classes,
  seventeen `negative` classes, and `Q241` (Cuba) as the only origin the sample
  contained. `tobaccoProduct` stays **empty**: no candidate carried a P1056
  meaning cigars or tobacco, and inventing one would be the fabrication this
  ADR's live-verification rule forbids. The lists are therefore deliberately
  incomplete — a class no candidate carried cannot appear — and later probes are
  expected to extend them.
  - **This unblocks the job; it does not fill the wall.** `--brand-images` is now
    runnable, and on that same probe it yields **zero covers** for the 17
    coverless brands: best case 2 `no_image`, 2 `ambiguous`, 13 `no_match`. No
    name-matching tobacco-qualifying entity with a P18 exists for any of them.
    The seeding is future-brand plumbing, and the blank shelves need a different
    source.
  - **The refuse-to-run gate stays.** `taxonomyIsUnseeded` still guards the run,
    because a later edit can empty the lists again and the `no_match` rows that
    would follow are a 30-day negative cache.
