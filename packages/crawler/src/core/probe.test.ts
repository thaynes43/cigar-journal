import { describe, it, expect } from "vitest";
import { runProbe, formatProbe, probeFetchBudget, MAX_PROBE_CHILDREN, REQUIRED_PARSED_SAMPLES } from "./probe.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { smallBatchCigar } from "../adapters/small-batch-cigar.js";
import { montefortuna } from "../adapters/montefortuna.js";
import { egmCigars } from "../adapters/egm-cigars.js";
import { cigarworldDe } from "../adapters/cigarworld-de.js";
import { jjFox } from "../adapters/jj-fox.js";
import { extractProductMarkup } from "./markup.js";
import { isCigarCategory, isCigarListing, normalizeListing } from "./normalize.js";
import {
  createMockFetcher,
  loadFixture,
  urlsetXml,
  type MockFetcher,
  type MockRoute,
} from "../testing/fixtures.js";
import type { PrefixVendorAdapter, VendorAdapter } from "../adapters/types.js";

// The probe is a pure read (no DB, no storage) — mock the fetcher per the
// guardrail (NEVER live sites) and assert the verdict it prints.

const ROBOTS = "https://www.cubanlous.com/robots.txt";
const SITEMAP = "https://www.cubanlous.com/product-sitemap.xml";
const PRODUCT = "https://www.cubanlous.com/montecristo-cigars/montecristo-no-4/";
const PRODUCT2 = "https://www.cubanlous.com/partagas-cigars/partagas-serie-d-no-4/";
const NON_PRODUCT = "https://www.cubanlous.com/about/";
const ALLOW_ALL = "User-agent: *\nAllow: /\n";

function productHtml(name: string, price: string, category = "Cigars"): string {
  return `<!doctype html><html><head><script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[
    {"@type":"BreadcrumbList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"Home"},
      {"@type":"ListItem","position":2,"name":"${category}"},
      {"@type":"ListItem","position":3,"name":"${name}"}]},
    {"@type":"Product","name":"${name}","offers":[{"@type":"Offer",
      "priceSpecification":[{"price":"${price}","priceCurrency":"USD"}],
      "availability":"https://schema.org/InStock"}]}]}
  </script></head><body></body></html>`;
}

// Every probe must stay inside the budget the CLI hands the fetcher as maxPages —
// the guard that a hard-coded 8 silently broke once sampling was added.
function expectWithinBudget(fetcher: MockFetcher, adapter: VendorAdapter): void {
  expect(fetcher.pagesFetched).toBeLessThanOrEqual(probeFetchBudget(adapter));
}

