// @cj/crawler — the vendor crawl substrate (ADR-006). Generic core (fetch,
// sitemap, JSON-LD, normalize, match, ingest) driven by small per-vendor adapter
// objects; runs as the image's `crawl` role via src/cli.ts. Library surface here;
// the CLI entry is src/cli.ts.

export type { VendorAdapter } from "./adapters/types.js";
export { adapters, getAdapter, adapterSlugs, foxCigar } from "./adapters/index.js";

export { parseRobots, type Robots } from "./core/robots.js";
export {
  createFetcher,
  CRAWLER_UA,
  CRAWLER_UA_TOKEN,
  MaxPagesExceededError,
  type Fetcher,
  type FetcherOptions,
  type FetchTextResult,
  type FetchBinaryResult,
} from "./core/fetcher.js";
export { parseSitemap, collectSitemapUrls, type ParsedSitemap } from "./core/sitemap.js";
export { extractJsonLd, type ExtractedJsonLd, type JsonLdProduct, type JsonLdOffer } from "./core/jsonld.js";
export { normalizeListing, isCigarCategory, isCigarListing, decodeEntities, type NormalizedListing } from "./core/normalize.js";
export {
  findCatalogMatch,
  upsertListingMatch,
  createCigarFromListing,
  MATCH_THRESHOLD,
  type CatalogHit,
} from "./core/match.js";
export {
  runIngest,
  RobotsDisallowedError,
  type IngestDeps,
  type IngestOptions,
  type IngestResult,
  type IngestStats,
  type CrawlMode,
} from "./core/ingest.js";
