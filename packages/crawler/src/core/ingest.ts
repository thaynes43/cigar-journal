import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import {
  cigars,
  crawlRuns,
  enrichmentRequests,
  productPhotos,
  type Database,
  type EnrichmentRequestRow,
} from "@cj/db";
import { recordPriceObservation } from "@cj/domain";
import { processPhoto as defaultProcessPhoto, type PhotoStorage, type ProcessedPhoto } from "@cj/photos";
import type { VendorAdapter } from "../adapters/types.js";
import { collectSitemapSamples, collectSitemapUrls } from "./sitemap.js";
import { filterProductUrls, pathOf, robotsGatePath } from "./product-url.js";
import { extractJsonLd, type JsonLdProduct } from "./jsonld.js";
import { isCigarListing, normalizeListing, type NormalizedListing } from "./normalize.js";
import { createCigarFromListing, findCatalogMatch, upsertListingMatch } from "./match.js";
import { parseRobots } from "./robots.js";
import { CRAWLER_UA_TOKEN, type Fetcher } from "./fetcher.js";

// The run driver (ADR-006). Three modes share one polite walk: `seed` (catalog
// creation + offers + photos), `offers` (offers-only, never creates a cigar), and
// `enrich` (drain the gap-fill queue with targeted lookups). Every non-dry run is
// bracketed by a crawl_runs row; a `--dry-run` fetches (bounded) and reports the
// would-writes without touching the DB or the object store.

const ENRICH_DEFAULT_LIMIT = 10;
const MAX_ENRICH_CANDIDATES = 8;
const EXHAUST_ATTEMPTS = 2;

export type CrawlMode = "seed" | "offers" | "enrich";

export interface IngestStats {
  pagesFetched: number;
  listingsParsed: number;
  skippedNonCigar: number;
  matchesAuto: number;
  cigarsCreated: number;
  offersWritten: number;
  photosCaptured: number;
  errors: number;
  // Present only for a vendor with sitemapSampling configured — absent keeps the
  // JSONB byte-identical for every other vendor.
  sitemapSampling?: {
    samples: number;
    locsPerSample: number[];
    unionLocs: number;
    productLocs: number;
    varied: boolean;
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
    unionLocs: sampled.urls.length,
    productLocs: urls.length,
    varied: sampled.varied,
  };
  if (urls.length === 0) throw new SitemapEnumerationEmptyError(sampled.samples.length, sampled.urls.length);
  return urls;
}

// --- per-listing ingest ------------------------------------------------------