describe("runProbe", () => {
  it("passes a well-formed WooCommerce-style vendor (robots + sitemap + product samples)", async () => {
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: ALLOW_ALL },
      [SITEMAP]: { body: urlsetXml([PRODUCT, PRODUCT2, NON_PRODUCT]) },
      [PRODUCT]: { body: productHtml("Montecristo No. 4", "18.00") },
      [PRODUCT2]: { body: productHtml("Partagas Serie D No. 4", "22.00") },
    });

    const result = await runProbe(fetcher, cubanLous);
    expect(result.verdict).toBe("ok");
    expect(result.gate).toBe("prefix /");
    expect(result.robots.productPathAllowed).toBe(true);
    expect(result.sitemap.kind).toBe("urlset");
    expect(result.sitemap.productLocs).toBe(3); // "/" prefix admits every loc; JSON-LD is the product gate
    expect(result.sitemap.varied).toBe(false);
    expect(result.sitemap.samples).toHaveLength(1);
    // Three spread samples: two real products parse, the /about/ page 404s.
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 2, cigars: 2, placeholderPrices: 0 });
    expect(result.products[0]!.name).toBe("Montecristo No. 4");
    expect(result.products[0]!.priceCents).toBe(1800);
    expect(result.products[0]!.isCigar).toBe(true);
    expect(fetcher.pagesFetched).toBe(5); // robots + sitemap + 3 product pages
    expectWithinBudget(fetcher, cubanLous);
  });

  it("flags needs-attention when robots disallows the gate path", async () => {
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: "User-agent: *\nDisallow: /\n" },
      [SITEMAP]: { body: urlsetXml([PRODUCT]) },
      [PRODUCT]: { body: productHtml("Montecristo No. 4", "18.00") },
    });

    const result = await runProbe(fetcher, cubanLous);
    expect(result.verdict).toBe("needs-attention");
    expect(result.robots.productPathAllowed).toBe(false);
    expect(result.products).toEqual([]); // nothing sampled when the path is disallowed
    expect(result.notes.join(" ")).toMatch(/DISALLOWS/);
  });

  it("flags needs-attention when the product gate matches nothing", async () => {
    // Uses 2 Guys — cubanLous carries "/" and matches every loc by design (its
    // sitemap is product-only), so it cannot express an empty gate.
    const fetcher = createMockFetcher({
      ["https://www.2guyscigars.com/robots.txt"]: { body: ALLOW_ALL },
      ["https://www.2guyscigars.com/sitemap.xml"]: { body: urlsetXml(["https://www.2guyscigars.com/blog/monte-4/"]) },
    });

    const result = await runProbe(fetcher, twoGuysCigars);
    expect(result.verdict).toBe("needs-attention");
    expect(result.sitemap.productLocs).toBe(0);
    expect(result.notes.join(" ")).toMatch(/product gate/);
    expectWithinBudget(fetcher, twoGuysCigars);
  });

  it("descends a sitemapindex to sample a product", async () => {
    const CHILD = "https://www.cubanlous.com/product-sitemap-1.xml";
    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${CHILD}</loc></sitemap>
      </sitemapindex>`;
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: ALLOW_ALL },
      [SITEMAP]: { body: indexXml },
      [CHILD]: { body: urlsetXml([PRODUCT]) },
      [PRODUCT]: { body: productHtml("Montecristo No. 4", "18.00") },
    });

    const result = await runProbe(fetcher, cubanLous);
    expect(result.verdict).toBe("ok"); // one loc → min(2, 1) parses required
    expect(result.sitemap.kind).toBe("sitemapindex");
    expect(result.sitemap.sampledChildren).toEqual([CHILD]);
    expect(result.products[0]!.name).toBe("Montecristo No. 4");
  });

  // The live 2026-08-29 false negatives: both first locs were non-products (an
  // index page and a registry redirect), so a head-only probe reported
  // needs-attention on two healthy vendors.
  it("skips a non-product first loc instead of failing on it", async () => {
    const locs = [NON_PRODUCT, ...Array.from({ length: 20 }, (_, i) => `https://www.cubanlous.com/cigars/p-${i}/`)];
    const routes: Record<string, MockRoute> = {
      [ROBOTS]: { body: ALLOW_ALL },
      [SITEMAP]: { body: urlsetXml(locs) },
    };
    for (const loc of locs.slice(1)) routes[loc] = { body: productHtml("Habano Robusto", "12.00") };

    const fetcher = createMockFetcher(routes);
    const result = await runProbe(fetcher, cubanLous);

    expect(result.verdict).toBe("ok");
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 3, cigars: 3, placeholderPrices: 0 });
    expect(result.products.map((p) => p.url)).not.toContain(NON_PRODUCT);
    expectWithinBudget(fetcher, cubanLous);
  });

  it("requires two parses when three were sampled, and one when only one was", async () => {
    const build = async (parseable: number, total: number): Promise<Awaited<ReturnType<typeof runProbe>>> => {
      const locs = Array.from({ length: total }, (_, i) => `https://www.cubanlous.com/cigars/p-${i}/`);
      const routes: Record<string, MockRoute> = { [ROBOTS]: { body: ALLOW_ALL }, [SITEMAP]: { body: urlsetXml(locs) } };
      // Make the FIRST `parseable` locs real products; the rest 404 (unrouted).
      for (const loc of locs.slice(0, parseable)) routes[loc] = { body: productHtml("Habano Robusto", "12.00") };
      return runProbe(createMockFetcher(routes), cubanLous);
    };

    // 3 sampled, 1 parsed → short of the floor of 2.
    const oneOfThree = await build(1, 3);
    expect(oneOfThree.productSummary).toEqual({ sampled: 3, parsed: 1, cigars: 1, placeholderPrices: 0 });
    expect(oneOfThree.verdict).toBe("needs-attention");
    expect(oneOfThree.notes.filter((n) => n.startsWith("sample product"))).toHaveLength(2);

    const twoOfThree = await build(2, 3);
    expect(twoOfThree.productSummary.parsed).toBe(2);
    expect(twoOfThree.verdict).toBe("ok");

    // A one-product catalog can still pass — the floor is min(2, sampled).
    const oneOfOne = await build(1, 1);
    expect(oneOfOne.productSummary).toEqual({ sampled: 1, parsed: 1, cigars: 1, placeholderPrices: 0 });
    expect(oneOfOne.verdict).toBe("ok");
  });

  // The two bars added for #270. Both describe a vendor the old verdict called
  // healthy: everything up to and including "the JSON-LD parses" was true, and a
  // seed would still have written thousands of rows worth nothing.
  it("FAILS a vendor whose JSON-LD publishes a placeholder price of zero", async () => {
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: ALLOW_ALL },
      [SITEMAP]: { body: urlsetXml([PRODUCT, PRODUCT2]) },
      [PRODUCT]: { body: productHtml("Montecristo No. 4", "0.00") },
      [PRODUCT2]: { body: productHtml("Partagas Serie D No. 4", "0.00") },
    });

    const result = await runProbe(fetcher, cubanLous);

    // Parsed, gated as cigars, and still not crawlable for offers.
    expect(result.productSummary).toEqual({ sampled: 2, parsed: 2, cigars: 2, placeholderPrices: 2 });
    expect(result.products.every((p) => p.priceIsPlaceholder && p.priceCents === null)).toBe(true);
    expect(result.verdict).toBe("needs-attention");
    expect(result.notes.join(" ")).toMatch(/PLACEHOLDER price of 0/);
    expect(formatProbe(result)).toContain("placeholder-prices=2");
    expect(formatProbe(result)).toContain("price=0.00 PLACEHOLDER");
  });

  it("FAILS a vendor whose samples all parse but none passes the cigar gate", async () => {
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: ALLOW_ALL },
      [SITEMAP]: { body: urlsetXml([PRODUCT, PRODUCT2]) },
      [PRODUCT]: { body: productHtml("Peterson Irish Flake", "18.00", "Pipe Tobacco") },
      [PRODUCT2]: { body: productHtml("Rattray's Old Gowrie", "22.00", "Pipe Tobacco") },
    });

    const result = await runProbe(fetcher, cubanLous);

    expect(result.productSummary).toEqual({ sampled: 2, parsed: 2, cigars: 0, placeholderPrices: 0 });
    expect(result.verdict).toBe("needs-attention");
    expect(result.notes.join(" ")).toMatch(/no sampled product passed the cigar gate/);
    // The stated taxonomy is on the operator's screen, so the note is actionable
    // without a second Job: it names the taxonomy the gate was asked about.
    expect(formatProbe(result)).toContain("category=Home / Pipe Tobacco / Peterson Irish Flake");
  });

  // Child-coverage regression. A positional midpoint pick over N children is
  // [1, 3, 5] at N=7 and [1, 4, 6] at N=8: neither end is reachable, so a healthy
  // vendor whose products sit in the first or last child probed as
  // needs-attention — the false-negative class this probe exists to remove. The
  // sizes below are the ones that break it; 4 children happens to work either way.
  const indexProbe = async (children: string[], productChild: number) => {
    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        ${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}
      </sitemapindex>`;
    const routes: Record<string, MockRoute> = { [ROBOTS]: { body: ALLOW_ALL }, [SITEMAP]: { body: indexXml } };
    for (const child of children) routes[child] = { body: urlsetXml([]) };
    routes[children[productChild]!] = { body: urlsetXml([PRODUCT, PRODUCT2]) };
    routes[PRODUCT] = { body: productHtml("Montecristo No. 4", "18.00") };
    routes[PRODUCT2] = { body: productHtml("Partagas Serie D No. 4", "22.00") };

    const fetcher = createMockFetcher(routes);
    const result = await runProbe(fetcher, cubanLous);
    expectWithinBudget(fetcher, cubanLous);
    return { result, fetcher };
  };

  const numberedChildren = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `https://www.cubanlous.com/sitemap-${i}.xml`);

  it("finds products living in the LAST child of an 8-child sitemapindex", async () => {
    const children = numberedChildren(8);
    const { result } = await indexProbe(children, 7);

    expect(result.verdict).toBe("ok");
    expect(result.sitemap.sampledChildren.length).toBeLessThanOrEqual(MAX_PROBE_CHILDREN);
    expect(result.sitemap.sampledChildren).toContain(children[7]);
  });

  it("finds products living in the FIRST child of an 8-child sitemapindex", async () => {
    const children = numberedChildren(8);
    const { result } = await indexProbe(children, 0);

    expect(result.verdict).toBe("ok");
    expect(result.sitemap.sampledChildren).toContain(children[0]);
  });

  // A stock Yoast/WooCommerce index: the catalog is in `product-sitemap.xml`,
  // parked at an arbitrary position no positional rule can be relied on to hit.
  it("finds the product child of a Yoast-shaped index by name", async () => {
    const children = [
      "post-sitemap.xml",
      "page-sitemap.xml",
      "product-sitemap1.xml",
      "category-sitemap.xml",
      "product_cat-sitemap.xml",
      "product_tag-sitemap.xml",
      "author-sitemap.xml",
    ].map((n) => `https://www.cubanlous.com/${n}`);
    const { result } = await indexProbe(children, 2);

    expect(result.verdict).toBe("ok");
    expect(result.sitemap.sampledChildren).toContain("https://www.cubanlous.com/product-sitemap1.xml");
  });

  // The taxonomy trap. Woo/Yoast ships product_cat/product_tag/product_brand
  // beside the catalog and every one of them matches the product hint, so ranking
  // all hint matches alike fills a 3-child budget with term archives and skips the
  // one child holding products — a shape the plain midpoint pick reached.
  it("finds the catalog child of a Woo index whose taxonomy children also match the hint", async () => {
    const children = [
      "product_cat-sitemap.xml",
      "products-sitemap.xml", // the catalog
      "product_tag-sitemap.xml",
      "product_brand-sitemap.xml",
      "post-sitemap.xml",
      "page-sitemap.xml",
    ].map((n) => `https://www.cubanlous.com/${n}`);
    const { result } = await indexProbe(children, 1);

    expect(result.verdict).toBe("ok");
    expect(result.sitemap.sampledChildren).toContain("https://www.cubanlous.com/products-sitemap.xml");
  });

  // ...and the mirror case: two hint matches must not eat the budget the ends
  // need. The catalog here carries no hint word and sits last.
  it("still reaches the last child when the hint matches two children in the middle", async () => {
    const children = [
      "post-sitemap.xml",
      "page-sitemap.xml",
      "product_cat-sitemap.xml",
      "product_tag-sitemap.xml",
      "author-sitemap.xml",
      "tag-sitemap.xml",
      "news-sitemap.xml",
      "inventory-sitemap.xml", // the catalog
    ].map((n) => `https://www.cubanlous.com/${n}`);
    const { result } = await indexProbe(children, 7);

    expect(result.verdict).toBe("ok");
    expect(result.sitemap.sampledChildren).toContain(children[7]);
  });

  // Coverage on a VARYING index. sampledChildren is a union across samples, so
  // its denominator has to be a union too — measured against one root's <loc>
  // count it printed impossible ratios (6/4) and suppressed the coverage note on
  // exactly the vendors sampling exists for.
  it("counts index coverage against every child the root ever served", async () => {
    const adapter: VendorAdapter = { ...cubanLous, sitemapSampling: { samples: 2 } };
    const childUrl = (n: string): string => `https://www.cubanlous.com/${n}-sitemap.xml`;
    const first = ["a1", "a2", "a3", "a4"].map(childUrl);
    const second = ["b1", "b2", "b3", "b4"].map(childUrl);
    const indexXml = (children: string[]): string =>
      `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        ${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}
      </sitemapindex>`;

    const routes: Record<string, MockRoute> = {
      [ROBOTS]: { body: ALLOW_ALL },
      [SITEMAP]: { sequence: [{ body: indexXml(first) }, { body: indexXml(second) }] },
    };
    for (const child of [...first, ...second]) routes[child] = { body: urlsetXml([]) };

    const fetcher = createMockFetcher(routes);
    const result = await runProbe(fetcher, adapter);

    expect(result.sitemap.sampledChildren).toHaveLength(6); // 3 per sample, no overlap
    expect(result.sitemap.totalLocs).toBe(8); // 8 distinct children across the two roots
    expect(formatProbe(result)).toContain("children=6/8");
    expect(result.notes.join(" ")).toMatch(/sitemapindex: sampled 6\/8 children/);
    expectWithinBudget(fetcher, adapter);
  });

  // Diagnosability: a needs-attention on a big index must say how big the index
  // was and which children were looked at, or the operator cannot tell an empty
  // catalog from an unsampled one.
  it("reports the index size and the sampled slice when it cannot cover the index", async () => {
    const children = numberedChildren(20);
    const { result } = await indexProbe(children, 5); // outside the 3-child pick

    expect(result.verdict).toBe("needs-attention");
    expect(result.sitemap.totalLocs).toBe(20); // the INDEX size, not the union
    expect(result.sitemap.enumeratedLocs).toBe(0);
    expect(result.sitemap.sampledChildren).toHaveLength(MAX_PROBE_CHILDREN);
    expect(result.notes.join(" ")).toMatch(/sitemapindex: sampled 3\/20 children/);
    expect(formatProbe(result)).toContain("children=3/20");
  });

  it("names a child sitemap that refused the fetch", async () => {
    const CHILD = "https://www.cubanlous.com/product-sitemap-1.xml";
    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${CHILD}</loc></sitemap>
      </sitemapindex>`;
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: ALLOW_ALL },
      [SITEMAP]: { body: indexXml },
      [CHILD]: { status: 403, body: "" },
    });

    const result = await runProbe(fetcher, cubanLous);
    expect(result.verdict).toBe("needs-attention");
    // "the index 403s us" is an ops fix; "the gate is wrong" is an adapter fix.
    expect(result.notes.join(" ")).toMatch(/child sitemap https:\/\/www\.cubanlous\.com\/product-sitemap-1\.xml returned 403/);
  });

  it("surfaces sitemap content variance and still passes on the union", async () => {
    const adapter: VendorAdapter = { ...cubanLous, sitemapSampling: { samples: 3 } };
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: ALLOW_ALL },
      [SITEMAP]: {
        sequence: [
          { body: urlsetXml([PRODUCT, PRODUCT2]) },
          { body: urlsetXml([]) },
          { body: urlsetXml([PRODUCT, PRODUCT2]) },
        ],
      },
      [PRODUCT]: { body: productHtml("Montecristo No. 4", "18.00") },
      [PRODUCT2]: { body: productHtml("Partagas Serie D No. 4", "22.00") },
    });

    const result = await runProbe(fetcher, adapter);
    expect(result.sitemap.varied).toBe(true);
    expect(result.sitemap.samples.map((s) => s.enumerated)).toEqual([2, 0, 2]);
    expect(result.sitemap.enumeratedLocs).toBe(2);
    expect(result.verdict).toBe("ok");
    expect(result.notes.join(" ")).toMatch(/VARIES/);
    // The marginal contribution per sample is what a `samples` count is tuned
    // from, so it has to reach the operator's screen, not just the struct.
    expect(result.sitemap.samples.map((s) => s.newUrls)).toEqual([2, 0, 0]);
    expect(formatProbe(result)).toContain("samples: n=3 locs=2/0/2 new=2/0/0 union=2 varied=yes");
    expectWithinBudget(fetcher, adapter);
  });

  it("flags needs-attention when every sample enumerates nothing", async () => {
    const adapter: VendorAdapter = { ...cubanLous, sitemapSampling: { samples: 4 } };
    const fetcher = createMockFetcher({ [ROBOTS]: { body: ALLOW_ALL }, [SITEMAP]: { body: urlsetXml([]) } });

    const result = await runProbe(fetcher, adapter);
    expect(result.verdict).toBe("needs-attention");
    expect(result.products).toEqual([]);
    expect(result.sitemap.samples).toHaveLength(4);
    expect(result.notes.join(" ")).toMatch(/all 4 sitemap sample\(s\) enumerated 0 URLs/);
    expectWithinBudget(fetcher, adapter);
  });
});

// The live 2026-08-30 failure, reproduced and then fixed in one place: a product
// prefix that is right and ALSO matches a non-catalog subtree whose pages carry
// no Product JSON-LD. All three spread picks landed inside that block, so the
// probe printed "no schema.org Product JSON-LD" on a vendor whose actual fault
// was the gate. The verdict was true; the reason was not, and a seed crawl would
// have fetched ~1,400 registry pages.
//
// It was 2 Guys' `/store/` when it was found. 2 Guys has since moved to Mode B
// (#217, 2026-09-01 live read: its products are not under `/store/` at all), so
// this runs against a synthetic Mode-A adapter over `__fixtures__/mode-a-exclusion`
// — the pipeline behaviour is what is under test, and it is still reachable by
// the next adapter that needs a prefix minus a subtree.
describe("mode-A product gate — a non-product subtree under the prefix", () => {
  // Built from a Mode-A adapter, so "prefix plus an exclusion" is the only thing
  // that varies from a shipping one.
  const modeA: PrefixVendorAdapter = {
    ...foxCigar,
    slug: "vendor-example",
    name: "Vendor Example",
    url: "https://vendor.example",
    sitemapUrl: "https://vendor.example/sitemap.xml",
    productPathPrefix: "/store/",
    nonProductPathPattern: /^\/store\/go(?:\/|$)/i,
  };
  const PADRON = "https://vendor.example/store/padron-1926-serie-no-9-maduro/";
  const CUTTER = "https://vendor.example/store/xikar-xi3-cutter/";
  const ABOUT = "https://vendor.example/about-us/";
  // Ids placed so spreadIndices(14, 3) = [2, 7, 11] draws 1059, 4401 and 8079 —
  // the three URLs the live probe really sampled.
  const registryLocs = [612, 840, 1059, 1783, 2450, 3117, 3760, 4401, 5502, 6390, 7233, 8079].map(
    (id) => `https://vendor.example/store/go/registry/${id}/`,
  );

  // Same catalog every time; only the non-product block under /store/ varies.
  const routesFor = (nonProductLocs: string[]): Record<string, MockRoute> => {
    const routes: Record<string, MockRoute> = {
      ["https://vendor.example/robots.txt"]: { body: ALLOW_ALL },
      [modeA.sitemapUrl]: {
        body: urlsetXml(["https://vendor.example/", ...nonProductLocs, PADRON, CUTTER, ABOUT]),
      },
      [PADRON]: { body: loadFixture("product.html", "mode-a-exclusion") },
      [CUTTER]: { body: loadFixture("product-cutter.html", "mode-a-exclusion") },
    };
    for (const loc of nonProductLocs) routes[loc] = { body: loadFixture("registry.html", "mode-a-exclusion") };
    return routes;
  };

  it("reproduces the live false verdict with the exclusion removed", async () => {
    const unfixed: PrefixVendorAdapter = { ...modeA, nonProductPathPattern: undefined };
    const fetcher = createMockFetcher(routesFor(registryLocs));
    const result = await runProbe(fetcher, unfixed);

    expect(result.sitemap.productLocs).toBe(14); // 12 registry + 2 real products
    expect(result.products.map((p) => p.url)).toEqual([
      "https://vendor.example/store/go/registry/1059/",
      "https://vendor.example/store/go/registry/4401/",
      "https://vendor.example/store/go/registry/8079/",
    ]);
    // Byte-for-byte the live line: 200, but nothing to parse.
    expect(result.products.every((p) => p.status === 200 && !p.hasProduct)).toBe(true);
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 0, cigars: 0, placeholderPrices: 0 });
    expect(result.verdict).toBe("needs-attention");
    expect(result.notes.join(" ")).toMatch(/no schema\.org Product JSON-LD/);
    expectWithinBudget(fetcher, unfixed);
  });

  it("reaches the real products once /store/go/ is subtracted", async () => {
    const fetcher = createMockFetcher(routesFor(registryLocs));
    const result = await runProbe(fetcher, modeA);

    expect(result.sitemap.productLocs).toBe(2);
    expect(result.products.map((p) => p.url)).toEqual([PADRON, CUTTER]);
    expect(result.productSummary).toEqual({ sampled: 2, parsed: 2, cigars: 1, placeholderPrices: 0 });
    expect(result.verdict).toBe("ok");
    expect(result.gate).toBe("prefix /store/ minus /^\\/store\\/go(?:\\/|$)/i");
    expectWithinBudget(fetcher, modeA);
  });

  // Diagnosability, on the exact run that misled us. Every probe here is an
  // in-cluster Job, so a needs-attention has to name the shape it saw or the next
  // move costs another round-trip.
  it("names the registry block in the path census on both sides of the gate", async () => {
    const unfixed: PrefixVendorAdapter = { ...modeA, nonProductPathPattern: undefined };
    const broken = formatProbe(await runProbe(createMockFetcher(routesFor(registryLocs)), unfixed));
    // The accepted side shows the gate admitting a non-product subtree — the one
    // line that would have identified the defect on the first probe.
    expect(broken).toContain("paths: in  /store/go 12");
    expect(broken).toContain("out / 1 · /about-us 1");

    const fixed = formatProbe(await runProbe(createMockFetcher(routesFor(registryLocs)), modeA));
    // After the fix the block has moved to the rejected side.
    expect(fixed).toContain("out /store/go 12");
    expect(fixed).toContain("paths: in  /store/padron-1926-serie-no-9-maduro 1");
  });

  it("collapses a long tail of shapes into a (+keys, urls) count", async () => {
    // Eight distinct rejected shapes, so the top-5 cut leaves a tail to report.
    const junk = ["blog", "brands", "pages", "help", "news", "events", "press", "legal"].map(
      (segment) => `https://vendor.example/${segment}/x/`,
    );
    const routes = routesFor(registryLocs);
    routes[modeA.sitemapUrl] = {
      body: urlsetXml([...junk, ...registryLocs, PADRON, CUTTER, ABOUT]),
    };
    const out = formatProbe(await runProbe(createMockFetcher(routes), modeA));

    // 10 rejected keys (8 junk + /store/go + /about-us), 5 shown: 5 hidden keys
    // behind 5 URLs — /store/go is the count-12 key, so it is never in the tail.
    expect(out).toMatch(/out .*\(\+5 keys, 5 urls\)/);
  });

  it("excludes the whole /store/go/ family, not just registry", async () => {
    // Siblings we have never sampled. If the gate named `registry` these would
    // pass and the sampler would draw them exactly as it drew the registry pages.
    const siblings = Array.from({ length: 6 }, (_, i) => [
      `https://vendor.example/store/go/wishlist/${i}/`,
      `https://vendor.example/store/go/cart/${i}/`,
    ]).flat();
    const result = await runProbe(createMockFetcher(routesFor(siblings)), modeA);

    expect(result.sitemap.productLocs).toBe(2);
    expect(result.products.map((p) => p.url)).toEqual([PADRON, CUTTER]);
    expect(result.verdict).toBe("ok");
  });
});


