import type { Fetcher } from "./fetcher.js";
import { spreadIndices } from "./spread.js";

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

export interface SitemapSample {
  attempt: number; // 1-based
  status: number; // ROOT fetch status
  kind: "urlset" | "sitemapindex" | null;
  rootLocs: number; // <loc> count in the root document
  enumerated: number; // page URLs this sample yielded
  newUrls: number; // URLs no earlier sample had
  children: string[]; // child sitemaps descended into
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

interface RawSample {
  status: number;
  kind: "urlset" | "sitemapindex" | null;
  rootLocs: number;
  urls: string[];
  children: string[];
}

async function takeSample(
  fetcher: Fetcher,
  sitemapUrl: string,
  maxChildren: number | undefined,
): Promise<RawSample> {
  const { status, body } = await fetcher.fetchText(sitemapUrl);
  if (status !== 200) return { status, kind: null, rootLocs: 0, urls: [], children: [] };

  const parsed = parseSitemap(body);
  if (parsed.kind === "urlset") {
    return { status, kind: "urlset", rootLocs: parsed.locs.length, urls: parsed.locs, children: [] };
  }

  // Fresh `visited` per sample, seeded with the root at depth 0 — the same state
  // collectSitemapUrls would be in when it recurses, so an unbounded sample walks
  // an index exactly as the plain collector does.
  const visited = new Set<string>([sitemapUrl]);
  const children =
    maxChildren === undefined
      ? parsed.locs
      : spreadIndices(parsed.locs.length, maxChildren).map((i) => parsed.locs[i]!);

  const urls: string[] = [];
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
    if (res.status !== 200) continue;
    const childParsed = parseSitemap(res.body);
    if (childParsed.kind === "urlset") urls.push(...childParsed.locs);
  }

  return { status, kind: "sitemapindex", rootLocs: parsed.locs.length, urls, children };
}

function sameUrls(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((url) => set.has(url));
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
    });
  }

  const first = perSampleUrls[0] ?? [];
  const varied = samples.length > 1 && perSampleUrls.some((sample) => !sameUrls(sample, first));
  return { urls, samples, varied };
}
