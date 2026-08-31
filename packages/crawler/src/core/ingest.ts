import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { enrichmentRequests, productPhotos, vendors, type Database } from "@cj/db";
import {
  recordPriceObservation,
  recordEnrichmentAttempt,
  enrichmentCoverageForRequest,
  coversMarket,
  coversMarketSql,
  evidencedMarket,
  evidencedMarketSql,
  mayWriteCatalogPhoto,
  photoAuthority,
  vendorNotRetiredSql,
  type CigarType,
  type EnrichmentOutcome,
  type VendorFocus,
} from "@cj/domain";
import { processPhoto as defaultProcessPhoto, type PhotoStorage, type ProcessedPhoto } from "@cj/photos";
import type { VendorAdapter } from "../adapters/types.js";
import { collectSitemapSamples, collectSitemapUrls } from "./sitemap.js";
import { filterProductUrls, pathOf, robotsGatePath } from "./product-url.js";
import { extractJsonLd, type JsonLdProduct } from "./jsonld.js";
import { isCigarListing, normalizeListing, type NormalizedListing } from "./normalize.js";
import { createCigarFromListing, findCatalogMatch, upsertListingMatch } from "./match.js";
import { parseRobots } from "./robots.js";
import { openCrawlRun, reclaimStrandedRuns, type SignalHost } from "./run-record.js";
import { CRAWLER_UA_TOKEN, MAX_IMAGE_BYTES, type Fetcher } from "./fetcher.js";

// The run driver (ADR-006). Three modes share one polite walk: `seed` (catalog
// creation + offers + photos), `offers` (offers-only, never creates a cigar), and
// `enrich` (drain the gap-fill queue with targeted lookups). Every non-dry run is
// bracketed by a crawl_runs row; a `--dry-run` fetches (bounded) and reports the
// would-writes without touching the DB or the object store.

const ENRICH_DEFAULT_LIMIT = 10;
const MAX_ENRICH_CANDIDATES = 8;

export type CrawlMode = "seed" | "offers" | "enrich";

// How a look left the request. `blocked` is kept apart from `exhausted` because
// "nobody could finish looking" is not a fact about a catalogue (#158).
type Retirement = "open" | "exhausted" | "blocked";

export interface IngestStats {
  pagesFetched: number;
  listingsParsed: number;
  skippedNonCigar: number;
  matchesAuto: number;
  cigarsCreated: number;
  offersWritten: number;
  photosCaptured: number;
  // Catalogue-photo writes REFUSED by the write-authority guard (#170): this
  // vendor's focus is a single market and the cigar's evidenced market is either
  // unknown or the other one. Present only when non-zero, so the JSONB of a run
  // that refused nothing stays byte-identical to what it was before this field
  // existed. Not an error — a refusal is the guard working.
  photosSkippedMarket?: number;
  // Seed/offers listings whose best catalogue candidate was REFUSED on market
  // grounds (#170), leaving the listing unmatched rather than linked or newly
  // created. Optional on the same terms as the field above: absent when zero, so a
  // run that refused nothing serialises exactly as it did before this existed.
  // Worth watching after the Cuban Lou's correction — a lane refusing a lot is
  // more likely to have a wrong `vendors.focus` than a wrong catalogue.
  linksRefusedMarket?: number;
  errors: number;
  // Present only for a vendor with sitemapSampling configured — absent keeps the
  // JSONB byte-identical for every other vendor.
  sitemapSampling?: {
    samples: number;
    locsPerSample: number[];
    // Marginal contribution per sample (URLs no earlier sample enumerated). The
    // number `sitemapSampling.samples` is tuned from: a trailing 0 means the
    // count is already enough, a non-zero last entry means raise it.
    newPerSample: number[];
    unionLocs: number;
    productLocs: number;
    varied: boolean;
  };
  // Present only on an `enrich` run, so the JSONB stays byte-identical for the
  // other two modes. A nightly drain has to be able to say WHAT it retired and
  // WHERE: under per-vendor budgets (#158) "spent" is a verdict about this vendor
  // and this vendor only, and a summary that omits it is the vendor-blind report
  // the ADR amendment forbids.
  enrich?: {
    // Open requests this vendor selected — already filtered by its own budget.
    requests: number;
    // Looks that COMPLETED (miss + match): the vendor's catalogue was enumerated
    // and some ranked candidate parsed as a product. These are the ones that burn
    // budget — a page that answers 200 with nothing parseable does not count.
    looked: number;
    matched: number;
    // Looks that could not complete: an empty enumeration, no candidate that
    // answered 200, or none that yielded a parseable product. Never
    // budget-burning, separately bounded by ERROR_BUDGET.
    errored: number;
    // Requests this run retired as EXHAUSTED — every counted lane has now
    // completed its looks and none carried the cigar.
    spent: number;
    // Requests this run retired as BLOCKED — every counted lane is retired but at
    // least one burned ERROR_BUDGET without finishing a look. Reported apart from
    // `spent` because it is not a fact about any catalogue (#158): a nightly
    // summary that folded the two together would say "we looked and found
    // nothing" about a vendor nobody could reach.
    blocked: number;
    // Looks that found a listing above the similarity floor and REFUSED to link it
    // (#170): between the open-set SELECT and the write, the cigar's evidenced
    // market resolved to the market this vendor does not trade in. Counted as a
    // completed look (a `miss`) and not as an error, because we did read the
    // vendor's catalogue — what we declined is the conclusion, not the look.
    skippedMarket: number;
  };
}