// 2 Guys as it actually is, from the 2026-09-01 in-cluster read (#217), now read
// by the extractor its pages actually need (#252). Every fixture below is a real
// response. This describe replaces the characterization of a blocked vendor that
// stood here until `parsed` went non-zero — deliberately, as that block asked.
//
// What it can and cannot prove: the PIPELINE parses this vendor's real markup and
// gates it. The catalog-wide numbers (`product-locs` 3,841) still need the
// in-cluster probe, because the fixture sitemap is a trimmed capture.
describe("2 Guys, live shape — the OG/microdata extractor reads it", () => {
  const two = (path: string): string => `https://www.2guyscigars.com${path}`;
  const PERDOMO = two("/perdomo-30th-robusto-sg-s-165681/");
  const ROMACRAFT = two("/romacraft-steel-porcupine-184527/");
  const CANDLE = two("/smoke-exterm-candle-orange-734366037362/");

  const liveRoutes = (): Record<string, MockRoute> => ({
    [two("/robots.txt")]: { body: loadFixture("robots.txt", "two-guys") },
    [twoGuysCigars.sitemapUrl]: { body: loadFixture("sitemap.xml", "two-guys") },
    [PERDOMO]: { body: loadFixture("live-product-perdomo-30th-robusto-sg-s-165681.html", "two-guys") },
    [ROMACRAFT]: { body: loadFixture("live-product-romacraft-steel-porcupine-184527.html", "two-guys") },
    [CANDLE]: { body: loadFixture("live-product-smoke-exterm-candle-orange-734366037362.html", "two-guys") },
    [two("/cigars-perdomo-30th-maduro/")]: {
      body: loadFixture("live-landing-cigars-perdomo-30th-maduro.html", "two-guys"),
    },
    [two("/zino-nicaragua-cigars/")]: {
      status: 404,
      body: loadFixture("live-404-zino-nicaragua-cigars.html", "two-guys"),
    },
  });

  it("passes the live robots.txt, which allows / and only asks for a crawl delay", async () => {
    const result = await runProbe(createMockFetcher(liveRoutes()), twoGuysCigars);
    expect(result.robots.status).toBe(200);
    expect(result.robots.matchedAgent).toBe("*");
    // Two `*` groups in the live file; combined, nothing disallows the root.
    expect(result.robots.productPathAllowed).toBe(true);
  });

  it("selects the product-code slugs and samples three real product pages", async () => {
    const fetcher = createMockFetcher(liveRoutes());
    const result = await runProbe(fetcher, twoGuysCigars);

    expect(result.sitemap.enumeratedLocs).toBe(21);
    expect(result.sitemap.productLocs).toBe(9);
    // spreadIndices(9, 3) — and none of the three is under /store/ or a landing
    // page, which is requirement 4 of the #179 re-probe bar.
    expect(result.products.map((p) => p.url)).toEqual([PERDOMO, ROMACRAFT, CANDLE]);
    expect(result.products.every((p) => !p.url.includes("/store/"))).toBe(true);
    expectWithinBudget(fetcher, twoGuysCigars);
  });

  it("parses all three sampled pages and admits the two cigars", async () => {
    const result = await runProbe(createMockFetcher(liveRoutes()), twoGuysCigars);

    // Requirements 4 and 5 of the #179 bar, the two this vendor was stuck on:
    // parsed >= REQUIRED_PARSED_SAMPLES and at least one cigar.
    expect(result.products.every((p) => p.status === 200)).toBe(true);
    expect(result.products.every((p) => p.hasProduct)).toBe(true);
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 3, cigars: 2, placeholderPrices: 0 });
    expect(result.productSummary.parsed).toBeGreaterThanOrEqual(REQUIRED_PARSED_SAMPLES);
    expect(result.verdict).toBe("ok");
    // Nothing left to say about the markup — the notes carry no parse failure.
    expect(result.notes.join(" ")).not.toMatch(/parsing yields nothing/);
  });

  it("reads price, stock and category off the OG tags, and refuses the candle", async () => {
    const result = await runProbe(createMockFetcher(liveRoutes()), twoGuysCigars);
    const [perdomo, romacraft, candle] = result.products;

    expect(perdomo!.name).toBe("Perdomo 30th Robusto SG S");
    expect(perdomo!.priceCents).toBe(1379);
    expect(perdomo!.currency).toBe("USD");
    expect(perdomo!.isCigar).toBe(true);
    // The category is the vendor's keywords tag list, not a breadcrumb trail.
    expect(perdomo!.category).toEqual(["30 nick anniversary nicaragua", "Cigars", "Perdomo 30th Sun Grown"]);

    expect(romacraft!.priceCents).toBe(10799); // out of stock, still a parsed listing
    expect(romacraft!.isCigar).toBe(true);

    // The accessory the URL gate cannot tell from a cigar: parsed, then refused
    // on its own tags. This is the whole cost of admitting a vendor whose slugs
    // carry no taxonomy.
    expect(candle!.name).toBe("Smoke Exterm Candle Orange");
    expect(candle!.parsed).toBe(true);
    expect(candle!.isCigar).toBe(false);
    expect(candle!.category).toEqual(["Air Freshening", "Air Freshening Accessories"]);
  });

  it("prints the gate and both census sides so a probe log identifies the build", async () => {
    const out = formatProbe(await runProbe(createMockFetcher(liveRoutes()), twoGuysCigars));

    expect(out).toContain("gate=not /^\\/store(?:\\/|$)|^\\/(?![^/]*-\\d+\\/?$)/i segments 1..1");
    expect(out).toContain("product-locs=9");
    // The registry family is now on the rejected side where it belongs.
    expect(out).toContain("out /store/go 5");
    // And the accepted side is the signature #217 was named after: nine URLs
    // under nine distinct keys, one each — the per-product tail of a catalog,
    // not a few fat non-product families.
    expect(out).toMatch(/in {2}(?:\/[^ ]+ 1 · ){4}\/[^ ]+ 1 \(\+4 keys, 4 urls\)/);
  });
});

