import type { Fetcher } from "./fetcher.js";
import { edgeSpreadIndices, spreadIndices } from "./spread.js";

// Sitemap parsing by regex (importer-style pragmatism — the shapes are regular
// and a dependency-free `<loc>` sweep is enough). Supports both a flat urlset
// and a sitemapindex, and the collector recurses an index into its child
// sitemaps through the shared limiter.

export interface ParsedSitemap {
  kind: "urlset" | "sitemapindex";
  locs: string[];
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseSitemap(xml: string): ParsedSitemap {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "sitemapindex" : "urlset";
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) =>
    decodeXmlEntities(m[1]!.trim()),
  );
  return { kind, locs };
}

// Fetch a sitemap and return the page URLs it (transitively) enumerates. A
// sitemapindex is expanded one level per child; a `visited` set + depth cap
// guard against cycles or a pathological nest. Child fetch failures are skipped,
// not fatal — a partial enumeration still seeds most of the catalog.
export async function collectSitemapUrls(
  fetcher: Fetcher,
  sitemapUrl: string,
  depth = 0,
  visited: Set<string> = new Set(),
): Promise<string[]> {
  if (depth > 3 || visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);

  const { status, body } = await fetcher.fetchText(sitemapUrl);
  if (status !== 200) return [];

  const parsed = parseSitemap(body);
  if (parsed.kind === "urlset") return parsed.locs;

  const urls: string[] = [];
  for (const child of parsed.locs) {
    urls.push(...(await collectSitemapUrls(fetcher, child, depth + 1, visited)));
  }
  return urls;
}

// --- sampling ----------------------------------------------------------------
// Some vendors serve DIFFERENT sitemap content on consecutive requests. 2 Guys,
// live 2026-08-29: one fetch of the same URL returned 1,462 `/store/` product
// locs, the next 6,356 locs with zero `/store/` entries. A single fetch there is
// a coin flip, and losing it looks like a healthy "succeeded, 0 listings" run.
// Sampling takes N root fetches and unions them; opt-in per adapter, because for
// a stable vendor it is N times the requests for identical output.

export const MAX_SITEMAP_SAMPLES = 8;

export interface ChildFetchFailure {
  url: string;
  status: number;
}

export interface SitemapSample {
  attempt: number; // 1-based
  status: number; // ROOT fetch status
  kind: "urlset" | "sitemapindex" | null;
  rootLocs: number; // <loc> count in the root document
  enumerated: number; // page URLs this sample yielded
  newUrls: number; // URLs no earlier sample had
  // Every child the root listed, and the subset this sample descended into. A
  // varying vendor can list a DIFFERENT child set per fetch, so coverage has to
  // be measured against the children actually seen, not against one root's count.
  rootChildren: string[];
  children: string[];
  // Children that answered non-200 in BOUNDED mode. A skipped child looks
  // identical to an empty one in `enumerated`, and "the index 403s us" is a
  // different fix from "the gate is wrong" — the probe reports these.
  childFailures: ChildFetchFailure[];
}

export interface SampledSitemap {
  urls: string[];
  samples: SitemapSample[];
  varied: boolean;
}

