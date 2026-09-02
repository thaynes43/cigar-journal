import { describe, it, expect } from "vitest";
import { runProbe, probeFetchBudget } from "./core/probe.js";
import { twoGuysCigars } from "./adapters/two-guys-cigars.js";
import { smallBatchCigar } from "./adapters/small-batch-cigar.js";
import { cubanLous } from "./adapters/cuban-lous.js";
import { montefortuna } from "./adapters/montefortuna.js";
import { egmCigars } from "./adapters/egm-cigars.js";
import { cigarworldDe } from "./adapters/cigarworld-de.js";
import { jjFox } from "./adapters/jj-fox.js";
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
  // Child sitemap URL → fixture file, for a vendor whose root is a sitemapINDEX.
  // The probe descends a bounded spread of children, so each one it picks has to
  // be routed or it reads as a fetch failure.
  childSitemaps?: Record<string, string>;
  // The probe parses several spread-apart URLs, so each set routes two products:
  // a cigar (FIRST in the sitemap, since the assertions below name products[0])
  // and one that is not a cigar. What makes the second one not a cigar varies by
  // vendor — an accessory aisle for most, a mixed `Sortiment` for Cigarworld,
  // whose accessories live outside the product prefix entirely.
  productUrl: string;
  productFile?: string;
  nonCigarUrl: string;
  nonCigarFile?: string;
  expectedName: string;
  expectedKind: "urlset" | "sitemapindex";
}

// Three adapters are NOT in this list, for three different reasons — and all
// three are asserted against their real shapes in `core/probe.test.ts` instead.
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
// Montefortuna cannot either, and for a reason that is not a defect: its JSON-LD
// `offers` carries availability and a URL and NO PRICE at all. That is fine for
// a tier-2 picture source — its offers would not be displayed if it had them —
// but this harness asserts `priceCents > 0`.
//
// Re-writing any of their pages to fit this shape is the mistake this whole lane
// has been unwinding.
const cases: AdapterCase[] = [
  {
    adapter: cubanLous,
    dir: "cuban-lous",
    robotsUrl: "https://www.cubanlous.com/robots.txt",
    sitemapUrl: "https://www.cubanlous.com/product-sitemap.xml",
    productUrl: "https://www.cubanlous.com/montecristo-cigars/montecristo-no-4/",
    nonCigarUrl: "https://www.cubanlous.com/accessories/xikar-cutter/",
    expectedName: "Montecristo No. 4",
    expectedKind: "urlset",
  },
  // --- the 2026-09-02 Habanos picture sources (#270, ADR-015) ---------------
  {
    adapter: egmCigars,
    dir: "egm-cigars",
    robotsUrl: "https://egmcigars.com/robots.txt",
    sitemapUrl: "https://egmcigars.com/sitemap.xml",
    childSitemaps: {
      "https://egmcigars.com/sitemap_products_1.xml?from=11256354948&to=9033607840001":
        "sitemap-products-1.xml",
      "https://egmcigars.com/en-gb/sitemap_products_1.xml?from=11256354948&to=9033607840001":
        "sitemap-products-1-en-gb.xml",
    },
    productUrl: "https://egmcigars.com/products/cohiba-siglo-6-slb",
    nonCigarUrl: "https://egmcigars.com/products/halo-onyx-cigar-cutter",
    expectedName: "Cohiba Siglo VI Cigar",
    expectedKind: "sitemapindex",
  },
  {
    adapter: cigarworldDe,
    dir: "cigarworld-de",
    robotsUrl: "https://www.cigarworld.de/robots.txt",
    sitemapUrl: "https://www.cigarworld.de/sitemap.xml",
    childSitemaps: {
      "https://www.cigarworld.de/sitemap_de.xml": "sitemap-de.xml",
      "https://www.cigarworld.de/sitemap_en.xml": "sitemap-en.xml",
    },
    productUrl: "https://www.cigarworld.de/zigarren/kuba/regulares/ramon-allones-specially-selected-01025_3430",
    nonCigarUrl: "https://www.cigarworld.de/zigarren/kuba/regulares/kuba-sortiment-01099_9001",
    expectedName: "Ramon Allones Specially Selected",
    expectedKind: "sitemapindex",
  },
  {
    adapter: jjFox,
    dir: "jj-fox",
    robotsUrl: "https://www.jjfox.co.uk/robots.txt",
    sitemapUrl: "https://www.jjfox.co.uk/sitemap.xml",
    productUrl: "https://www.jjfox.co.uk/partagas-shorts-842.html",
    nonCigarUrl: "https://www.jjfox.co.uk/xikar-xi3-cigar-cutter-901.html",
    expectedName: "Partagas Shorts",
    expectedKind: "urlset",
  },
];