// Small Batch as it actually is, from the 2026-09-02 in-cluster read (#270). The
// gate, the sitemap shape and the category patterns are all now the live ones,
// three pages parse cleanly — and the probe says needs-attention for the reason
// that is true: nopCommerce publishes `"0.00"` on every grouped cigar, so a seed
// here would write an offer per listing with no price in it.
//
// A CHARACTERIZATION of a blocked vendor, not an aspiration. Whoever lands the
// `variant-overview` price extractor (ADR-015) rewrites these deliberately; until
// then this is the honest verdict, and it is why Small Batch is not in the
// `cases` harness in `adapters-parse.test.ts`.
describe("Small Batch, live shape — the gate is right and every cigar price is a placeholder", () => {
  const sb = (path: string): string => `https://www.smallbatchcigar.com${path}`;
  const EASTERN = sb("/eastern-standard-sungrown-toro-extra");
  const TATUAJE = sb("/tatuaje-black-label-petite-lancero");
  const CALDWELL = sb("/caldwell");
  const CUTTER = sb("/xikar-xi3-cutter");

  const liveRoutes = (): Record<string, MockRoute> => ({
    [sb("/robots.txt")]: { body: loadFixture("robots.txt", "small-batch") },
    [smallBatchCigar.sitemapUrl]: { body: loadFixture("sitemap.xml", "small-batch") },
    [EASTERN]: { body: loadFixture("product-eastern-standard-sungrown-toro-extra.html", "small-batch") },
    [TATUAJE]: { body: loadFixture("product-tatuaje-black-label-petite-lancero.html", "small-batch") },
    [CALDWELL]: { body: loadFixture("landing-caldwell.html", "small-batch") },
    [CUTTER]: { body: loadFixture("product-xikar-xi3-cutter.html", "small-batch") },
  });

  it("passes the live robots.txt, which asks for no crawl delay and blocks no product slug", async () => {
    const result = await runProbe(createMockFetcher(liveRoutes()), smallBatchCigar);
    expect(result.robots.status).toBe(200);
    expect(result.robots.matchedAgent).toBe("*");
    expect(result.robots.productPathAllowed).toBe(true);
  });

  it("reads a FLAT urlset and admits only the one-segment slugs", async () => {
    const fetcher = createMockFetcher(liveRoutes());
    const result = await runProbe(fetcher, smallBatchCigar);

    expect(result.sitemap.kind).toBe("urlset"); // no sitemapindex, so no product-only child to aim at
    expect(result.sitemap.enumeratedLocs).toBe(12);
    // 4 accepted: two products, a brand landing page, an accessory. Rejected: the
    // root, the /blog/<slug> post (depth), and the six named root slugs.
    expect(result.sitemap.productLocs).toBe(4);
    expect(formatProbe(result)).toContain(
      "out / 1 · /accessories 1 · /blog 1 · /blog/why-the-lancero-endures 1 · /boards 1 (+3 keys, 3 urls)",
    );
    expectWithinBudget(fetcher, smallBatchCigar);
  });

  it("reports needs-attention because the grouped cigar publishes no price", async () => {
    const result = await runProbe(createMockFetcher(liveRoutes()), smallBatchCigar);

    // spreadIndices(4, 3) draws the first product, the landing page and the
    // accessory — which is the sample this vendor deserves: the landing page is
    // ~23% of what the gate accepts and cannot be excluded by URL shape.
    expect(result.products.map((p) => p.url)).toEqual([EASTERN, CALDWELL, CUTTER]);
    expect(result.products[1]!.hasProduct).toBe(false); // /caldwell is a brand page
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 2, cigars: 1, placeholderPrices: 1 });
    expect(result.verdict).toBe("needs-attention");
    expect(result.notes.join(" ")).toMatch(/publishes a PLACEHOLDER price of 0/);
  });

  it("parses the cigar itself correctly — only the price is missing", async () => {
    const result = await runProbe(createMockFetcher(liveRoutes()), smallBatchCigar);
    const eastern = result.products[0]!;

    expect(eastern.name).toBe("Eastern Standard Sungrown Toro Extra");
    // The brand-first taxonomy `/./` was widened for: it names no cigar category.
    expect(eastern.category).toEqual([
      "SHOP BY BRAND",
      "Caldwell",
      "Signature",
      "Eastern Standard Sungrown Toro Extra",
    ]);
    expect(eastern.isCigar).toBe(true);
    expect(eastern.priceCents).toBeNull();
    expect(eastern.priceIsPlaceholder).toBe(true);
    // The accessory is a single SKU and does carry a real price — the placeholder
    // is a grouped-product property, not a property of the site.
    const cutter = result.products[2]!;
    expect(cutter.priceCents).toBe(6499);
    expect(cutter.priceIsPlaceholder).toBe(false);
    expect(cutter.isCigar).toBe(false);
  });
});