export interface SampleOptions {
  samples?: number; // default 1
  intervalMs?: number; // default 0 — the fetcher's own limiter already spaces requests
  // Cap on children descended into per sample. Unset (ingest) walks the whole
  // index through collectSitemapUrls; set (probe) takes a spread of at most this
  // many children, ONE level deep, so the probe's fetch count stays predictable.
  maxChildren?: number;
  sleep?: (ms: number) => Promise<void>; // test seam
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A sitemapindex carries one strong hint a positional pick throws away: its
// child NAMES. A stock Yoast/Woo index parks the catalog in `product-sitemap*.xml`
// at an arbitrary position among post/page/category/product_cat/product_tag/author
// children, so a bounded positional sample misses it more often than it hits it.
// Matched on the FILE NAME, not the whole URL — on `https://shop.example.com/`
// every child would otherwise be a hit. Deliberately narrow: `item` would match
// the substring inside "sitemap" and do the same.
const PRODUCT_CHILD_HINT = /product|shop|store|catalog/i;

// Woo/Yoast parks its TAXONOMY sitemaps right beside the catalog, and every one
// of them matches the hint above: product_cat, product_tag, product_brand,
// product-category, product_shipping_class. They enumerate term archives, not
// products, so treating all hint matches alike lets three taxonomies crowd the
// one catalog child out of a 3-child budget — a shape the plain midpoint pick
// happened to get right. Demoted below the catalog-shaped names, not excluded:
// a vendor that really does enumerate products from `product-category-sitemap.xml`
// is still reachable on the leftover budget.
const TAXONOMY_CHILD_HINT =
  /(?:^|[^a-z])(?:cat|categor(?:y|ies)|tag|brand|attribute|type|class|vendor|term)s?(?:[^a-z]|$)/i;

function childName(loc: string): string {
  const path = loc.split(/[?#]/)[0]!;
  return path.slice(path.lastIndexOf("/") + 1);
}

function isCatalogChild(loc: string): boolean {
  const name = childName(loc);
  return PRODUCT_CHILD_HINT.test(name) && !TAXONOMY_CHILD_HINT.test(name);
}

// Which children of a sitemapindex a BOUNDED walk (the probe) descends into, in
// priority order:
//
//   1. catalog-shaped names (`product-sitemap.xml`, `shop-sitemap.xml`), capped
//      at `want - 2` slots so step 2 always fits;
//   2. the first and last child of the index itself — the two positions a
//      midpoint spread is structurally blind to;
//   3. taxonomy-shaped product children, then everything else, spread across the
//      interior the ends already bracket.
//
// The cap is what makes the endpoint guarantee real rather than nominal: with a
// budget of 3 or more, children[0] and children[n-1] are ALWAYS fetched, and the
// name hint spends what is left. One catalog child is enough to prove a vendor
// enumerates products, so capping the hint costs the probe nothing.
// Returned in document order so the list reads against the index.
export function selectIndexChildren(locs: string[], want: number): string[] {
  if (want <= 0) return [];
  const unique = [...new Set(locs)];
  if (unique.length <= want) return unique;

  const picked = new Set<string>();
  const room = (): number => want - picked.size;
  const take = (
    candidates: string[],
    slots: number,
    spread: (total: number, n: number) => number[],
  ): void => {
    const n = Math.min(slots, room());
    if (n <= 0) return;
    for (const index of spread(candidates.length, n)) picked.add(candidates[index]!);
  };
  const unpicked = (candidates: string[]): string[] => candidates.filter((loc) => !picked.has(loc));

  take(unique.filter(isCatalogChild), Math.max(1, want - 2), edgeSpreadIndices);
  if (room() > 0) picked.add(unique[0]!);
  if (room() > 0) picked.add(unique[unique.length - 1]!);
  // Both ends are anchored above, so the leftover budget is best spent on the
  // interior — which is what the midpoint spread is for.
  take(unpicked(unique.filter((loc) => PRODUCT_CHILD_HINT.test(childName(loc)))), room(), spreadIndices);
  take(unpicked(unique), room(), spreadIndices);

  return unique.filter((loc) => picked.has(loc));
}

interface RawSample {
  status: number;
  kind: "urlset" | "sitemapindex" | null;
  rootLocs: number;
  urls: string[];
  rootChildren: string[];
  children: string[];
  childFailures: ChildFetchFailure[];
}

async function takeSample(
  fetcher: Fetcher,
  sitemapUrl: string,
  maxChildren: number | undefined,
): Promise<RawSample> {
  const { status, body } = await fetcher.fetchText(sitemapUrl);
  if (status !== 200) {
    return { status, kind: null, rootLocs: 0, urls: [], rootChildren: [], children: [], childFailures: [] };
  }

  const parsed = parseSitemap(body);
  if (parsed.kind === "urlset") {
    return {
      status,
      kind: "urlset",
      rootLocs: parsed.locs.length,
      urls: parsed.locs,
      rootChildren: [],
      children: [],
      childFailures: [],
    };
  }

  // Fresh `visited` per sample, seeded with the root at depth 0 — the same state
  // collectSitemapUrls would be in when it recurses, so an unbounded sample walks
  // an index exactly as the plain collector does.
  const visited = new Set<string>([sitemapUrl]);
  const rootChildren = [...new Set(parsed.locs)];
  const children =
    maxChildren === undefined ? parsed.locs : selectIndexChildren(parsed.locs, maxChildren);

  const urls: string[] = [];
  const childFailures: ChildFetchFailure[] = [];
  for (const child of children) {
    if (maxChildren === undefined) {
      urls.push(...(await collectSitemapUrls(fetcher, child, 1, visited)));
      continue;
    }
    // Bounded: one level, no recursion into a nested index. A nested index would
    // otherwise multiply fetches per level and blow the probe's page guard.
    if (visited.has(child)) continue;
    visited.add(child);
    const res = await fetcher.fetchText(child);
    if (res.status !== 200) {
      childFailures.push({ url: child, status: res.status });
      continue;
    }
    const childParsed = parseSitemap(res.body);
    if (childParsed.kind === "urlset") urls.push(...childParsed.locs);
  }

  return {
    status,
    kind: "sitemapindex",
    rootLocs: parsed.locs.length,
    urls,
    rootChildren,
    children,
    childFailures,
  };
}

// Multiset comparison, not set comparison: a response that drops one loc and
// duplicates another has the same length AND the same membership as the original,
// and calling that pair identical reports a varying vendor as stable — the exact
// conclusion that would send an operator back to samples: 1.
function sameUrls(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((url, index) => url === sortedB[index]);
}

// Take N samples of one sitemap and union them in first-seen order. `varied` is
// the signal the coordinator acts on: it means the vendor did not serve the same
// enumeration twice, so any single-fetch crawl of it is non-deterministic.
export async function collectSitemapSamples(
  fetcher: Fetcher,
  sitemapUrl: string,
  options: SampleOptions = {},
): Promise<SampledSitemap> {
  const want = Math.min(Math.max(Math.trunc(options.samples ?? 1), 1), MAX_SITEMAP_SAMPLES);
  const intervalMs = options.intervalMs ?? 0;
  const sleep = options.sleep ?? defaultSleep;

  const samples: SitemapSample[] = [];
  const perSampleUrls: string[][] = [];
  const urls: string[] = [];
  const seen = new Set<string>();

  for (let attempt = 1; attempt <= want; attempt++) {
    if (attempt > 1 && intervalMs > 0) await sleep(intervalMs);
    const raw = await takeSample(fetcher, sitemapUrl, options.maxChildren);

    let newUrls = 0;
    for (const url of raw.urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      newUrls += 1;
    }

    perSampleUrls.push(raw.urls);
    samples.push({
      attempt,
      status: raw.status,
      kind: raw.kind,
      rootLocs: raw.rootLocs,
      enumerated: raw.urls.length,
      newUrls,
      rootChildren: raw.rootChildren,
      children: raw.children,
      childFailures: raw.childFailures,
    });
  }

  // Only samples whose ROOT fetch succeeded can testify to variance. A 503
  // enumerates nothing, and scoring that as "this vendor serves different content
  // per request" writes a permanent varied=true into crawl_runs.stats for a
  // vendor whose sitemap was merely flaky once.
  const fetched = perSampleUrls.filter((_, index) => samples[index]!.status === 200);
  const first = fetched[0] ?? [];
  const varied = fetched.length > 1 && fetched.some((sample) => !sameUrls(sample, first));
  return { urls, samples, varied };
}
