import { describe, it, expect } from "vitest";
import { runProbe } from "./core/probe.js";
import { twoGuysCigars } from "./adapters/two-guys-cigars.js";
import { smallBatchCigar } from "./adapters/small-batch-cigar.js";
import { cubanLous } from "./adapters/cuban-lous.js";
import { createMockFetcher, loadFixture, type MockRoute } from "./testing/fixtures.js";
import type { VendorAdapter } from "./adapters/types.js";

// Per-adapter parse fixtures (ADR-006): the dev pod cannot fetch the live sites,
// so each new adapter carries a HAND-WRITTEN representative robots/sitemap/product
// set. We drive it through runProbe — the same read the coordinator runs
// in-cluster before enabling the vendor — to prove OUR pipeline parses the shape
// the adapter declares (product-path prefix, sitemap kind, JSON-LD, category
// gate). The live shapes themselves still need the in-cluster probe to confirm.

interface AdapterCase {
  adapter: VendorAdapter;
  dir: string;
  robotsUrl: string;
  sitemapUrl: string;
  childUrl?: string; // sitemapindex child, when the fixture is an index
  productUrl: string;
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
    expectedName: "Padron 1926 Serie No. 9 Maduro",
    expectedKind: "urlset",
  },
  {
    adapter: smallBatchCigar,
    dir: "small-batch",
    robotsUrl: "https://www.smallbatchcigar.com/robots.txt",
    sitemapUrl: "https://www.smallbatchcigar.com/sitemap.xml",
    childUrl: "https://www.smallbatchcigar.com/products-sitemap-1.xml",
    productUrl: "https://www.smallbatchcigar.com/products/tatuaje-brown-label-noella/",
    expectedName: "Tatuaje Brown Label Noella",
    expectedKind: "sitemapindex",
  },
  {
    adapter: cubanLous,
    dir: "cuban-lous",
    robotsUrl: "https://www.cubanlous.com/robots.txt",
    sitemapUrl: "https://www.cubanlous.com/product-sitemap.xml",
    productUrl: "https://www.cubanlous.com/montecristo-cigars/montecristo-no-4/",
    expectedName: "Montecristo No. 4",
    expectedKind: "urlset",
  },
];

describe("new vendor adapters — representative fixture parse (via runProbe)", () => {
  for (const c of cases) {
    it(`${c.adapter.slug}: robots + sitemap + product parse cleanly and gate to a cigar`, async () => {
      const routes: Record<string, MockRoute> = {
        [c.robotsUrl]: { body: loadFixture("robots.txt", c.dir) },
        [c.sitemapUrl]: { body: loadFixture("sitemap.xml", c.dir) },
        [c.productUrl]: { body: loadFixture("product.html", c.dir) },
      };
      if (c.childUrl) routes[c.childUrl] = { body: loadFixture("products-sitemap-1.xml", c.dir) };

      const result = await runProbe(createMockFetcher(routes), c.adapter);

      expect(result.verdict).toBe("ok");
      expect(result.robots.productPathAllowed).toBe(true);
      expect(result.sitemap.kind).toBe(c.expectedKind);
      expect(result.sitemap.productLocs).toBeGreaterThanOrEqual(1);
      expect(result.product?.url).toBe(c.productUrl);
      expect(result.product?.name).toBe(c.expectedName);
      expect(result.product?.isCigar).toBe(true);
      expect(result.product?.priceCents).toBeGreaterThan(0);
    });
  }

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
});
