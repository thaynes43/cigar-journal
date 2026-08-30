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