async function capturePhoto(
  deps: IngestDeps,
  vendorId: string,
  cigarId: string,
  listing: NormalizedListing,
  stats: IngestStats,
): Promise<void> {
  if (!deps.storage || !listing.imageUrl) return;

  const existing = await deps.db
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, cigarId))
    .limit(1);
  if (existing[0]) return;

  const image = await deps.fetcher.fetchBinary(listing.imageUrl);
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
  url: string,
  listing: NormalizedListing,
  product: JsonLdProduct,
  stats: IngestStats,
): Promise<void> {
  const now = deps.now();
  const listingKey = pathOf(url);

  const cigarId = await deps.db.transaction(async (tx) => {
    const hit = await findCatalogMatch(tx, listing.name);
    let linkedCigarId: string | null = null;
    let status: "auto" | "unmatched";

    if (hit) {
      linkedCigarId = hit.cigarId;
      status = "auto";
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
      await capturePhoto(deps, options.vendorId, cigarId, listing, stats);
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

      await ingestListing(deps, options, url, listing, product, stats);
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
  const pending = await deps.db
    .select()
    .from(enrichmentRequests)
    .where(eq(enrichmentRequests.status, "pending"))
    .orderBy(asc(enrichmentRequests.createdAt))
    .limit(limit);

  for (const request of pending) {
    const cigarRows = await deps.db
      .select({ id: cigars.id, canonicalName: cigars.canonicalName })
      .from(cigars)
      .where(eq(cigars.id, request.cigarId))
      .limit(1);
    const cigar = cigarRows[0];
    if (!cigar) continue;

    if (!options.dryRun) {
      await deps.db
        .update(enrichmentRequests)
        .set({ status: "in_progress" })
        .where(eq(enrichmentRequests.id, request.id));
    }

    const wanted = slugTokens(cigar.canonicalName);
    const ranked = candidates
      .map((candidate) => ({ ...candidate, score: overlap(wanted, candidate.tokens) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ENRICH_CANDIDATES);

    const matched = await tryEnrichCandidates(deps, options, cigar, ranked, stats, report);
    if (options.dryRun) continue;

    await finalizeEnrichment(deps, request, matched);
  }
}

async function tryEnrichCandidates(
  deps: IngestDeps,
  options: IngestOptions,
  cigar: { id: string; canonicalName: string },
  ranked: { url: string }[],
  stats: IngestStats,
  report: string[],
): Promise<boolean> {
  const { adapter } = options;
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
    stats.listingsParsed += 1;
    if (!isCigarListing(listing, adapter)) {
      stats.skippedNonCigar += 1;
      continue;
    }

    const sim = await nameSimilarity(deps, cigar.canonicalName, listing.name);
    if (sim <= 0.55) continue;

    if (options.dryRun) {
      report.push(`enrich ${pathOf(candidate.url)}  ${listing.name}  (sim=${sim.toFixed(2)}) → ${cigar.canonicalName}`);
      return true;
    }

    const now = deps.now();
    await deps.db.transaction(async (tx) => {
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
    });

    try {
      await capturePhoto(deps, options.vendorId, cigar.id, listing, stats);
    } catch {
      stats.errors += 1;
    }
    return true;
  }
  return false;
}

// pending → fulfilled on a hit; on a miss increment attempts and either fall back
// to pending (retryable next run) or mark exhausted once every attempt is spent.
async function finalizeEnrichment(deps: IngestDeps, request: EnrichmentRequestRow, matched: boolean): Promise<void> {
  const now = deps.now();
  if (matched) {
    await deps.db
      .update(enrichmentRequests)
      .set({ status: "fulfilled", resolvedAt: now })
      .where(eq(enrichmentRequests.id, request.id));
    return;
  }
  const attempts = request.attempts + 1;
  if (attempts >= EXHAUST_ATTEMPTS) {
    await deps.db
      .update(enrichmentRequests)
      .set({ status: "exhausted", attempts, resolvedAt: now })
      .where(eq(enrichmentRequests.id, request.id));
  } else {
    await deps.db
      .update(enrichmentRequests)
      .set({ status: "pending", attempts })
      .where(eq(enrichmentRequests.id, request.id));
  }
}

// --- entry -------------------------------------------------------------------

export async function runIngest(deps: IngestDeps, options: IngestOptions): Promise<IngestResult> {
  const stats = emptyStats();
  const report: string[] = [];

  const run = async (): Promise<void> => {
    if (options.mode === "enrich") await drainEnrichment(deps, options, stats, report);
    else await walkListings(deps, options, stats, report);
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

  const started = await deps.db
    .insert(crawlRuns)
    .values({ vendorId: options.vendorId, kind: options.mode, status: "running", startedAt: deps.now() })
    .returning({ id: crawlRuns.id });
  const crawlRunId = started[0]!.id;

  try {
    await run();
    stats.pagesFetched = deps.fetcher.pagesFetched;
    await deps.db
      .update(crawlRuns)
      .set({ status: "succeeded", stats, finishedAt: deps.now() })
      .where(eq(crawlRuns.id, crawlRunId));
    return { crawlRunId, status: "succeeded", stats, report };
  } catch (error) {
    stats.pagesFetched = deps.fetcher.pagesFetched;
    const message = errorText(error);
    await deps.db
      .update(crawlRuns)
      .set({ status: "failed", stats, error: message, finishedAt: deps.now() })
      .where(eq(crawlRuns.id, crawlRunId));
    return { crawlRunId, status: "failed", stats, error: message, report };
  }
}