export interface IngestDeps {
  db: Database;
  fetcher: Fetcher;
  storage: PhotoStorage | null;
  now: () => Date;
  // Injectable so ingest tests need neither sharp nor real image bytes; the CLI
  // wires the real @cj/photos pipeline.
  processPhoto?: (input: Buffer, contentType: string) => Promise<ProcessedPhoto>;
  // Injectable so a test can drive the #155 SIGTERM handler without signalling —
  // or exiting — the vitest worker. Production leaves it unset and gets `process`.
  signalHost?: SignalHost;
}

export interface IngestOptions {
  adapter: VendorAdapter;
  vendorId: string;
  mode: CrawlMode;
  limit?: number | null;
  dryRun?: boolean;
}

export interface IngestResult {
  crawlRunId: string | null;
  status: "succeeded" | "failed";
  stats: IngestStats;
  error?: string;
  report: string[];
}

export class RobotsDisallowedError extends Error {
  constructor(path: string) {
    super(`robots.txt disallows the crawl target ${path} for our user-agent — refusing to crawl.`);
    this.name = "RobotsDisallowedError";
  }
}

// Scoped to vendors that opted into sitemap sampling. They opted in BECAUSE their
// enumeration is unreliable, so a "succeeded, 0 listings" run there is a silent
// failure that reads as healthy in crawl_runs. A non-sampling vendor with an empty
// sitemap still succeeds-with-zero, exactly as before.
export class SitemapEnumerationEmptyError extends Error {
  constructor(samples: number, unionLocs: number) {
    super(
      `sitemap sampling (${samples} samples) enumerated ${unionLocs} URLs, 0 passing the product gate — ` +
        "refusing to record a silent zero-listing run.",
    );
    this.name = "SitemapEnumerationEmptyError";
  }
}

