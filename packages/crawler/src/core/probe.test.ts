import { describe, it, expect } from "vitest";
import { runProbe, formatProbe, probeFetchBudget, MAX_PROBE_CHILDREN } from "./probe.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import { createMockFetcher, urlsetXml, type MockFetcher, type MockRoute } from "../testing/fixtures.js";
import type { VendorAdapter } from "../adapters/types.js";

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
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 2, cigars: 2 });
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
    // Uses 2 Guys (real "/store/" prefix) — cubanLous now carries "/" which
    // matches every loc by design (its sitemap is product-only).
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
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 3, cigars: 3 });
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
    expect(oneOfThree.productSummary).toEqual({ sampled: 3, parsed: 1, cigars: 1 });
    expect(oneOfThree.verdict).toBe("needs-attention");
    expect(oneOfThree.notes.filter((n) => n.startsWith("sample product"))).toHaveLength(2);

    const twoOfThree = await build(2, 3);
    expect(twoOfThree.productSummary.parsed).toBe(2);
    expect(twoOfThree.verdict).toBe("ok");

    // A one-product catalog can still pass — the floor is min(2, sampled).
    const oneOfOne = await build(1, 1);
    expect(oneOfOne.productSummary).toEqual({ sampled: 1, parsed: 1, cigars: 1 });
    expect(oneOfOne.verdict).toBe("ok");
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
    expect(result.notes.join(" ")).toMatch(/sitemapindex has 20 children; probe sampled 3/);
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

describe("probeFetchBudget", () => {
  it("scales with the adapter's sample count", () => {
    expect(probeFetchBudget(cubanLous)).toBe(10);
    expect(probeFetchBudget(twoGuysCigars)).toBe(22); // 4 samples
  });
});