describe("probeFetchBudget", () => {
  it("scales with the adapter's sample count", () => {
    expect(probeFetchBudget(cubanLous)).toBe(10);
    expect(probeFetchBudget(twoGuysCigars)).toBe(22); // 4 samples
  });
});

// =============================================================================
// The four Habanos picture sources, probed against their live shapes (#270).
// Each set is the 2026-09-02 in-cluster read reduced to the pages that decide a
// verdict; the numbers the LIVE probe must reproduce are in each adapter header.
// =============================================================================

describe("Montefortuna, live shape — a Yoast index, a marca breadcrumb and no price", () => {
  const mf = (path: string): string => `https://www.montefortunacigars.com${path}`;
  const fx = (name: string): string => loadFixture(name, "montefortuna");
  const SHOP = mf("/shop/");
  const COHIBA = mf("/shop/cohiba-siglo-vi/");
  const CUTTER = mf("/shop/xikar-xi3-cutter/");

  const routes = (): Record<string, MockRoute> => ({
    [mf("/robots.txt")]: { body: fx("robots.txt") },
    [montefortuna.sitemapUrl]: { body: fx("sitemap-index.xml") },
    // The three children `selectIndexChildren` picks out of the ten: the catalog
    // child by name, plus the first and last of the index.
    [mf("/product-sitemap.xml")]: { body: fx("product-sitemap.xml") },
    [mf("/post-sitemap.xml")]: { body: urlsetXml([mf("/blog/habanos-2026-releases/")]) },
    [mf("/product_tag-sitemap.xml")]: { body: urlsetXml([mf("/product-tag/robusto/")]) },
    [SHOP]: { body: fx("landing-shop.html") },
    [COHIBA]: { body: fx("product-cohiba-siglo-vi.html") },
    [CUTTER]: { body: fx("product-cutter.html") },
  });

  it("passes the live robots.txt, whose Content-Signal is a reservation and not a rule we break", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, montefortuna);

    // We are none of the named bots (ClaudeBot, GPTBot, CCBot, …), so we fall
    // under `*`, which allows `/`. The `Content-Signal` line is not an allow/deny
    // directive and the parser ignores it for that purpose.
    expect(result.robots.matchedAgent).toBe("*");
    expect(result.robots.productPathAllowed).toBe(true);
  });

  it("descends the Yoast index to the catalog child and gates /shop/ down to five locs", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, montefortuna);

    expect(result.sitemap.kind).toBe("sitemapindex");
    expect(result.sitemap.totalLocs).toBe(10);
    expect(result.sitemap.sampledChildren).toHaveLength(MAX_PROBE_CHILDREN);
    expect(result.sitemap.sampledChildren).toContain(mf("/product-sitemap.xml"));
    // Seven locs in that child; the brand archive and the pagination are
    // subtracted by `nonProductPathPattern`.
    expect(result.sitemap.productLocs).toBe(5);
    expectWithinBudget(fetcher, montefortuna);
  });

  it("parses two of three samples and admits the cigar on its marca trail", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, montefortuna);

    expect(result.products.map((p) => p.url)).toEqual([SHOP, COHIBA, CUTTER]);
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 2, cigars: 1, placeholderPrices: 0 });
    // The /shop/ root is in the sitemap and carries no Product; the probe names it
    // rather than counting it against the vendor.
    expect(result.products[0]!.parsed).toBe(false);
    expect(result.notes.join(" ")).toContain(`sample product ${SHOP} has no schema.org Product JSON-LD`);
    expect(result.verdict).toBe("ok");
  });

  it("reads the cigar with a sku, no price, and the product shot rather than the logo", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, montefortuna);
    const cohiba = result.products[1]!;

    expect(cohiba.name).toBe("Cohiba Siglo VI");
    expect(cohiba.category).toEqual(["Home", "Shop", "Cohiba", "Cohiba Siglo VI"]);
    expect(cohiba.isCigar).toBe(true);
    // NO PRICE is not a placeholder price: the offer states availability only, so
    // the price is unknown and the vendor still passes.
    expect(cohiba.priceCents).toBeNull();
    expect(cohiba.priceIsPlaceholder).toBe(false);
    expect(cohiba.photoUrl).toBe(
      "https://www.montefortunacigars.com/wp-content/uploads/2019/07/Cohiba-Siglo-VI-Cigar-Web-1.jpg",
    );
    expect(result.products[2]!.isCigar).toBe(false);
    expect(formatProbe(result)).toContain("category=Home / Shop / Cohiba / Cohiba Siglo VI");
  });

  // The two shapes the sitemap enumerates and the probe's spread does not sample.
  // Both parse; both are refused by NAME, under a breadcrumb that says "cigar".
  it("refuses a multi-box lot and a single stick on the name pattern alone", async () => {
    const lot = extractProductMarkup(fx("product-2-boxes-montecristo.html"), montefortuna);
    const single = extractProductMarkup(fx("product-partagas-shorts-single.html"), montefortuna);
    const listingOf = (m: ReturnType<typeof extractProductMarkup>) =>
      normalizeListing(m.product!, m.category, m.categorySource)!;

    expect(listingOf(lot).name).toBe("2 Boxes of 25 Montecristo No. 4");
    expect(isCigarCategory(listingOf(lot).categoryPath, montefortuna)).toBe(true);
    expect(isCigarListing(listingOf(lot), montefortuna)).toBe(false);

    expect(listingOf(single).name).toBe("Partagas Shorts - Single");
    expect(isCigarListing(listingOf(single), montefortuna)).toBe(false);
  });
});