function emptyStats(): IngestStats {
  return {
    pagesFetched: 0,
    listingsParsed: 0,
    skippedNonCigar: 0,
    matchesAuto: 0,
    cigarsCreated: 0,
    offersWritten: 0,
    photosCaptured: 0,
    errors: 0,
  };
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function slugTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

function priceToDecimal(priceCents: number | null): string | null {
  return priceCents != null ? (priceCents / 100).toFixed(2) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- robots + sitemap gate ---------------------------------------------------

async function fetchRobots(deps: IngestDeps, adapter: VendorAdapter): Promise<ReturnType<typeof parseRobots>> {
  const robotsUrl = new URL("/robots.txt", adapter.url).toString();
  const { status, body } = await deps.fetcher.fetchText(robotsUrl);
  // A missing/failed robots.txt is treated as fully permissive (RFC 9309).
  return parseRobots(status === 200 ? body : "", CRAWLER_UA_TOKEN);
}

async function productUrls(deps: IngestDeps, adapter: VendorAdapter, stats: IngestStats): Promise<string[]> {
  if (!adapter.sitemapSampling) {
    return filterProductUrls(await collectSitemapUrls(deps.fetcher, adapter.sitemapUrl), adapter);
  }

  const sampled = await collectSitemapSamples(deps.fetcher, adapter.sitemapUrl, {
    samples: adapter.sitemapSampling.samples,
    intervalMs: adapter.sitemapSampling.intervalMs,
  });
  const urls = filterProductUrls(sampled.urls, adapter);
  stats.sitemapSampling = {
    samples: sampled.samples.length,
    locsPerSample: sampled.samples.map((sample) => sample.enumerated),
    newPerSample: sampled.samples.map((sample) => sample.newUrls),
    unionLocs: sampled.urls.length,
    productLocs: urls.length,
    varied: sampled.varied,
  };
  if (urls.length === 0) throw new SitemapEnumerationEmptyError(sampled.samples.length, sampled.urls.length);
  return urls;
}

// --- per-listing ingest ------------------------------------------------------

// WRITE AUTHORITY FOR THE ONE CATALOGUE-PHOTO SLOT (#170).
//
// `product_photos` is UNIQUE(cigar_id), inserted with onConflictDoNothing, and
// nothing in the crawler ever deletes a row. One global slot per cigar, first
// write wins, forever — so unlike a listing match (per-vendor, named, revisable,
// re-written next crawl) a wrong photo here is silent and permanent. That
// asymmetry, not the similarity score, is what makes #170 severe, and it is why
// this guard is STRICTER than the one on the link: the slot may only be filled
// when the cigar's evidenced market is KNOWN and this vendor's focus covers it.
//
// The authority is read HERE, after the listing match has been committed, and
// that ordering is the whole design (option A, SELF-EVIDENCING):
//   * a single-market vendor that links a cigar nobody else stocks becomes its own
//     sole evidence, so it may photograph it — Fox's working seed/enrich lanes are
//     not regressed by this guard at all;
//   * a second vendor of the OTHER market linking the same cigar makes the
//     evidence conflict, which resolves to unknown, and its photo is refused.
//
// A `both`-focus vendor (Cuban Lou's, from migration 0025) is NOT self-evidencing:
// its own link contributes no market evidence, so what gates it is whether a
// FOCUSED vendor already stocks the cigar. It photographs what only it carries and
// never pre-empts Fox on a row Fox stocks. See `mayWriteCatalogPhoto`.
//
// The residual, stated: the first vendor to discover a cigar can always photograph
// it, so a single-market lane that name-matches a brand nobody else stocks still
// fills the slot. Closing that needs INDEPENDENT evidence (`cigars.type`, or a
// different vendor already stocking it), which would mean the discovering vendor
// can never photograph what it found — an owner call, raised as such, not decided
// here.
async function capturePhoto(
  deps: IngestDeps,
  vendorId: string,
  focus: VendorFocus | null,
  cigarId: string,
  listing: NormalizedListing,
  stats: IngestStats,
): Promise<void> {
  if (!deps.storage || !listing.imageUrl) return;

  // The slot check comes FIRST so `photosSkippedMarket` counts only refusals that
  // would otherwise have written: a cigar that already has its photo is a no-op
  // whatever the market says, and counting it would inflate the number an operator
  // reads as "wrong-market photos this run prevented".
  const existing = await deps.db
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, cigarId))
    .limit(1);
  if (existing[0]) return;

  // The market gate precedes the download: a photo we are not allowed to write is
  // a photo we should not have spent a vendor's bandwidth fetching.
  if (!mayWriteCatalogPhoto(focus, await photoAuthority(deps.db, cigarId))) {
    stats.photosSkippedMarket = (stats.photosSkippedMarket ?? 0) + 1;
    return;
  }

  // Bounded: a vendor's product image is whatever their CMS holds, and an
  // oversize one throws — both call sites already isolate a photo failure into
  // stats.errors rather than losing the offer (ADR-007).
  const image = await deps.fetcher.fetchBinary(listing.imageUrl, MAX_IMAGE_BYTES);
  if (image.status !== 200) {
    stats.errors += 1;
    return;
  }

  const process = deps.processPhoto ?? defaultProcessPhoto;
  const processed = await process(image.body, image.contentType);
  const id = randomUUID();
  const objectKey = `product/${cigarId}/${id}.jpg`;
  const thumbKey = `product/${cigarId}/${id}.thumb.jpg`;

  await deps.storage.put(objectKey, processed.full, processed.contentType);
  await deps.storage.put(thumbKey, processed.thumb, processed.contentType);

  try {
    const inserted = await deps.db
      .insert(productPhotos)
      .values({
        cigarId,
        vendorId,
        sourceUrl: listing.imageUrl,
        objectKey,
        thumbKey,
        contentType: processed.contentType,
        width: processed.width,
        height: processed.height,
        bytes: processed.full.length,
        rights: "pending",
      })
      // At most one product photo per cigar — a concurrent capture is a no-op.
      .onConflictDoNothing({ target: productPhotos.cigarId })
      .returning({ id: productPhotos.id });
    if (inserted[0]) stats.photosCaptured += 1;
    else {
      await deps.storage.delete(objectKey).catch(() => {});
      await deps.storage.delete(thumbKey).catch(() => {});
    }
  } catch (error) {
    await deps.storage.delete(objectKey).catch(() => {});
    await deps.storage.delete(thumbKey).catch(() => {});
    throw error;
  }
}