describe("new vendor adapters — representative fixture parse (via runProbe)", () => {
  for (const c of cases) {
    it(`${c.adapter.slug}: robots + sitemap + products parse cleanly and gate to a cigar`, async () => {
      const routes: Record<string, MockRoute> = {
        [c.robotsUrl]: { body: loadFixture("robots.txt", c.dir) },
        [c.sitemapUrl]: { body: loadFixture("sitemap.xml", c.dir) },
        [c.productUrl]: { body: loadFixture(c.productFile ?? "product.html", c.dir) },
        [c.nonCigarUrl]: { body: loadFixture(c.nonCigarFile ?? "product-cutter.html", c.dir) },
      };
      for (const [url, file] of Object.entries(c.childSitemaps ?? {})) {
        routes[url] = { body: loadFixture(file, c.dir) };
      }

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

  it("ships every unprobed adapter crawl_enabled=false until a live probe passes", () => {
    for (const c of cases) {
      expect(c.adapter.crawlEnabled).toBe(false);
    }
    expect(montefortuna.crawlEnabled).toBe(false);
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

  // ADR-015 / ADR-006 amendment 2026-09-02 (#270). These four exist for the one
  // catalogue-photo slot and the enrich drain's fallback order, so the posture
  // that makes them SOURCES rather than shops is the thing to hold still: off the
  // approved list, never a purchase destination, both markets in one catalogue
  // (so their listings assert nothing about a cigar's market), and a distinct
  // tier each, because a tie would leave the fallback order to chance.
  it("gives the four Habanos picture sources a source posture and one tier each", () => {
    const sources = [montefortuna, egmCigars, cigarworldDe, jjFox];

    expect(sources.map((a) => a.tier)).toEqual([2, 3, 4, 5]);
    for (const adapter of sources) {
      expect([adapter.slug, adapter.kind]).toEqual([adapter.slug, "vendor"]);
      expect([adapter.slug, adapter.focus]).toEqual([adapter.slug, "both"]);
      expect([adapter.slug, adapter.approvalStatus]).toEqual([adapter.slug, "unapproved"]);
      expect([adapter.slug, adapter.purchaseLinkout]).toEqual([adapter.slug, false]);
      expect([adapter.slug, adapter.crawlEnabled]).toEqual([adapter.slug, false]);
      // A cap is not optional on any of them: the smallest gate here accepts 913
      // URLs and the largest 6,874, and the fetcher THROWS at the cap.
      expect([adapter.slug, (adapter.maxPages ?? 0) > 0]).toEqual([adapter.slug, true]);
      // None of these vendors asks for a Crawl-delay, so every interval here is
      // our own politeness above the 2.5s floor.
      expect([adapter.slug, (adapter.minIntervalMs ?? 0) >= 3000]).toEqual([adapter.slug, true]);
    }
  });

  it("declares each source's page shape rather than leaving it to be sniffed", () => {
    // Montefortuna: the JSON-LD default end to end. Its `og:image` is sometimes
    // the site logo, so the absence of `photoSource` here is a decision.
    expect(montefortuna.productMarkup).toBe("json-ld");
    expect(montefortuna.categorySource).toBe("breadcrumbs");
    expect(montefortuna.photoSource).toBeUndefined();
    expect(montefortuna.photoUrlRewrite).toBeUndefined();
    // Its trail is `Home / Shop / <marca>` and never says "cigar" — the Small
    // Batch failure of 2026-09-02, avoided by gating on the trail it does have.
    expect(montefortuna.cigarCategoryPattern.test("Home / Shop / Cohiba")).toBe(true);
    expect(montefortuna.excludePattern.test("Home / Shop / Accesories")).toBe(true);
    expect(montefortuna.excludeNamePattern!.test("2 Boxes of 25 Montecristo No. 4")).toBe(true);
    expect(montefortuna.excludeNamePattern!.test("Cohiba Siglo VI")).toBe(false);

    // EGM: a ProductGroup with a `category` string and no breadcrumb, and a photo
    // its JSON-LD does not name.
    expect(egmCigars.categorySource).toBe("json-ld-category");
    expect(egmCigars.photoSource).toBe("og:image");

    // Cigarworld: the JSON-LD `image` is a 300x51 thumbnail of the asset, so the
    // fetch is rewritten rather than re-sourced.
    expect(cigarworldDe.photoUrlRewrite).toEqual({
      pattern: /\/bilder\/detail\/(?!big\/)/,
      replacement: "/bilder/detail/big/",
    });
    expect(cigarworldDe.excludeNamePattern!.test("Kuba Sortiment 6 Zigarren")).toBe(true);
    expect(cigarworldDe.cigarCategoryPattern.test("Shop / Zigarren / Kuba / Regulares")).toBe(true);
    expect(cigarworldDe.excludePattern.test("Shop / Zigarrenzubehör / Humidor")).toBe(true);

    // J.J. Fox: 2 Guys' markup on a Magento store, and a 265px resize query on
    // the photo that the bare path serves full-size.
    expect(jjFox.productMarkup).toBe("opengraph");
    expect(jjFox.categorySource).toBe("keywords-meta");
    expect(jjFox.photoUrlRewrite).toBe("strip-query");
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