describe("EGM, live shape — a Shopify ProductGroup and a category with no breadcrumb", () => {
  const egm = (path: string): string => `https://egmcigars.com${path}`;
  const fx = (name: string): string => loadFixture(name, "egm-cigars");
  const QUERY = "?from=11256354948&to=9033607840001";
  const COHIBA = egm("/products/cohiba-siglo-6-slb");
  const CUTTER = egm("/products/halo-onyx-cigar-cutter");

  const routes = (): Record<string, MockRoute> => ({
    [egm("/robots.txt")]: { body: fx("robots.txt") },
    [egmCigars.sitemapUrl]: { body: fx("sitemap.xml") },
    [egm(`/sitemap_products_1.xml${QUERY}`)]: { body: fx("sitemap-products-1.xml") },
    [egm(`/en-gb/sitemap_products_1.xml${QUERY}`)]: { body: fx("sitemap-products-1-en-gb.xml") },
    [COHIBA]: { body: fx("product.html") },
    [CUTTER]: { body: fx("product-cutter.html") },
  });

  it("crawls the catalogue once — the locale copy is on the rejected side of the gate", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, egmCigars);

    expect(result.sitemap.kind).toBe("sitemapindex");
    expect(result.sitemap.enumeratedLocs).toBe(4);
    expect(result.sitemap.productLocs).toBe(2);
    expect(result.pathShapes.rejected.top.map((e) => e.key)).toContain("/en-gb/products");
    expectWithinBudget(fetcher, egmCigars);
  });

  it("parses the ProductGroup, prices it off the lifted variant offer, and gates on `category`", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, egmCigars);
    const cohiba = result.products[0]!;

    expect(result.productSummary).toEqual({ sampled: 2, parsed: 2, cigars: 1, placeholderPrices: 0 });
    expect(cohiba.name).toBe("Cohiba Siglo VI Cigar");
    expect(cohiba.category).toEqual(["Cigars"]);
    expect(cohiba.priceCents).toBe(10694);
    expect(cohiba.currency).toBe("CHF");
    expect(cohiba.isCigar).toBe(true);
    expect(cohiba.photoUrl).toBe(
      "https://egmcigars.com/cdn/shop/files/Cohiba_Siglo_VI_Cigar_Box_of_25_Cigars_EGM_Cigars.jpg?v=1693381836",
    );
    expect(result.products[1]!.isCigar).toBe(false);
    expect(result.verdict).toBe("ok");
  });

  it("finds no product on a collection page, whatever the gate did with its URL", () => {
    const { product, category } = extractProductMarkup(fx("landing-collection.html"), egmCigars);
    expect(product).toBeNull();
    expect(category).toEqual([]);
  });
});