// Match a listing, write its offer, and (seed only) create the catalog cigar.
// Match + offer commit in one transaction; the photo is captured after, in its
// own path, so a photo failure never rolls back an offer (ADR-007 isolation).
async function ingestListing(
  deps: IngestDeps,
  options: IngestOptions,
  focus: VendorFocus | null,
  url: string,
  listing: NormalizedListing,
  product: JsonLdProduct,
  stats: IngestStats,
): Promise<void> {
  const now = deps.now();
  const listingKey = pathOf(url);

  const cigarId = await deps.db.transaction(async (tx) => {
    // `vendorFocus` is the seed/offers half of #170, and the half that has already
    // fired in production: BOTH live cross-market rows came through here, not
    // through the drain. A CC vendor walking its own sitemap trigram-matched an NC
    // catalogue row and auto-linked it. The guard is a pure negative filter — it
    // can only ever refuse a link, never redirect one.
    const result = await findCatalogMatch(tx, listing.name, { vendorFocus: focus });
    let linkedCigarId: string | null = null;
    let status: "auto" | "unmatched";

    if (result.kind === "match") {
      linkedCigarId = result.hit.cigarId;
      status = "auto";
    } else if (result.kind === "refused") {
      // A REFUSAL DOES NOT CREATE, in seed mode either. We found a strong name
      // candidate and declined it on market grounds — that is an unresolved
      // question, not evidence of a new cigar. Falling through to
      // createCigarFromListing (which is what this did) would mint a duplicate of
      // the row we just refused every time the refusal was wrong, and a wrong
      // refusal is exactly what a wrong `vendors.focus` produces (#170: Cuban
      // Lou's was recorded 'CC' while selling Perdomo). A bad link is named,
      // revisable and re-written next crawl; a duplicate catalogue row is none of
      // those. So: leave the listing UNMATCHED, with no cigar, for the triage
      // queue a curator already works — the same landing place `offers` mode uses.
      status = "unmatched";
      stats.linksRefusedMarket = (stats.linksRefusedMarket ?? 0) + 1;
    } else if (options.mode === "seed") {
      linkedCigarId = await createCigarFromListing(tx, listing.name);
      stats.cigarsCreated += 1;
      status = "auto";
    } else {
      status = "unmatched";
    }

    const match = await upsertListingMatch(tx, {
      vendorId: options.vendorId,
      listingKey,
      cigarId: linkedCigarId,
      status,
      now,
    });
    if (status === "auto") stats.matchesAuto += 1;

    // One offers write path shared with record_price — the 24h dedupe skips an
    // identical observation (ADR-009). Crawler offers link to their cigar through
    // the listing match (curator-authoritative), so cigar_id stays null here.
    const observation = await recordPriceObservation(tx, {
      cigarId: null,
      vendorId: options.vendorId,
      sourceName: null,
      sourceUrl: null,
      listingMatchId: match.id,
      listingUrl: url,
      packaging: listing.packaging,
      sticksPerPackage: listing.sticksPerPackage,
      priceCents: listing.priceCents,
      currency: listing.currency,
      inStock: listing.inStock,
      priceType: "retail",
      raw: { listing, product },
      seenAt: now,
    });
    if (observation.inserted) stats.offersWritten += 1;

    return linkedCigarId;
  });

  if (cigarId) {
    try {
      await capturePhoto(deps, options.vendorId, focus, cigarId, listing, stats);
    } catch (error) {
      // Photo ingestion is isolated from the offer write (ADR-007).
      stats.errors += 1;
      void error;
    }
  }
}

// --- mode: seed / offers -----------------------------------------------------

async function walkListings(
  deps: IngestDeps,
  options: IngestOptions,
  focus: VendorFocus | null,
  stats: IngestStats,
  report: string[],
): Promise<void> {
  const { adapter } = options;
  const robots = await fetchRobots(deps, adapter);
  const gatePath = robotsGatePath(adapter);
  if (!robots.isAllowed(gatePath)) {
    throw new RobotsDisallowedError(gatePath);
  }

  let urls = await productUrls(deps, adapter, stats);
  if (options.limit != null) urls = urls.slice(0, options.limit);

  for (const url of urls) {
    if (!robots.isAllowed(pathOf(url))) continue;
    try {
      const { status, body } = await deps.fetcher.fetchText(url);
      if (status !== 200) {
        stats.errors += 1;
        continue;
      }
      const { product, breadcrumbs } = extractJsonLd(body);
      if (!product) continue;
      const listing = normalizeListing(product, breadcrumbs);
      if (!listing) continue;
      stats.listingsParsed += 1;

      if (!isCigarListing(listing, adapter)) {
        stats.skippedNonCigar += 1;
        continue;
      }

      if (options.dryRun) {
        report.push(
          `${options.mode === "seed" ? "seed " : "offer"}  ${pathOf(url)}  ${listing.name}  ` +
            `price=${priceToDecimal(listing.priceCents) ?? "-"} stock=${listing.inStock ?? "-"}`,
        );
        stats.offersWritten += 1;
        continue;
      }

      await ingestListing(deps, options, focus, url, listing, product, stats);
    } catch (error) {
      stats.errors += 1;
      void error;
    }
  }
}

