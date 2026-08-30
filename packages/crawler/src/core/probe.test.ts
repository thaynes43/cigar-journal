import { describe, it, expect } from "vitest";
import { runProbe, formatProbe, probeFetchBudget, MAX_PROBE_CHILDREN } from "./probe.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import {
  createMockFetcher,
  loadFixture,
  urlsetXml,
  type MockFetcher,
  type MockRoute,
} from "../testing/fixtures.js";
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

// The live 2026-08-30 2 Guys failure, reproduced and then fixed in one place.
// `/store/` is the right product prefix and ALSO matches `/store/go/registry/<n>/`
// — gift-registry pages carrying no Product JSON-LD. All three spread picks
// landed inside that block, so the probe printed "no schema.org Product JSON-LD"
// on a vendor whose actual fault was the gate. The verdict was true; the reason
// was not, and a seed crawl would have fetched ~1,400 registry pages.
describe("2 Guys product gate — the /store/go/ registry block", () => {
  const PADRON = "https://www.2guyscigars.com/store/padron-1926-serie-no-9-maduro/";
  const CUTTER = "https://www.2guyscigars.com/store/xikar-xi3-cutter/";
  const ABOUT = "https://www.2guyscigars.com/about-us/";
  // Ids placed so spreadIndices(14, 3) = [2, 7, 11] draws 1059, 4401 and 8079 —
  // the three URLs the live probe really sampled.
  const registryLocs = [612, 840, 1059, 1783, 2450, 3117, 3760, 4401, 5502, 6390, 7233, 8079].map(
    (id) => `https://www.2guyscigars.com/store/go/registry/${id}/`,
  );

  // Same catalog every time; only the non-product block under /store/ varies.
  const routesFor = (nonProductLocs: string[]): Record<string, MockRoute> => {
    const routes: Record<string, MockRoute> = {
      ["https://www.2guyscigars.com/robots.txt"]: { body: loadFixture("robots.txt", "two-guys") },
      [twoGuysCigars.sitemapUrl]: {
        body: urlsetXml(["https://www.2guyscigars.com/", ...nonProductLocs, PADRON, CUTTER, ABOUT]),
      },
      [PADRON]: { body: loadFixture("product.html", "two-guys") },
      [CUTTER]: { body: loadFixture("product-cutter.html", "two-guys") },
    };
    for (const loc of nonProductLocs) routes[loc] = { body: loadFixture("registry.html", "two-guys") };
    return routes;
  };

  it("reproduces the live false verdict with the exclusion removed", async () => {
    const unfixed: VendorAdapter = { ...twoGuysCigars, nonProductPathPattern: undefined };
    const fetcher = createMockFetcher(routesFor(registryLocs));
    const result = await runProbe(fetcher, unfixed);

    expect(result.sitemap.productLocs).toBe(14); // 12 registry + 2 real products
    expect(result.products.map((p) => p.url)).toEqual([
      "https://www.2guyscigars.com/store/go/registry/1059/",
      "https://www.2guyscigars.com/store/go/registry/4401/",
      "https://www.2guyscigars.com/store/go/registry/8079/",
    ]);
    // Byte-for-byte the live line: 200, but nothing to parse.
    expect(result.products.every((p) => p.status === 200 && !p.hasProduct)).toBe(true);
    expect(result.productSummary).toEqual({ sampled: 3, parsed: 0, cigars: 0 });
    expect(result.verdict).toBe("needs-attention");
    expect(result.notes.join(" ")).toMatch(/no schema\.org Product JSON-LD/);
    expectWithinBudget(fetcher, unfixed);
  });

  it("reaches the real products once /store/go/ is subtracted", async () => {
    const fetcher = createMockFetcher(routesFor(registryLocs));
    const result = await runProbe(fetcher, twoGuysCigars);

    expect(result.sitemap.productLocs).toBe(2);
    expect(result.products.map((p) => p.url)).toEqual([PADRON, CUTTER]);
    expect(result.productSummary).toEqual({ sampled: 2, parsed: 2, cigars: 1 });
    expect(result.verdict).toBe("ok");
    expect(result.gate).toBe("prefix /store/ minus /^\\/store\\/go(?:\\/|$)/i");
    expectWithinBudget(fetcher, twoGuysCigars);
  });

  // Diagnosability, on the exact run that misled us. Every probe here is an
  // in-cluster Job, so a needs-attention has to name the shape it saw or the next
  // move costs another round-trip.
  it("names the registry block in the path census on both sides of the gate", async () => {
    const unfixed: VendorAdapter = { ...twoGuysCigars, nonProductPathPattern: undefined };
    const broken = formatProbe(await runProbe(createMockFetcher(routesFor(registryLocs)), unfixed));
    // The accepted side shows the gate admitting a non-product subtree — the one
    // line that would have identified the defect on the first probe.
    expect(broken).toContain("paths: in  /store/go 12");
    expect(broken).toContain("out / 1 · /about-us 1");

    const fixed = formatProbe(await runProbe(createMockFetcher(routesFor(registryLocs)), twoGuysCigars));
    // After the fix the block has moved to the rejected side.
    expect(fixed).toContain("out /store/go 12");
    expect(fixed).toContain("paths: in  /store/padron-1926-serie-no-9-maduro 1");
  });

  it("collapses a long tail of shapes into a (+keys, urls) count", async () => {
    // Eight distinct rejected shapes, so the top-5 cut leaves a tail to report.
    const junk = ["blog", "brands", "pages", "help", "news", "events", "press", "legal"].map(
      (segment) => `https://www.2guyscigars.com/${segment}/x/`,
    );
    const routes = routesFor(registryLocs);
    routes[twoGuysCigars.sitemapUrl] = {
      body: urlsetXml([...junk, ...registryLocs, PADRON, CUTTER, ABOUT]),
    };
    const out = formatProbe(await runProbe(createMockFetcher(routes), twoGuysCigars));

    // 10 rejected keys (8 junk + /store/go + /about-us), 5 shown: 5 hidden keys
    // behind 5 URLs — /store/go is the count-12 key, so it is never in the tail.
    expect(out).toMatch(/out .*\(\+5 keys, 5 urls\)/);
  });

  it("excludes the whole /store/go/ family, not just registry", async () => {
    // Siblings we have never sampled. If the gate named `registry` these would
    // pass and the sampler would draw them exactly as it drew the registry pages.
    const siblings = Array.from({ length: 6 }, (_, i) => [
      `https://www.2guyscigars.com/store/go/wishlist/${i}/`,
      `https://www.2guyscigars.com/store/go/cart/${i}/`,
    ]).flat();
    const result = await runProbe(createMockFetcher(routesFor(siblings)), twoGuysCigars);

    expect(result.sitemap.productLocs).toBe(2);
    expect(result.products.map((p) => p.url)).toEqual([PADRON, CUTTER]);
    expect(result.verdict).toBe("ok");
  });
});

describe("probeFetchBudget", () => {
  it("scales with the adapter's sample count", () => {
    expect(probeFetchBudget(cubanLous)).toBe(10);
    expect(probeFetchBudget(twoGuysCigars)).toBe(22); // 4 samples
  });
});