describe("Cigarworld.de, live shape — a German taxonomy, real prices and a thumbnail photo", () => {
  const cw = (path: string): string => `https://www.cigarworld.de${path}`;
  const fx = (name: string): string => loadFixture(name, "cigarworld-de");
  const RAS = cw("/zigarren/kuba/regulares/ramon-allones-specially-selected-01025_3430");
  const SORTIMENT = cw("/zigarren/kuba/regulares/kuba-sortiment-01099_9001");

  const routes = (): Record<string, MockRoute> => ({
    [cw("/robots.txt")]: { body: fx("robots.txt") },
    [cigarworldDe.sitemapUrl]: { body: fx("sitemap.xml") },
    [cw("/sitemap_de.xml")]: { body: fx("sitemap-de.xml") },
    [cw("/sitemap_en.xml")]: { body: fx("sitemap-en.xml") },
    [RAS]: { body: fx("product.html") },
    [SORTIMENT]: { body: fx("product-cutter.html") },
  });

  it("is allowed by a robots.txt that names CCBot and BLEXBot but not us", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, cigarworldDe);

    expect(result.robots.matchedAgent).toBe("*");
    expect(result.robots.productPathAllowed).toBe(true);
  });

  it("keeps /zigarrenzubehoer/, /zigarillos/ and the /en/ copy out of the gate", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, cigarworldDe);

    expect(result.sitemap.kind).toBe("sitemapindex");
    expect(result.sitemap.enumeratedLocs).toBe(9);
    expect(result.sitemap.productLocs).toBe(2);
    // Seven of the nine enumerated locs are refused, and the census names where
    // they live. `/zigarrenzubehoer/humidor` is one of them and sits in the tail
    // behind the five ties the top-N shows — the gate itself is asserted URL by
    // URL in `product-url.test.ts`.
    expect(result.pathShapes.rejected.total).toBe(7);
    const rejected = result.pathShapes.rejected.top.map((e) => e.key);
    expect(rejected).toContain("/en/cigars");
    expect(rejected).toContain("/zigarillos/kuba");
    expectWithinBudget(fetcher, cigarworldDe);
  });

  it("reads the price and rewrites the 300x51 thumbnail to the /big/ asset", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, cigarworldDe);
    const ras = result.products[0]!;

    expect(result.productSummary).toEqual({ sampled: 2, parsed: 2, cigars: 1, placeholderPrices: 0 });
    expect(ras.name).toBe("Ramon Allones Specially Selected");
    expect(ras.priceCents).toBe(1800);
    expect(ras.currency).toBe("EUR");
    expect(ras.category).toEqual([
      "Shop",
      "Zigarren",
      "Kuba",
      "Regulares",
      "Ramon Allones",
      "Zigarren",
      "Specially Selected",
    ]);
    expect(ras.isCigar).toBe(true);
    expect(ras.photoUrl).toBe("https://www.cigarworld.de/bilder/detail/big/2390.jpg");
    // The `photo=` line is how an operator sees the rewrite fired at all.
    expect(formatProbe(result)).toContain("photo=https://www.cigarworld.de/bilder/detail/big/2390.jpg");
    // A mixed selection under the same cigar trail, refused by name.
    expect(result.products[1]!.name).toBe("Kuba Sortiment 6 Zigarren");
    expect(result.products[1]!.isCigar).toBe(false);
    expect(result.verdict).toBe("ok");
  });

  it("would refuse the Grosstubo on its breadcrumb even if the prefix ever admitted it", () => {
    const markup = extractProductMarkup(fx("product-humidor.html"), cigarworldDe);
    const listing = normalizeListing(markup.product!, markup.category, markup.categorySource)!;

    expect(listing.name).toContain("Cohiba Siglo VI");
    expect(listing.categoryPath[1]).toBe("Zigarrenzubehör");
    expect(isCigarListing(listing, cigarworldDe)).toBe(false);
  });

  it("finds no product on a category page inside the prefix", () => {
    expect(extractProductMarkup(fx("landing-zigarren-kuba.html"), cigarworldDe).product).toBeNull();
  });
});

