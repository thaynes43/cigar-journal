import { extractJsonLd } from "./jsonld.js";
import { isCigarListing, normalizeListing } from "./normalize.js";
import { parseRobots } from "./robots.js";
import { collectSitemapSamples, type SitemapSample } from "./sitemap.js";
import { filterProductUrls, productGateLabel, robotsGatePath } from "./product-url.js";
import { spreadIndices } from "./spread.js";
import { CRAWLER_UA_TOKEN, type Fetcher } from "./fetcher.js";
import type { VendorAdapter } from "../adapters/types.js";

// The `--probe` verdict (ADR-006 live-verification rule). The dev pod cannot
// reach vendor domains, so a new adapter's robots/ToS/sitemap/product shapes are
// unverified ASSUMPTIONS; the coordinator runs this in-cluster BEFORE the registry
// enables crawling. Unlike dry-run (which walks the whole catalog, bounded by
// --limit, and reports would-writes), probe takes a BOUNDED read — robots, N
// sitemap samples, up to MAX_PROBE_CHILDREN index children, and PRODUCT_SAMPLES
// spread-apart product pages — parses them, WRITES NOTHING, and prints a
// pass/needs-attention verdict so a bad assumption surfaces before any crawl.
// `probeFetchBudget` is the fetch ceiling the CLI sizes its page guard from.

// Children of a sitemapindex to descend into per sample. More than one because
// an index whose products live in the LAST child looked empty to the old
// first-child probe; bounded because a probe must not walk a 20k-URL catalog.
export const MAX_PROBE_CHILDREN = 3;
// Product pages parsed per probe, spread across the enumeration.
export const PRODUCT_SAMPLES = 3;
// Parses required for an `ok` verdict, floored at the number actually sampled.
// One parse proves the JSON-LD extractor works but NOT that the enumeration
// selects products — the mirror image of the bug this exists to catch. Two
// spread-apart parses prove both. Requiring all three would re-import the false
// negative, since real sitemaps always carry a few redirects and 410s.
export const REQUIRED_PARSED_SAMPLES = 2;

export interface ProbeProductSample {
  url: string;
  status: number;
  hasProduct: boolean;
  name: string | null;
  priceCents: number | null;
  currency: string | null;
  breadcrumbs: string[];
  isCigar: boolean;
  // 200 + a schema.org Product + a usable name: what the crawl needs to write a row.
  parsed: boolean;
}

export interface ProbeResult {
  vendor: string;
  // Human-readable product gate (prefix, or the exclusion pattern + depth bounds).
  gate: string;
  robots: {
    status: number;
    matchedAgent: string;
    productPathAllowed: boolean;
  };
  sitemap: {
    url: string;
    status: number;
    kind: "urlset" | "sitemapindex" | null;
    // Total <loc> entries at the root (child sitemaps for an index, page URLs for
    // a urlset), and how many of the *enumerated* URLs pass the product gate.
    totalLocs: number;
    productLocs: number;
    // Union size across samples, and the child sitemaps descended into.
    enumeratedLocs: number;
    sampledChildren: string[];
    // One entry per root fetch (length 1 when sampling is off).
    samples: SitemapSample[];
    // The samples did not all enumerate the same set — a single-fetch crawl of
    // this vendor is non-deterministic.
    varied: boolean;
  };
  products: ProbeProductSample[];
  productSummary: { sampled: number; parsed: number; cigars: number };
  verdict: "ok" | "needs-attention";
  notes: string[];
}

// Upper bound on text fetches one probe makes, so the CLI's max-pages guard can
// be derived rather than guessed. robots + samples * (root + children) + product
// samples, plus a small slack for a redirect chain.
export function probeFetchBudget(adapter: VendorAdapter): number {
  const samples = Math.max(1, adapter.sitemapSampling?.samples ?? 1);
  return 1 + samples * (1 + MAX_PROBE_CHILDREN) + PRODUCT_SAMPLES + 2;
}

