// @cj/crawler — the vendor crawl substrate (ADR-006). Generic core (fetch,
// sitemap, JSON-LD, normalize, match, ingest) driven by small per-vendor adapter
// objects; runs as the image's `crawl` role via src/cli.ts. Library surface here;
// the CLI entry is src/cli.ts.

export type {
  VendorAdapter,
  VendorAdapterBase,
  PrefixVendorAdapter,
  ExclusionVendorAdapter,
  PrefixProductGate,
  ExclusionProductGate,
  SitemapSampling,
} from "./adapters/types.js";
export {
  adapters,
  getAdapter,
  adapterSlugs,
  foxCigar,
  twoGuysCigars,
  smallBatchCigar,
  cubanLous,
} from "./adapters/index.js";

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
export {
  parseSitemap,
  collectSitemapUrls,
  collectSitemapSamples,
  selectIndexChildren,
  MAX_SITEMAP_SAMPLES,
  type ParsedSitemap,
  type ChildFetchFailure,
  type SitemapSample,
  type SampledSitemap,
  type SampleOptions,
} from "./core/sitemap.js";
export { spreadIndices, edgeSpreadIndices } from "./core/spread.js";
export {
  pathOf,
  segmentCount,
  isProductUrl,
  filterProductUrls,
  robotsGatePath,
  productGateLabel,
} from "./core/product-url.js";
export {
  runProbe,
  formatProbe,
  probeFetchBudget,
  MAX_PROBE_CHILDREN,
  PRODUCT_SAMPLES,
  REQUIRED_PARSED_SAMPLES,
  type ProbeResult,
  type ProbeProductSample,
} from "./core/probe.js";
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
  SitemapEnumerationEmptyError,
  type IngestDeps,
  type IngestOptions,
  type IngestResult,
  type IngestStats,
  type CrawlMode,
} from "./core/ingest.js";

// Brand imagery (issue #127): the Wikidata/Commons client and the job driver
// behind `crawl --brand-images`. An official-API client under ADR-006's Reddit-API
// posture — not a vendor adapter.
export {
  resolveBrandImage,
  lookupChosenEntity,
  qualifyCandidates,
  selectImageFile,
  parseImageInfo,
  licenseAllowed,
  buildCreditLine,
  fold,
  searchUrl,
  entitiesUrl,
  imageInfoUrl,
  WikimediaUnavailableError,
  WIKIDATA_API,
  COMMONS_API,
  type BrandImageLookup,
  type CommonsImage,
  type WikidataEntity,
} from "./core/wikidata.js";
export { WIKIDATA_TAXONOMY, taxonomyIsUnseeded, type WikidataTaxonomy } from "./core/wikidata-taxonomy.js";
export {
  runBrandImages,
  probeBrandTaxonomy,
  uncoveredBrands,
  selectWork,
  type BrandImagesDeps,
  type BrandImagesOptions,
  type BrandImagesResult,
  type BrandImagesStats,
} from "./core/brand-images.js";
