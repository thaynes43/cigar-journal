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
// the adapter declares (product gate, sitemap kind, structured markup, category
// gate). The
// live shapes themselves still need the in-cluster probe to confirm.

interface AdapterCase {
  adapter: VendorAdapter;
  dir: string;
  robotsUrl: string;
  sitemapUrl: string;
  // The probe parses several spread-apart URLs, so each set routes two products:
  // a cigar (first in the sitemap) and an accessory.
  productUrl: string;
  cutterUrl: string;
  expectedName: string;
  expectedKind: "urlset" | "sitemapindex";
}

// Two adapters are NOT in this list, for two different reasons — and both are
// asserted against their real shapes in `core/probe.test.ts` instead.
//
// 2 Guys CAN now produce a parsed product (the OG/microdata extractor and the
// keywords category source landed with #252), but this harness is shaped for a
// hand-written pair (`product.html` + `product-cutter.html`, exactly one cigar)
// and its fixtures are verbatim live captures under their own names.
//
// Small Batch cannot clear the harness at all: it asserts a priced cigar, and
// the 2026-09-02 live read (#270) found `"0.00"` on every grouped cigar page, so
// its honest verdict is needs-attention until an HTML price extractor exists.
//
// Re-writing either vendor's pages to fit this shape is the mistake this whole
// lane has been unwinding.
const cases: AdapterCase[] = [
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
  // carrying no products at all. Four samples union past it — the enumeration is
  // what is under test here, so it holds regardless of what the pages parse to.
  it("two-guys: sampling absorbs a sitemap that alternates between product-bearing and cold", async () => {
    const warm = loadFixture("sitemap.xml", "two-guys");
    const cold = loadFixture("sitemap-cold.xml", "two-guys");
    const fetcher = createMockFetcher({
      ["https://www.2guyscigars.com/robots.txt"]: { body: loadFixture("robots.txt", "two-guys") },
      [twoGuysCigars.sitemapUrl]: {
        sequence: [{ body: cold }, { body: warm }, { body: cold }, { body: cold }],
      },
    });

    const result = await runProbe(fetcher, twoGuysCigars);

    expect(result.sitemap.samples).toHaveLength(4);
    expect(result.sitemap.varied).toBe(true);
    // Only the warm sample carried product-code slugs; the union is its nine.
    expect(result.sitemap.productLocs).toBe(9);
    expect(result.notes.join(" ")).toMatch(/VARIES/);
    expect(fetcher.pagesFetched).toBeLessThanOrEqual(probeFetchBudget(twoGuysCigars));
  });

  it("ships all three new adapters crawl_enabled=false until a live probe passes", () => {
    for (const c of cases) {
      expect(c.adapter.crawlEnabled).toBe(false);
    }
    // The two outside `cases` are the ones that most need saying — both have now
    // been live-probed, and both failed. Enabling either is a registry decision
    // an operator makes; it is never an adapter edit.
    expect(twoGuysCigars.crawlEnabled).toBe(false);
    expect(smallBatchCigar.crawlEnabled).toBe(false);
    // Cuban Lou's posture: unapproved + no purchase link-out (owner ruling).
    expect(cubanLous.approvalStatus).toBe("unapproved");
    expect(cubanLous.purchaseLinkout).toBe(false);
    // NC vendors keep their link-out.
    expect(twoGuysCigars.purchaseLinkout).toBe(true);
    expect(smallBatchCigar.purchaseLinkout).toBe(true);
  });

  it("carries the crawl-shape fixes the live probes called for", () => {
    // 2 Guys served varying sitemap content on 2026-08-29 (not reproduced since)
    // — the enumeration unions N fetches until two clean probes POST-enablement
    // say otherwise.
    expect(twoGuysCigars.sitemapSampling?.samples).toBe(4);
    // Mode B since 2026-09-01 (#217): its products are root-level slugs, so there
    // is no prefix left to gate on.
    expect(twoGuysCigars.productPathPrefix).toBeUndefined();
    expect(twoGuysCigars.nonProductPathPattern).toBeInstanceOf(RegExp);
    expect(twoGuysCigars.productPathSegments).toEqual({ min: 1, max: 1 });
    // Its robots.txt asks `*` for Crawl-delay: 5 (live capture 2026-09-01), which
    // the parser ignores and the adapter has to honor. Below 5000 we would be
    // crawling faster than the vendor asked.
    expect(twoGuysCigars.minIntervalMs).toBe(5000);
    // #179 left a seed crawl unbounded: no maxPages against an uncapped fetcher.
    expect(twoGuysCigars.maxPages).toBeGreaterThan(0);
    // Small Batch products are root-level slugs: exclusion gate, no prefix.
    expect(smallBatchCigar.productPathPrefix).toBeUndefined();
    expect(smallBatchCigar.nonProductPathPattern).toBeInstanceOf(RegExp);
    // #270, live 2026-09-02. Its taxonomy is brand-first and never says "cigars",
    // so `/cigar/i` passed 4 of 20 real cigar pages — the category gate is now
    // "any taxonomy at all" and the exclusion carries the load.
    expect(smallBatchCigar.cigarCategoryPattern.source).toBe(".");
    expect(smallBatchCigar.excludePattern.test("SHOP BY BRAND / Gift Cards")).toBe(true);
    // Its robots.txt asks for NO Crawl-delay, so the interval is discretionary
    // politeness rather than a vendor requirement — above the 2.5s default, and
    // deliberately below 2 Guys' asked-for 5s.
    expect(smallBatchCigar.minIntervalMs).toBe(3000);
    // The cap is far below a full pass (10,955 accepted locs) and the fetcher
    // THROWS at it — a seed needs a raised cap plus a deadline, not a longer wait.
    expect(smallBatchCigar.maxPages).toBe(500);
  });
});
