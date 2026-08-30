import { describe, it, expect } from "vitest";
import { runProbe, probeFetchBudget } from "./core/probe.js";
import { twoGuysCigars } from "./adapters/two-guys-cigars.js";
import { smallBatchCigar } from "./adapters/small-batch-cigar.js";
import { cubanLous } from "./adapters/cuban-lous.js";
import { createMockFetcher, loadFixture, type MockRoute } from "./testing/fixtures.js";
import type { VendorAdapter } from "./adapters/types.js";

// Per-adapter parse fixtures (ADR-006): the dev pod cannot fetch the live sites,
// so each new adapter carries a HAND-WRITTEN representative robots/sitemap/product
// set. We drive it through runProbe — the same read the coordinator runs
// in-cluster before enabling the vendor — to prove OUR pipeline parses the shape
// the adapter declares (product gate, sitemap kind, JSON-LD, category gate). The
// live shapes themselves still need the in-cluster probe to confirm.

interface AdapterCase {
  adapter: VendorAdapter;
  dir: string;
  robotsUrl: string;
  sitemapUrl: string;
  childUrl?: string; // sitemapindex child, when the fixture is an index
  // The probe parses several spread-apart URLs, so each set routes two products:
  // a cigar (first in the sitemap) and an accessory.
  productUrl: string;
  cutterUrl: string;
  expectedName: string;
  expectedKind: "urlset" | "sitemapindex";
}

const cases: AdapterCase[] = [
  {
    adapter: twoGuysCigars,
    dir: "two-guys",
    robotsUrl: "https://www.2guyscigars.com/robots.txt",
    sitemapUrl: "https://www.2guyscigars.com/sitemap.xml",
    productUrl: "https://www.2guyscigars.com/store/padron-1926-serie-no-9-maduro/",
    cutterUrl: "https://www.2guyscigars.com/store/xikar-xi3-cutter/",
    expectedName: "Padron 1926 Serie No. 9 Maduro",
    expectedKind: "urlset",
  },
  {
    adapter: smallBatchCigar,
    dir: "small-batch",
    robotsUrl: "https://www.smallbatchcigar.com/robots.txt",
    sitemapUrl: "https://www.smallbatchcigar.com/sitemap.xml",
    childUrl: "https://www.smallbatchcigar.com/products-sitemap-1.xml",
    productUrl: "https://www.smallbatchcigar.com/tatuaje-brown-label-noella/",
    cutterUrl: "https://www.smallbatchcigar.com/xikar-xi3-cutter/",
    expectedName: "Tatuaje Brown Label Noella",
    expectedKind: "sitemapindex",
  },
  {
    adapter: cubanLous,
    dir: "cuban-lous",
    robotsUrl: "https://www.cubanlous.com/robots.txt",
    sitemapUrl: "https://www.cubanlous.com/product-sitemap.xml",
    productUrl: "https://www.cubanlous.com/montecristo-cigars/montecristo-no-4/",
    cutterUrl: "https://www.cubanlous.com/accessories/xikar-cutter/",
    expectedName: "Montecristo No. 4",
    expectedKind: "urlset",
  },
];

