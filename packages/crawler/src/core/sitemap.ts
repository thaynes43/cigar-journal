import type { Fetcher } from "./fetcher.js";
import { edgeSpreadIndices } from "./spread.js";

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
  children: string[]; // child sitemaps descended into
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
// Deliberately narrow: `item` would match the substring inside "sitemap" and
// make every child a hit.
const PRODUCT_CHILD_HINT = /product|shop|store|catalog/i;

// Which children of a sitemapindex a BOUNDED walk (the probe) descends into.
// Name-matched children first, then an endpoint-inclusive spread of the rest —
// the two together make "products live in child 0", "products live in the last
// child" and "products live in the child called product-sitemap.xml" all
// reachable, where the plain midpoint spread reached none of them past 5
// children. Returned in document order so the list reads against the index.
export function selectIndexChildren(locs: string[], want: number): string[] {
  if (want <= 0) return [];
  const unique = [...new Set(locs)];
  if (unique.length <= want) return unique;

  const picked = new Set<string>();
  const take = (candidates: string[]): void => {
    for (const index of edgeSpreadIndices(candidates.length, want - picked.size)) {
      picked.add(candidates[index]!);
      if (picked.size >= want) return;
    }
  };
  take(unique.filter((loc) => PRODUCT_CHILD_HINT.test(loc)));
  if (picked.size < want) take(unique.filter((loc) => !picked.has(loc)));
  return unique.filter((loc) => picked.has(loc));
}

interface RawSample {
  status: number;
  kind: "urlset" | "sitemapindex" | null;
  rootLocs: number;
  urls: string[];
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
    return { status, kind: null, rootLocs: 0, urls: [], children: [], childFailures: [] };
  }

  const parsed = parseSitemap(body);
  if (parsed.kind === "urlset") {
    return {
      status,
      kind: "urlset",
      rootLocs: parsed.locs.length,
      urls: parsed.locs,
      children: [],
      childFailures: [],
    };
  }

  // Fresh `visited` per sample, seeded with the root at depth 0 — the same state
  // collectSitemapUrls would be in when it recurses, so an unbounded sample walks
  // an index exactly as the plain collector does.
  const visited = new Set<string>([sitemapUrl]);
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

  return { status, kind: "sitemapindex", rootLocs: parsed.locs.length, urls, children, childFailures };
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
