import { extractJsonLd } from "./jsonld.js";
import { isCigarListing, normalizeListing } from "./normalize.js";
import { parseRobots } from "./robots.js";
import { parseSitemap } from "./sitemap.js";
import { CRAWLER_UA_TOKEN, type Fetcher } from "./fetcher.js";
import type { VendorAdapter } from "../adapters/types.js";

// The `--probe` verdict (ADR-006 live-verification rule). The dev pod cannot
// reach vendor domains, so a new adapter's robots/ToS/sitemap/product shapes are
// unverified ASSUMPTIONS; the coordinator runs this in-cluster BEFORE the registry
// enables crawling. Unlike dry-run (which walks the whole catalog, bounded by
// --limit, and reports would-writes), probe touches at most THREE pages — robots,
// the sitemap root, and ONE product page — parses them, WRITES NOTHING, and prints
// a pass/needs-attention verdict so a bad assumption surfaces before any crawl.

export interface ProbeResult {
  vendor: string;
  productPathPrefix: string;
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
    // a urlset), and how many of the *enumerated* URLs match productPathPrefix.
    totalLocs: number;
    productLocs: number;
    // For a sitemapindex, the first child sitemap we descended one level into.
    sampledChild: string | null;
  };
  product: {
    url: string;
    status: number;
    hasProduct: boolean;
    name: string | null;
    priceCents: number | null;
    currency: string | null;
    breadcrumbs: string[];
    isCigar: boolean;
  } | null;
  verdict: "ok" | "needs-attention";
  notes: string[];
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// Fetch robots.txt + the sitemap root (+ one index child if needed) + one product
// page. No DB, no storage — a pure read that reports what the crawl WOULD see.
export async function runProbe(fetcher: Fetcher, adapter: VendorAdapter): Promise<ProbeResult> {
  const notes: string[] = [];

  // --- robots --------------------------------------------------------------
  const robotsUrl = new URL("/robots.txt", adapter.url).toString();
  const robotsRes = await fetcher.fetchText(robotsUrl);
  // A missing/failed robots.txt is fully permissive (RFC 9309), same as ingest.
  const robots = parseRobots(robotsRes.status === 200 ? robotsRes.body : "", CRAWLER_UA_TOKEN);
  const productPathAllowed = robots.isAllowed(adapter.productPathPrefix);
  if (robotsRes.status !== 200) notes.push(`robots.txt returned ${robotsRes.status} — treated as permissive.`);
  if (!productPathAllowed) notes.push(`robots.txt DISALLOWS ${adapter.productPathPrefix} for our UA — crawl refused.`);

  // --- sitemap -------------------------------------------------------------
  const rootRes = await fetcher.fetchText(adapter.sitemapUrl);
  let kind: "urlset" | "sitemapindex" | null = null;
  let enumerated: string[] = [];
  let sampledChild: string | null = null;
  let rootLocCount = 0;

  if (rootRes.status !== 200) {
    notes.push(`sitemap ${adapter.sitemapUrl} returned ${rootRes.status} — enumeration will yield nothing.`);
  } else {
    const parsed = parseSitemap(rootRes.body);
    kind = parsed.kind;
    rootLocCount = parsed.locs.length;
    if (parsed.kind === "urlset") {
      enumerated = parsed.locs;
    } else {
      // Descend ONE level into the first child so we can sample a real product URL.
      sampledChild = parsed.locs[0] ?? null;
      if (sampledChild) {
        const childRes = await fetcher.fetchText(sampledChild);
        if (childRes.status === 200) {
          enumerated = parseSitemap(childRes.body).locs;
        } else {
          notes.push(`first child sitemap ${sampledChild} returned ${childRes.status}.`);
        }
      } else {
        notes.push("sitemapindex is empty — no child sitemaps.");
      }
    }
  }

  const productUrls = enumerated.filter((u) => pathOf(u).startsWith(adapter.productPathPrefix));
  if (rootRes.status === 200 && productUrls.length === 0) {
    notes.push(
      `no enumerated URL starts with productPathPrefix "${adapter.productPathPrefix}" — the prefix or sitemap shape is likely wrong.`,
    );
  }

  const sitemap: ProbeResult["sitemap"] = {
    url: adapter.sitemapUrl,
    status: rootRes.status,
    kind,
    totalLocs: kind === "sitemapindex" ? enumerated.length : rootLocCount,
    productLocs: productUrls.length,
    sampledChild,
  };

  // --- one product page ----------------------------------------------------
  let product: ProbeResult["product"] = null;
  const sampleUrl = productUrls[0];
  if (sampleUrl && productPathAllowed) {
    const res = await fetcher.fetchText(sampleUrl);
    const { product: jsonLd, breadcrumbs } = extractJsonLd(res.status === 200 ? res.body : "");
    const listing = jsonLd ? normalizeListing(jsonLd, breadcrumbs) : null;
    if (res.status !== 200) notes.push(`sample product ${sampleUrl} returned ${res.status}.`);
    else if (!jsonLd) notes.push(`sample product ${sampleUrl} has no schema.org Product JSON-LD — parsing yields nothing.`);
    else if (!listing) notes.push(`sample product ${sampleUrl} JSON-LD has no usable name.`);
    product = {
      url: sampleUrl,
      status: res.status,
      hasProduct: jsonLd !== null,
      name: listing?.name ?? null,
      priceCents: listing?.priceCents ?? null,
      currency: listing?.currency ?? null,
      breadcrumbs,
      isCigar: listing ? isCigarListing(listing, adapter) : false,
    };
  } else if (!sampleUrl && productPathAllowed) {
    notes.push("no product URL to sample — cannot verify JSON-LD parsing.");
  }

  const verdict: ProbeResult["verdict"] =
    productPathAllowed && productUrls.length > 0 && product?.hasProduct && product.name ? "ok" : "needs-attention";

  return {
    vendor: adapter.name,
    productPathPrefix: adapter.productPathPrefix,
    robots: { status: robotsRes.status, matchedAgent: robots.matchedAgent, productPathAllowed },
    sitemap,
    product,
    verdict,
    notes,
  };
}

export function formatProbe(result: ProbeResult): string {
  const lines: string[] = [
    `probe ${result.vendor}  verdict=${result.verdict}`,
    `  robots: status=${result.robots.status} agent=${result.robots.matchedAgent} ` +
      `allows(${result.productPathPrefix})=${result.robots.productPathAllowed}`,
    `  sitemap: status=${result.sitemap.status} kind=${result.sitemap.kind ?? "-"} ` +
      `locs=${result.sitemap.totalLocs} product-locs=${result.sitemap.productLocs}` +
      (result.sitemap.sampledChild ? ` child=${result.sitemap.sampledChild}` : ""),
  ];
  if (result.product) {
    lines.push(
      `  product: ${result.product.url}`,
      `    status=${result.product.status} hasProduct=${result.product.hasProduct} ` +
        `isCigar=${result.product.isCigar} name=${result.product.name ?? "-"} ` +
        `price=${result.product.priceCents != null ? (result.product.priceCents / 100).toFixed(2) : "-"} ` +
        `${result.product.currency ?? ""}`.trimEnd(),
    );
  } else {
    lines.push("  product: (none sampled)");
  }
  if (result.notes.length > 0) {
    lines.push("  notes:");
    for (const note of result.notes) lines.push(`    - ${note}`);
  }
  return lines.join("\n");
}
