import { extractProductMarkup, markupLabel } from "./markup.js";
import { isCigarListing, normalizeListing } from "./normalize.js";
import { parseRobots } from "./robots.js";
import { collectSitemapSamples, type SitemapSample } from "./sitemap.js";
import {
  filterProductUrls,
  isProductUrl,
  pathShapeCensus,
  productGateLabel,
  robotsGatePath,
  type PathCensus,
} from "./product-url.js";
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
// One parse proves the adapter's declared extractor works but NOT that the
// enumeration selects products — the mirror image of the bug this exists to catch. Two
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
  // The taxonomy the page stated, in the shape the adapter's `categorySource`
  // names — a breadcrumb trail, or the vendor's keywords tag list.
  category: string[];
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
    // Root size — distinct child sitemaps for an index (union across samples, so
    // a varying index is counted by what it ever served), the largest single root
    // response for a urlset — and how many of the *enumerated* URLs pass the
    // product gate.
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
  // What KINDS of URL sit on each side of the gate — the commonest first-two-
  // segment shapes among the enumerated URLs the gate accepted and rejected.
  // Free (the URLs are already fetched) and the difference between one probe and
  // two: `accepted` shows a gate admitting a non-product subtree, `rejected`
  // names where the products live when the gate admits nothing.
  pathShapes: { accepted: PathCensus; rejected: PathCensus };
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
  // Every distinct child the root listed across samples. It is the denominator
  // for coverage BECAUSE sampledChildren is a union across samples: a vendor
  // whose index varies can serve a different child list per fetch, and measuring
  // that union against one root's <loc> count printed ratios like 6/4 and
  // suppressed the coverage note on exactly the vendors covered worst.
  const rootChildren = [...new Set(samples.flatMap((s) => s.rootChildren))];
  const anyOk = samples.some((s) => s.status === 200);
  // Root size: distinct child sitemaps for an index, the largest single root
  // response for a urlset. For an index this is the ONLY place the index's real
  // size appears — the enumerated union is a different number and reporting it
  // as `locs` hid how much of the index the probe never looked at.
  const rootLocs =
    kind === "sitemapindex" ? rootChildren.length : Math.max(0, ...samples.map((s) => s.rootLocs));

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
  // A child that 403s or 404s enumerates zero URLs, exactly like an empty one.
  // Without this the operator cannot tell "the gate is wrong" from "we were
  // blocked", which is the difference between an adapter fix and an ops fix.
  const failedChildren = new Map<string, number>();
  for (const sample of samples) {
    for (const failure of sample.childFailures) failedChildren.set(failure.url, failure.status);
  }
  for (const [url, status] of failedChildren) {
    notes.push(`child sitemap ${url} returned ${status}.`);
  }
  // The probe descends at most MAX_PROBE_CHILDREN children; a product-only child
  // outside that pick is invisible to it. Say so with the numbers, so a
  // needs-attention on a big index is diagnosable from the output alone.
  if (kind === "sitemapindex" && rootChildren.length > sampledChildren.length) {
    notes.push(
      `sitemapindex: sampled ${sampledChildren.length}/${rootChildren.length} children ` +
        `(${sampledChildren.join(", ")}) — products in an unsampled child would not be seen here.`,
    );
  }

  const productUrls = filterProductUrls(sampled.urls, adapter);
  const pathShapes = {
    accepted: pathShapeCensus(productUrls),
    rejected: pathShapeCensus(sampled.urls.filter((url) => !isProductUrl(url, adapter))),
  };
  if (anyOk && sampled.urls.length > 0 && productUrls.length === 0) {
    notes.push(`no enumerated URL passes the product gate (${gate}) — the gate or sitemap shape is likely wrong.`);
  }

  const sitemap: ProbeResult["sitemap"] = {
    url: adapter.sitemapUrl,
    status: samples[0]!.status,
    kind,
    totalLocs: rootLocs,
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
      const { product, category, categorySource } = extractProductMarkup(
        res.status === 200 ? res.body : "",
        adapter,
      );
      const listing = product ? normalizeListing(product, category, categorySource) : null;
      if (res.status !== 200) notes.push(`sample product ${url} returned ${res.status}.`);
      else if (!product) notes.push(`sample product ${url} has no ${markupLabel(adapter)} — parsing yields nothing.`);
      else if (!listing) notes.push(`sample product ${url} ${markupLabel(adapter)} has no usable name.`);
      products.push({
        url,
        status: res.status,
        hasProduct: product !== null,
        name: listing?.name ?? null,
        priceCents: listing?.priceCents ?? null,
        currency: listing?.currency ?? null,
        category,
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
    pathShapes,
    products,
    productSummary,
    verdict,
    notes,
  };
}

function formatCensus(census: PathCensus): string {
  if (census.total === 0) return "(none)";
  const top = census.top.map((entry) => `${entry.key} ${entry.count}`).join(" · ");
  // The tail is what the top-N hid; omitted when it hid nothing.
  return census.otherKeys > 0 ? `${top} (+${census.otherKeys} keys, ${census.otherUrls} urls)` : top;
}

export function formatProbe(result: ProbeResult): string {
  const s = result.sitemap;
  const lines: string[] = [
    `probe ${result.vendor}  verdict=${result.verdict}  gate=${result.gate}`,
    `  robots: status=${result.robots.status} agent=${result.robots.matchedAgent} ` +
      `allows=${result.robots.productPathAllowed}`,
    // `locs` is the ROOT size (distinct children for an index), `enumerated` the
    // union the gate was applied to — for an index they are different numbers and
    // `children=<sampled>/<listed>` is how much of the catalog this probe did not
    // look at. Both sides of that ratio are unions across samples, so it holds
    // for a vendor whose index varies between fetches.
    `  sitemap: status=${s.status} kind=${s.kind ?? "-"} locs=${s.totalLocs} ` +
      `enumerated=${s.enumeratedLocs} product-locs=${s.productLocs}` +
      (s.kind === "sitemapindex"
        ? ` children=${s.sampledChildren.length}/${s.totalLocs}` +
          (s.sampledChildren.length > 0 ? ` (${s.sampledChildren.join(",")})` : "")
        : ""),
  ];
  if (s.samples.length > 1) {
    lines.push(
      // `new` is the per-sample marginal contribution — the number the adapter's
      // `samples` count is tuned from (a trailing 0 means the count is enough).
      `  samples: n=${s.samples.length} locs=${s.samples.map((x) => x.enumerated).join("/")} ` +
        `new=${s.samples.map((x) => x.newUrls).join("/")} ` +
        `union=${s.enumeratedLocs} varied=${s.varied ? "yes" : "no"}`,
    );
  }
  // Two own lines, so the substring assertions on the sitemap/samples/products
  // lines above and below are untouched by adding them.
  lines.push(
    `  paths: in  ${formatCensus(result.pathShapes.accepted)}`,
    `         out ${formatCensus(result.pathShapes.rejected)}`,
  );
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