// Fetch robots.txt + N sitemap samples (+ a spread of index children) + a spread
// of product pages. No DB, no storage — a pure read that reports what the crawl
// WOULD see.
export async function runProbe(fetcher: Fetcher, adapter: VendorAdapter): Promise<ProbeResult> {
  const notes: string[] = [];
  const gate = productGateLabel(adapter);
  const gatePath = robotsGatePath(adapter);

  // --- robots --------------------------------------------------------------
  const robotsUrl = new URL("/robots.txt", adapter.url).toString();
  const robotsRes = await fetcher.fetchText(robotsUrl);
  // A missing/failed robots.txt is fully permissive (RFC 9309), same as ingest.
  const robots = parseRobots(robotsRes.status === 200 ? robotsRes.body : "", CRAWLER_UA_TOKEN);
  const productPathAllowed = robots.isAllowed(gatePath);
  if (robotsRes.status !== 200) notes.push(`robots.txt returned ${robotsRes.status} — treated as permissive.`);
  if (!productPathAllowed) notes.push(`robots.txt DISALLOWS ${gatePath} for our UA — crawl refused.`);

  // --- sitemap -------------------------------------------------------------
  const sampled = await collectSitemapSamples(fetcher, adapter.sitemapUrl, {
    samples: adapter.sitemapSampling?.samples ?? 1,
    intervalMs: adapter.sitemapSampling?.intervalMs,
    maxChildren: MAX_PROBE_CHILDREN,
  });
  const samples = sampled.samples;
  const locsPerSample = samples.map((s) => s.enumerated);
  const kind = samples.find((s) => s.kind !== null)?.kind ?? null;
  const sampledChildren = [...new Set(samples.flatMap((s) => s.children))];
  const anyOk = samples.some((s) => s.status === 200);

  if (!anyOk) {
    const statuses = [...new Set(samples.map((s) => s.status))].join("/");
    notes.push(`sitemap ${adapter.sitemapUrl} returned ${statuses} — enumeration will yield nothing.`);
  } else {
    for (const sample of samples) {
      if (sample.status !== 200) notes.push(`sitemap sample ${sample.attempt} returned ${sample.status}.`);
    }
  }
  if (sampled.varied) {
    notes.push(
      `sitemap content VARIES between fetches: locs ${locsPerSample.join("/")} across ${samples.length} ` +
        `samples — union ${sampled.urls.length} used.`,
    );
  }
  if (anyOk && sampled.urls.length === 0) {
    notes.push(`all ${samples.length} sitemap sample(s) enumerated 0 URLs.`);
  }
  if (kind === "sitemapindex" && sampledChildren.length === 0) {
    notes.push("sitemapindex is empty — no child sitemaps.");
  }

  const productUrls = filterProductUrls(sampled.urls, adapter);
  if (anyOk && sampled.urls.length > 0 && productUrls.length === 0) {
    notes.push(`no enumerated URL passes the product gate (${gate}) — the gate or sitemap shape is likely wrong.`);
  }

  const sitemap: ProbeResult["sitemap"] = {
    url: adapter.sitemapUrl,
    status: samples[0]!.status,
    kind,
    totalLocs: kind === "sitemapindex" ? sampled.urls.length : Math.max(0, ...samples.map((s) => s.rootLocs)),
    productLocs: productUrls.length,
    enumeratedLocs: sampled.urls.length,
    sampledChildren,
    samples,
    varied: sampled.varied,
  };

  // --- product pages -------------------------------------------------------
  const products: ProbeProductSample[] = [];
  if (productPathAllowed && productUrls.length > 0) {
    for (const index of spreadIndices(productUrls.length, PRODUCT_SAMPLES)) {
      const url = productUrls[index]!;
      const res = await fetcher.fetchText(url);
      const { product: jsonLd, breadcrumbs } = extractJsonLd(res.status === 200 ? res.body : "");
      const listing = jsonLd ? normalizeListing(jsonLd, breadcrumbs) : null;
      if (res.status !== 200) notes.push(`sample product ${url} returned ${res.status}.`);
      else if (!jsonLd) notes.push(`sample product ${url} has no schema.org Product JSON-LD — parsing yields nothing.`);
      else if (!listing) notes.push(`sample product ${url} JSON-LD has no usable name.`);
      products.push({
        url,
        status: res.status,
        hasProduct: jsonLd !== null,
        name: listing?.name ?? null,
        priceCents: listing?.priceCents ?? null,
        currency: listing?.currency ?? null,
        breadcrumbs,
        isCigar: listing ? isCigarListing(listing, adapter) : false,
        parsed: listing !== null,
      });
    }
  } else if (productPathAllowed) {
    notes.push("no product URL to sample — cannot verify JSON-LD parsing.");
  }

  const productSummary = {
    sampled: products.length,
    parsed: products.filter((p) => p.parsed).length,
    cigars: products.filter((p) => p.isCigar).length,
  };
  const requiredParses = Math.min(REQUIRED_PARSED_SAMPLES, productSummary.sampled);
  const verdict: ProbeResult["verdict"] =
    productPathAllowed && productUrls.length > 0 && productSummary.parsed >= requiredParses
      ? "ok"
      : "needs-attention";

  return {
    vendor: adapter.name,
    gate,
    robots: { status: robotsRes.status, matchedAgent: robots.matchedAgent, productPathAllowed },
    sitemap,
    products,
    productSummary,
    verdict,
    notes,
  };
}

export function formatProbe(result: ProbeResult): string {
  const s = result.sitemap;
  const lines: string[] = [
    `probe ${result.vendor}  verdict=${result.verdict}  gate=${result.gate}`,
    `  robots: status=${result.robots.status} agent=${result.robots.matchedAgent} ` +
      `allows=${result.robots.productPathAllowed}`,
    `  sitemap: status=${s.status} kind=${s.kind ?? "-"} locs=${s.totalLocs} product-locs=${s.productLocs}` +
      (s.sampledChildren.length > 0 ? ` children=${s.sampledChildren.join(",")}` : ""),
  ];
  if (s.samples.length > 1) {
    lines.push(
      `  samples: n=${s.samples.length} locs=${s.samples.map((x) => x.enumerated).join("/")} ` +
        `union=${s.enumeratedLocs} varied=${s.varied ? "yes" : "no"}`,
    );
  }
  lines.push(
    `  products: sampled=${result.productSummary.sampled} parsed=${result.productSummary.parsed} ` +
      `cigars=${result.productSummary.cigars}`,
  );
  for (const product of result.products) {
    lines.push(
      `    ${product.parsed ? "ok  " : "fail"} ${product.url}`,
      `      status=${product.status} hasProduct=${product.hasProduct} isCigar=${product.isCigar} ` +
        `name=${product.name ?? "-"} ` +
        `price=${product.priceCents != null ? (product.priceCents / 100).toFixed(2) : "-"} ` +
        `${product.currency ?? ""}`.trimEnd(),
    );
  }
  if (result.products.length === 0) lines.push("    (none sampled)");
  if (result.notes.length > 0) {
    lines.push("  notes:");
    for (const note of result.notes) lines.push(`    - ${note}`);
  }
  return lines.join("\n");
}