describe("J.J. Fox, live shape — 2 Guys' markup on a Magento store", () => {
  const jj = (path: string): string => `https://www.jjfox.co.uk${path}`;
  const fx = (name: string): string => loadFixture(name, "jj-fox");
  const PARTAGAS = jj("/partagas-shorts-842.html");
  const CUTTER = jj("/xikar-xi3-cigar-cutter-901.html");
  const COHIBA_OOS = jj("/cohiba-siglo-vi.html");

  const routes = (): Record<string, MockRoute> => ({
    [jj("/robots.txt")]: { body: fx("robots.txt") },
    [jjFox.sitemapUrl]: { body: fx("sitemap.xml") },
    [PARTAGAS]: { body: fx("product.html") },
    [CUTTER]: { body: fx("product-cutter.html") },
  });

  it("selects the root-level .html products out of a flat urlset", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, jjFox);

    expect(result.sitemap.kind).toBe("urlset");
    expect(result.sitemap.enumeratedLocs).toBe(8);
    expect(result.sitemap.productLocs).toBe(2);
    expect(result.robots.productPathAllowed).toBe(true);
    expectWithinBudget(fetcher, jjFox);
  });

  it("reads the OG tags, decodes the Magento hex spaces and strips the photo query", async () => {
    const fetcher = createMockFetcher(routes());
    const result = await runProbe(fetcher, jjFox);
    const partagas = result.products[0]!;

    expect(result.productSummary).toEqual({ sampled: 2, parsed: 2, cigars: 1, placeholderPrices: 0 });
    // `og:title` is `Partagas&#x20;Shorts` on the wire.
    expect(partagas.name).toBe("Partagas Shorts");
    expect(partagas.priceCents).toBe(2450);
    expect(partagas.currency).toBe("GBP");
    expect(partagas.category).toEqual(["Cuban Cigar", "Cigar", "Habanos", "Partagas"]);
    expect(partagas.isCigar).toBe(true);
    expect(partagas.photoUrl).toBe(
      "https://www.jjfox.co.uk/media/catalog/product/P/a/Partagas_Shorts_box_of_25.jpg",
    );
    expect(result.products[1]!.isCigar).toBe(false);
    expect(result.verdict).toBe("ok");
  });

  // The number most likely to fail this vendor's live probe, and it is a shelf
  // state rather than a broken adapter: an out-of-stock line prices at "0".
  it("FAILS the vendor when an out-of-stock line publishes a price of zero", async () => {
    const fetcher = createMockFetcher({
      ...routes(),
      [jjFox.sitemapUrl]: { body: urlsetXml([PARTAGAS, COHIBA_OOS]) },
      [COHIBA_OOS]: { body: fx("product-out-of-stock.html") },
    });
    const result = await runProbe(fetcher, jjFox);
    const cohiba = result.products[1]!;

    expect(cohiba.name).toBe("Cohiba Siglo VI");
    expect(cohiba.isCigar).toBe(true);
    expect(cohiba.priceIsPlaceholder).toBe(true);
    // Unknown, never zero — the same reading Small Batch's grouped products got.
    expect(cohiba.priceCents).toBeNull();
    expect(result.productSummary.placeholderPrices).toBe(1);
    expect(result.verdict).toBe("needs-attention");
    expect(result.notes.join(" ")).toContain("PLACEHOLDER price of 0");
  });

  it("stays silent on a category page: no og:type, no keywords, no product", () => {
    const { product, category } = extractProductMarkup(fx("landing-cigars.html"), jjFox);
    expect(product).toBeNull();
    expect(category).toEqual([]);
  });
});
