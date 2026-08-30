import type { VendorAdapter } from "../adapters/types.js";

// The single home for "is this enumerated URL a product listing?" — the question
// ingest and the probe both ask, and which used to be an inlined `startsWith`
// duplicated in both. Two adapter gate modes (ADR-006 amendment 2026-08-29):
//
//   Mode A, prefix     — Fox `/shop/`, Cuban Lou's `/` (product-only sitemap),
//                        optionally MINUS a non-product subtree under that prefix
//                        (2 Guys `/store/` minus `/store/go/`, amendment 2026-08-30).
//   Mode B, exclusion  — Small Batch: products are ROOT-LEVEL slugs, so there is
//                        no prefix to match; reject known non-product paths and
//                        constrain the path depth instead.
//
// The same file also owns the ROBOTS gate path, which is a different job from the
// URL filter even though one field used to serve both: the robots check needs a
// single coarse path to ask `isAllowed` about, and a Mode-B adapter has none.

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// Non-empty path segments: "/a/b/" → 2, "/" → 0.
export function segmentCount(path: string): number {
  return path.split("/").filter((segment) => segment.length > 0).length;
}

export function isProductUrl(url: string, adapter: VendorAdapter): boolean {
  const path = pathOf(url);
  const { productPathPrefix, nonProductPathPattern, productPathSegments } = adapter;
  // Mode A — inside the prefix AND NOT in a known non-product subtree. The
  // subtraction is optional: an adapter that sets no pattern behaves exactly as
  // the original inline `startsWith` filter did.
  if (productPathPrefix !== undefined) {
    if (!path.startsWith(productPathPrefix)) return false;
    return nonProductPathPattern === undefined || !nonProductPathPattern.test(path);
  }
  // Mode B. Unreachable through the type union (no prefix means the pattern is
  // required); refusing rather than admitting keeps a malformed adapter from
  // crawling a whole store.
  if (nonProductPathPattern === undefined) return false;
  if (nonProductPathPattern.test(path)) return false;
  const segments = segmentCount(path);
  const min = productPathSegments?.min;
  const max = productPathSegments?.max;
  return (min === undefined || segments >= min) && (max === undefined || segments <= max);
}

export function filterProductUrls(urls: string[], adapter: VendorAdapter): string[] {
  return urls.filter((url) => isProductUrl(url, adapter));
}

// The coarse path the robots gate is asked about before a crawl starts. Mode B
// has no product prefix, so it names one explicitly or falls back to the site root.
export function robotsGatePath(adapter: VendorAdapter): string {
  return adapter.productPathPrefix ?? adapter.robotsProbePath ?? "/";
}

// Human-readable gate description for probe/CLI output.
export function productGateLabel(adapter: VendorAdapter): string {
  if (adapter.productPathPrefix !== undefined) {
    // The subtraction is printed because it is the difference between "this
    // vendor has no products" and "this build has the narrowed gate" — the probe
    // line is how the coordinator tells a rebuilt image from a cached one.
    const minus = adapter.nonProductPathPattern ? ` minus ${String(adapter.nonProductPathPattern)}` : "";
    return `prefix ${adapter.productPathPrefix}${minus}`;
  }
  const segments = adapter.productPathSegments;
  const range = segments ? ` segments ${segments.min ?? 0}..${segments.max ?? "*"}` : "";
  return `not ${String(adapter.nonProductPathPattern)}${range}`;
}

// --- path-shape census -------------------------------------------------------
// A pure count of URL SHAPES, keyed on the first `depth` path segments. Lives
// here because this file already owns path shape (`pathOf`, `segmentCount`), and
// it answers the question the gate cannot: not "did anything pass?" but "what
// KINDS of URL are on each side of the gate?".
//
// The probe runs it over the accepted and rejected sets. It costs nothing — the
// URLs are already fetched — and it is the difference between one coordinator
// Job and two: on 2026-08-30 it would have named `/store/go` immediately instead
// of leaving `parsed=0` to read as "this vendor has no JSON-LD". Where a gate
// admits nothing, the rejected side names where the products actually live.

// Keys shown before the tail collapses the rest. Five keeps the line readable on
// a terminal while still separating a dominant shape from its long tail.
export const PATH_CENSUS_TOP = 5;

export interface PathCensusEntry {
  key: string;
  count: number;
}

export interface PathCensus {
  top: PathCensusEntry[];
  // What the top-N cut off, counted both ways: distinct keys, and URLs behind
  // them. A large `otherUrls` under a small `otherKeys` is a second shape worth
  // widening the census for; a large `otherKeys` with `otherUrls ~= otherKeys` is
  // the per-product tail you expect from a healthy catalog.
  otherKeys: number;
  otherUrls: number;
  total: number;
}

export function pathShapeCensus(urls: string[], depth = 2): PathCensus {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const segments = pathOf(url)
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(0, depth);
    const key = segments.length > 0 ? `/${segments.join("/")}` : "/";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Ties broken on the key so two probes of an unchanged site print an identical
  // line — an operator diffing runs should see movement only when shape moved.
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rest = ranked.slice(PATH_CENSUS_TOP);
  return {
    top: ranked.slice(0, PATH_CENSUS_TOP).map(([key, count]) => ({ key, count })),
    otherKeys: rest.length,
    otherUrls: rest.reduce((sum, [, count]) => sum + count, 0),
    total: urls.length,
  };
}