describe("new vendor adapters — representative fixture parse (via runProbe)", () => {
  for (const c of cases) {
    it(`${c.adapter.slug}: robots + sitemap + products parse cleanly and gate to a cigar`, async () => {
      const routes: Record<string, MockRoute> = {
        [c.robotsUrl]: { body: loadFixture("robots.txt", c.dir) },
        [c.sitemapUrl]: { body: loadFixture("sitemap.xml", c.dir) },
        [c.productUrl]: { body: loadFixture("product.html", c.dir) },
        [c.cutterUrl]: { body: loadFixture("product-cutter.html", c.dir) },
      };
      if (c.childUrl) routes[c.childUrl] = { body: loadFixture("products-sitemap-1.xml", c.dir) };

      const fetcher = createMockFetcher(routes);
      const result = await runProbe(fetcher, c.adapter);

      expect(result.verdict).toBe("ok");
      expect(result.robots.productPathAllowed).toBe(true);
      expect(result.sitemap.kind).toBe(c.expectedKind);
      // For 2 Guys this is 2, not 14: the fixture's twelve `/store/go/registry/<n>/`
      // locs are inside the prefix but subtracted by the exclusion.
      expect(result.sitemap.productLocs).toBeGreaterThanOrEqual(1);
      // Both routed products parse; the accessory is correctly not a cigar.
      expect(result.productSummary.parsed).toBeGreaterThanOrEqual(2);
      expect(result.productSummary.cigars).toBe(1);
      expect(result.products[0]!.url).toBe(c.productUrl);
      expect(result.products[0]!.name).toBe(c.expectedName);
      expect(result.products[0]!.isCigar).toBe(true);
      expect(result.products[0]!.priceCents).toBeGreaterThan(0);
      // The CLI sizes the fetcher's page guard from this — it must cover a probe.
      expect(fetcher.pagesFetched).toBeLessThanOrEqual(probeFetchBudget(c.adapter));
    });
  }

  // The live 2 Guys failure mode (2026-08-29), replayed against the real adapter:
  // the same sitemap URL alternates between a product-bearing response and one
  // with no /store/ entries at all. Four samples union past it.
  it("two-guys: sampling absorbs a sitemap that alternates between product-bearing and cold", async () => {
    const warm = loadFixture("sitemap.xml", "two-guys");
    const cold = loadFixture("sitemap-cold.xml", "two-guys");
    const fetcher = createMockFetcher({
      ["https://www.2guyscigars.com/robots.txt"]: { body: loadFixture("robots.txt", "two-guys") },
      [twoGuysCigars.sitemapUrl]: {
        sequence: [{ body: cold }, { body: warm }, { body: cold }, { body: cold }],
      },
      ["https://www.2guyscigars.com/store/padron-1926-serie-no-9-maduro/"]: {
        body: loadFixture("product.html", "two-guys"),
      },
      ["https://www.2guyscigars.com/store/xikar-xi3-cutter/"]: {
        body: loadFixture("product-cutter.html", "two-guys"),
      },
    });

    const result = await runProbe(fetcher, twoGuysCigars);

    expect(result.sitemap.samples).toHaveLength(4);
    expect(result.sitemap.varied).toBe(true);
    // Only the warm sample carried /store/ locs, and its twelve registry locs are
    // excluded by the gate — so the union is the two real products.
    expect(result.sitemap.productLocs).toBe(2);
    expect(result.notes.join(" ")).toMatch(/VARIES/);
    expect(result.verdict).toBe("ok");
    expect(fetcher.pagesFetched).toBeLessThanOrEqual(probeFetchBudget(twoGuysCigars));
  });

  it("ships all three new adapters crawl_enabled=false until a live probe passes", () => {
    for (const c of cases) {
      expect(c.adapter.crawlEnabled).toBe(false);
    }
    // Cuban Lou's posture: unapproved + no purchase link-out (owner ruling).
    expect(cubanLous.approvalStatus).toBe("unapproved");
    expect(cubanLous.purchaseLinkout).toBe(false);
    // NC vendors keep their link-out.
    expect(twoGuysCigars.purchaseLinkout).toBe(true);
    expect(smallBatchCigar.purchaseLinkout).toBe(true);
  });

  it("carries the crawl-shape fixes the live 2026-08-29 probes called for", () => {
    // 2 Guys served varying sitemap content on 2026-08-29 (not reproduced on
    // 2026-08-30) — the enumeration unions N fetches until two clean probes say
    // otherwise. Its `/store/` prefix also admits the `/store/go/` dispatcher
    // subtree, so Mode A subtracts that family (live probe 2026-08-30).
    expect(twoGuysCigars.sitemapSampling?.samples).toBe(4);
    expect(twoGuysCigars.nonProductPathPattern).toBeInstanceOf(RegExp);
    // Small Batch products are root-level slugs: exclusion gate, no prefix.
    expect(smallBatchCigar.productPathPrefix).toBeUndefined();
    expect(smallBatchCigar.nonProductPathPattern).toBeInstanceOf(RegExp);
  });
});