// --- mode: enrich ------------------------------------------------------------

async function nameSimilarity(deps: IngestDeps, a: string, b: string): Promise<number> {
  const result = await deps.db.execute(sql`SELECT similarity(${a}, ${b}) AS sim`);
  return Number((result.rows as unknown as { sim: number }[])[0]?.sim ?? 0);
}

async function drainEnrichment(
  deps: IngestDeps,
  options: IngestOptions,
  focus: VendorFocus | null,
  stats: IngestStats,
  report: string[],
): Promise<void> {
  const { adapter } = options;
  const robots = await fetchRobots(deps, adapter);
  const gatePath = robotsGatePath(adapter);
  if (!robots.isAllowed(gatePath)) {
    throw new RobotsDisallowedError(gatePath);
  }

  const urls = await productUrls(deps, adapter, stats);
  const candidates = urls.map((url) => ({ url, tokens: slugTokens(lastSegment(pathOf(url))) }));

  const limit = options.limit ?? ENRICH_DEFAULT_LIMIT;

  // The per-vendor open set (ADR-006 amendment 2026-08-30, migration 0023). Three
  // things changed from the pre-0023 `WHERE status = 'pending'`:
  //
  //   * The budget test is against THIS VENDOR'S ledger row, not the request's
  //     shared counter. A request Fox has spent is still open to 2 Guys.
  //   * `exhausted` is IN the open set. That is the entire reopen mechanism: a
  //     newly enabled vendor has no ledger row, so `COALESCE(attempts, 0) = 0`
  //     and the first run picks the row straight up — no reopen job, no cron, no
  //     backfill. "Exhausted" only ever meant "exhausted at the vendors that
  //     looked", and a vendor that might carry the brand is new evidence.
  //   * `in_progress` is in it too. The drain no longer WRITES that state, but a
  //     row stranded by an older image (or a crash mid-rollout) must still be
  //     reachable — nothing else re-selects it (#157 defect 2).
  //
  // `fulfilled` is deliberately absent: one catalogue photo per cigar (ADR-007)
  // means the ask is answered. The join to `cigars` also kills the per-request
  // SELECT the old loop did, so the canonical name and market arrive in one read.
  //
  // THE MARKET FILTER READS THE EVIDENCED MARKET, NOT `cigars.type` (#170). On the
  // raw column the predicate is inert for 884 of prod's 971 active cigars, because
  // `coversMarketSql` admits an unknown market by design — so a CC lane could and
  // would select 91% of the catalogue. The evidenced market resolves 878 of those
  // 884 from links the crawler already wrote (see evidencedMarketSql), which is
  // what turns a filter that is correct-but-inert into one that bites.
  //
  // The same fragment is SELECTED as `market` and handed to finalizeEnrichment, so
  // the rollup's denominator is computed from the identical value this open set was
  // filtered with. Two evaluations of a correlated subquery per candidate row is
  // the price of that coupling, and at LIMIT 10 it is not a price worth optimizing
  // away — a drain that filters on one market while the rollup counts on another
  // holds requests open forever.
  const open = await deps.db.execute(sql`
    SELECT r.id AS request_id, c.id AS cigar_id, c.canonical_name,
           ${evidencedMarketSql(sql`c.id`)} AS market
    FROM enrichment_requests r
    JOIN cigars c ON c.id = r.cigar_id
    LEFT JOIN enrichment_attempts a
           ON a.request_id = r.id AND a.vendor_id = ${options.vendorId}
    WHERE r.status IN ('pending', 'in_progress', 'exhausted')
      AND ${coversMarketSql(sql`${focus}::text`, evidencedMarketSql(sql`c.id`))}
      AND ${vendorNotRetiredSql(sql`COALESCE(a.attempts, 0)`, sql`COALESCE(a.errors, 0)`)}
    ORDER BY r.created_at
    LIMIT ${limit}
  `);
  const pending = open.rows as unknown as {
    request_id: string;
    cigar_id: string;
    canonical_name: string;
    market: CigarType | null;
  }[];

  const enrich = {
    requests: pending.length,
    looked: 0,
    matched: 0,
    errored: 0,
    spent: 0,
    blocked: 0,
    skippedMarket: 0,
  };
  stats.enrich = enrich;

  for (const request of pending) {
    const cigar = { id: request.cigar_id, canonicalName: request.canonical_name };

    const wanted = slugTokens(cigar.canonicalName);
    const ranked = candidates
      .map((candidate) => ({ ...candidate, score: overlap(wanted, candidate.tokens) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ENRICH_CANDIDATES);

    const outcome = await tryEnrichCandidates(deps, options, focus, cigar, ranked, candidates.length, stats, report);
    if (outcome === "error") enrich.errored += 1;
    else enrich.looked += 1;
    if (outcome === "match") enrich.matched += 1;

    if (options.dryRun) continue;

    const retired = await finalizeEnrichment(deps, options, request.request_id, request.market, outcome);
    if (retired === "exhausted") enrich.spent += 1;
    else if (retired === "blocked") enrich.blocked += 1;
  }
}

// What one vendor's look CONCLUDED — three outcomes, not a boolean, because "no
// match at V is evidence about V only" makes the difference between a failed look
// and a completed one load-bearing (ADR-006 amendment 2026-08-30).
//
//   match — a listing cleared the similarity floor.
//   miss  — we READ this vendor's catalogue and it does not carry the cigar.
//           Honest evidence; it burns one of this vendor's two attempts. NOTE that
//           "nothing scored above zero" is a miss, not an absence of evidence: the
//           enumeration IS the vendor's product list and nothing in it resembled
//           the cigar, which is exactly the Red Anchor/Fox result. That rests on
//           the enumeration being real products, which nothing at drain time can
//           check — zero candidates means zero fetches. It is the ADR's mandatory
//           pre-enable `--probe` (and its path-shape census, #179) that
//           establishes it, and the reason a gate correction is never allowed to
//           ride a ledger change.
//   error — the look could not COMPLETE, so it says nothing about any catalogue:
//           it never burns an attempt, and ERROR_BUDGET bounds it so a permanently
//           broken vendor cannot pin the request open and re-fetch the same
//           failures every night.
//
// THE LINE BETWEEN THE LAST TWO IS A PARSED PRODUCT, NOT A 200. An over-matching
// product gate answers 200 all day and parses nothing: the live probe recorded in
// this PR's ADR-006 amendment had 2 Guys' `/store/` prefix enumerate 1,462 locs
// that were gift-registry pages carrying no schema.org Product, and `parsed=0` was
// the true signal (the probe's own `needs-attention` misattributed it to the
// vendor). Counting that as a miss would burn real budget for a gate defect and
// then report "2 Guys looked and does not carry it" — manufactured evidence about
// a vendor, which is precisely what the amendment forbids. So a look is COMPLETE
// only once some ranked candidate yielded a parseable product listing — the same
// `parsed` count `--probe` reports. Three shapes therefore land on `error`: an
// empty enumeration, no candidate that answered 200, and candidates that answered
// 200 with nothing a product parser could read.
//
// A parsed product that is an accessory, or that misses the similarity floor, is a
// MISS and not an error: we did read the vendor's catalogue, and what it holds is
// not this cigar.
async function tryEnrichCandidates(
  deps: IngestDeps,
  options: IngestOptions,
  focus: VendorFocus | null,
  cigar: { id: string; canonicalName: string },
  ranked: { url: string }[],
  enumerated: number,
  stats: IngestStats,
  report: string[],
): Promise<EnrichmentOutcome> {
  const { adapter } = options;
  if (enumerated === 0) return "error";
  if (ranked.length === 0) return "miss";

  // Did we actually READ this vendor's catalogue? A 200 is not enough — see the
  // header: a gate that admits non-product pages answers 200 and parses nothing.
  let parsed = false;
  for (const candidate of ranked) {
    const { status, body } = await deps.fetcher.fetchText(candidate.url);
    if (status !== 200) {
      stats.errors += 1;
      continue;
    }
    const { product, breadcrumbs } = extractJsonLd(body);
    if (!product) continue;
    const listing = normalizeListing(product, breadcrumbs);
    if (!listing) continue;
    parsed = true;
    stats.listingsParsed += 1;
    if (!isCigarListing(listing, adapter)) {
      stats.skippedNonCigar += 1;
      continue;
    }

    const sim = await nameSimilarity(deps, cigar.canonicalName, listing.name);
    if (sim <= 0.55) continue;

    if (options.dryRun) {
      report.push(`enrich ${pathOf(candidate.url)}  ${listing.name}  (sim=${sim.toFixed(2)}) → ${cigar.canonicalName}`);
      return "match";
    }

    const now = deps.now();
    // WRITE AUTHORITY, re-evaluated at the write (#170). The open set already
    // filtered on the evidenced market, so this normally agrees — it is here
    // because the two reads are seconds of polite HTTP apart, and in that window a
    // curator can set `cigars.type` or another lane can link the row and turn an
    // unknown market into a known, conflicting one. Authority belongs at the write
    // site; a filter on the way in is an optimization, not a guarantee.
    //
    // Evaluated INSIDE the transaction that writes the match, so the check and the
    // write see one snapshot.
    const linked = await deps.db.transaction(async (tx) => {
      if (!coversMarket(focus, await evidencedMarket(tx, cigar.id))) return false;
      const match = await upsertListingMatch(tx, {
        vendorId: options.vendorId,
        listingKey: pathOf(candidate.url),
        cigarId: cigar.id,
        status: "auto",
        now,
      });
      stats.matchesAuto += 1;
      const observation = await recordPriceObservation(tx, {
        cigarId: null,
        vendorId: options.vendorId,
        sourceName: null,
        sourceUrl: null,
        listingMatchId: match.id,
        listingUrl: candidate.url,
        packaging: listing.packaging,
        sticksPerPackage: listing.sticksPerPackage,
        priceCents: listing.priceCents,
        currency: listing.currency,
        inStock: listing.inStock,
        priceType: "retail",
        raw: { listing, product },
        seenAt: now,
      });
      if (observation.inserted) stats.offersWritten += 1;
      return true;
    });

    // A refusal ends the LOOK, not just this candidate: the conflict is a property
    // of (this vendor, this cigar), so every remaining candidate would be refused
    // for the same reason. It scores as a `miss` — we read the vendor's catalogue
    // and declined to conclude from it — never as an `error`, which would burn
    // ERROR_BUDGET on a guard doing its job and re-fetch the same pages nightly.
    if (!linked) {
      if (stats.enrich) stats.enrich.skippedMarket += 1;
      return "miss";
    }

    // KNOWN MISREPORT, deliberately unchanged by #158 and stated rather than
    // silently carried: a capture that throws still returns `match`, so a request
    // whose whole point was the catalogue photo is marked `fulfilled` with no photo
    // — and `fulfilled` is terminal in the drain's open set, as it was before 0023.
    // The ADR-006 amendment making the catalogue photo the point of the request
    // makes this worse, not better. It is NOT reclassified here because the right
    // verdict is arguable (the vendor does carry the cigar, so it is not a `miss`;
    // treating it as an `error` would retry it against ERROR_BUDGET) and it is a
    // product call, not a ledger one. The row stays visible: it reports as
    // exhausted-AND-fulfilled on the backlog press, which `retryExhausted` clears.
    try {
      await capturePhoto(deps, options.vendorId, focus, cigar.id, listing, stats);
    } catch {
      stats.errors += 1;
    }
    return "match";
  }
  return parsed ? "miss" : "error";
}

// Write this vendor's verdict to the ledger, then RECOMPUTE the request's cached
// status from it. Returns HOW this look retired the request, if it did.
//
// The ledger is the authority and `enrichment_requests.status` is a cache of the
// rollup over it, because the rollup's denominator — the vendors eligible for this
// cigar — changes without any request being touched. Recomputing on every finalize
// is what makes enabling a vendor reopen a row and disabling one retire it, with
// no reopen job anywhere in the system.
//
// The drain no longer claims the request with `status = 'in_progress'` first. That
// was a request-level lock on a per-vendor operation: with two lanes it let one
// vendor skip a row another was looking at, and a crash between the claim and the
// finalize stranded the row where nothing re-selected it (#157 defect 2). The
// increment is an atomic upsert instead, so a crash mid-drain simply leaves the row
// open and two overlapping same-vendor runs record two real looks rather than
// losing one to a read-modify-write (#157 defect 1 degraded to a benign
// double-count, with no FOR UPDATE SKIP LOCKED and no reaper).
async function finalizeEnrichment(
  deps: IngestDeps,
  options: IngestOptions,
  requestId: string,
  // The EVIDENCED market, carried over from the open-set SELECT so the rollup's
  // denominator is computed from the same value the drain filtered on (#170 §2c).
  market: CigarType | null,
  outcome: EnrichmentOutcome,
): Promise<Retirement> {
  const now = deps.now();
  return deps.db.transaction<Retirement>(async (tx) => {
    await recordEnrichmentAttempt(tx, { requestId, vendorId: options.vendorId, outcome, at: now });

    // `enrichment_requests.attempts` is now a REPORTING total of completed looks
    // across every vendor — never a budget again. Incremented in SQL rather than
    // read-modify-written, and on every COMPLETED look (miss or match, never an
    // error), so it stays a true count and legacy pre-0023 values — which counted
    // real looks too — keep their meaning.
    if (outcome !== "error") {
      await tx
        .update(enrichmentRequests)
        .set({ attempts: sql`${enrichmentRequests.attempts} + 1` })
        .where(eq(enrichmentRequests.id, requestId));
    }

    if (outcome === "match") {
      await tx
        .update(enrichmentRequests)
        .set({ status: "fulfilled", resolvedAt: now })
        .where(eq(enrichmentRequests.id, requestId));
      return "open";
    }

    const coverage = await enrichmentCoverageForRequest(tx, requestId, market);
    if (coverage.exhausted) {
      await tx
        .update(enrichmentRequests)
        .set({ status: "exhausted", resolvedAt: now })
        .where(eq(enrichmentRequests.id, requestId));
      return "exhausted";
    }
    // Everything else stays `pending`, and the two reasons are different facts.
    //
    // BLOCKED — every counted lane is retired, but at least one burned
    // ERROR_BUDGET without finishing a look. `exhausted` would be a lie here:
    // nobody could finish looking, and the ledger would carry `attempts = 0`
    // under a verdict that reads "we looked and found nothing". It is not written
    // as `exhausted` and it does not set resolved_at; the honest surface is the
    // rollup, which reports it as blocked, and `retryExhausted` clears it by
    // filing a fresh ask with a fresh error budget.
    //
    // OPEN — no lane counts at all, or one still owes a look. Same reasoning one
    // step earlier, and it self-heals the moment a lane goes live. Clearing
    // resolved_at matters on the reopen path, where a row that had been retired is
    // live again.
    await tx
      .update(enrichmentRequests)
      .set({ status: "pending", resolvedAt: null })
      .where(eq(enrichmentRequests.id, requestId));
    return coverage.blocked ? "blocked" : "open";
  });
}

// --- entry -------------------------------------------------------------------

// PRECONDITION, and it is not enforceable from here: a non-dry run must be entered
// while holding this lane's advisory lock (cli.ts wraps the call in
// withVendorLaneLock). The stranded-run sweep below is only correct under it —
// without the lock it could fail a run that is genuinely in flight.
export async function runIngest(deps: IngestDeps, options: IngestOptions): Promise<IngestResult> {
  const stats = emptyStats();
  const report: string[] = [];

  // This vendor's market, read ONCE from the REGISTRY rather than from the adapter.
  // The adapter carries the same field, but every market predicate downstream —
  // the drain's open set, the exhaustion rollup, both write guards — reads
  // `vendors.focus`, and a crawl acting on a different copy of that fact could
  // write where the rollup says it may not. One indexed read per run removes the
  // whole class of drift. NULL focus means unknown, which the negative filter
  // treats as covering everything and the photo guard treats as no authority to
  // assert either way.
  const vendorRows = await deps.db
    .select({ focus: vendors.focus })
    .from(vendors)
    .where(eq(vendors.id, options.vendorId))
    .limit(1);
  const focus = vendorRows[0]?.focus ?? null;

  const run = async (): Promise<void> => {
    if (options.mode === "enrich") await drainEnrichment(deps, options, focus, stats, report);
    else await walkListings(deps, options, focus, stats, report);
  };

  if (options.dryRun) {
    try {
      await run();
      stats.pagesFetched = deps.fetcher.pagesFetched;
      return { crawlRunId: null, status: "succeeded", stats, report };
    } catch (error) {
      stats.pagesFetched = deps.fetcher.pagesFetched;
      return { crawlRunId: null, status: "failed", stats, error: errorText(error), report };
    }
  }

  // #155: close out anything a previous process for this lane left `running`
  // before opening a new row, so a pod lost to SIGKILL/OOM/node-loss does not leave
  // an immortal row nothing re-selects. Lock-scoped, hence no age ceiling — see
  // reclaimStrandedRuns.
  await reclaimStrandedRuns(deps.db, { vendorId: options.vendorId, kind: options.mode });

  const record = await openCrawlRun(deps.db, {
    vendorId: options.vendorId,
    kind: options.mode,
    now: deps.now,
    host: deps.signalHost,
  });

  try {
    await run();
    stats.pagesFetched = deps.fetcher.pagesFetched;
    await record.close("succeeded", { stats });
    return { crawlRunId: record.crawlRunId, status: "succeeded", stats, report };
  } catch (error) {
    stats.pagesFetched = deps.fetcher.pagesFetched;
    const message = errorText(error);
    await record.close("failed", { stats, error: message });
    return { crawlRunId: record.crawlRunId, status: "failed", stats, error: message, report };
  } finally {
    // Idempotent with close(); the point is that a throw between the two — or a
    // caller that keeps the process alive — never leaves a listener holding a
    // reference to a run that is already over.
    record.dispose();
  }
}
