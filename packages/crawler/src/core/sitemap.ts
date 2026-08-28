import type { Fetcher } from "./fetcher.js";

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
