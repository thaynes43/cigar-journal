import { describe, it, expect } from "vitest";
import {
  parseSitemap,
  collectSitemapUrls,
  collectSitemapSamples,
  selectIndexChildren,
  MAX_SITEMAP_SAMPLES,
} from "./sitemap.js";
import { MAX_PROBE_CHILDREN } from "./probe.js";
import { createMockFetcher, loadFixture, urlsetXml } from "../testing/fixtures.js";

describe("parseSitemap", () => {
  it("parses a flat urlset", () => {
    const parsed = parseSitemap(loadFixture("sitemap.xml"));
    expect(parsed.kind).toBe("urlset");
    expect(parsed.locs).toContain("https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo/");
    expect(parsed.locs).toHaveLength(6);
  });

  it("recognizes a sitemapindex and returns child sitemap locs", () => {
    const parsed = parseSitemap(loadFixture("sitemap-index.xml"));
    expect(parsed.kind).toBe("sitemapindex");
    expect(parsed.locs).toEqual([
      "https://foxcigar.com/sitemap-products-1.xml",
      "https://foxcigar.com/sitemap-products-2.xml",
    ]);
  });
});

describe("collectSitemapUrls", () => {
  it("returns the flat urlset locs directly", async () => {
    const fetcher = createMockFetcher({
      "https://foxcigar.com/sitemap.xml": { body: loadFixture("sitemap.xml") },
    });
    const urls = await collectSitemapUrls(fetcher, "https://foxcigar.com/sitemap.xml");
    expect(urls).toHaveLength(6);
  });

  it("recurses a sitemapindex into its child sitemaps", async () => {
    const fetcher = createMockFetcher({
      "https://foxcigar.com/sitemap-index.xml": { body: loadFixture("sitemap-index.xml") },
      "https://foxcigar.com/sitemap-products-1.xml": { body: loadFixture("sitemap-products-1.xml") },
      "https://foxcigar.com/sitemap-products-2.xml": { body: loadFixture("sitemap-products-2.xml") },
    });
    const urls = await collectSitemapUrls(fetcher, "https://foxcigar.com/sitemap-index.xml");
    expect(urls).toEqual([
      "https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo/",
      "https://foxcigar.com/shop/xikar-hp3-lighter/",
      "https://foxcigar.com/shop/oliva-serie-v-melanio-torpedo/",
    ]);
    // One index fetch + two child fetches.
    expect(fetcher.pagesFetched).toBe(3);
  });
});

function indexXmlFor(children: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      ${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}
    </sitemapindex>`;
}

describe("selectIndexChildren", () => {
  const numbered = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `https://vendor.example/sitemap-${i}.xml`);

  it("returns every child when the index is no bigger than the bound", () => {
    expect(selectIndexChildren(numbered(3), 3)).toEqual(numbered(3));
    expect(selectIndexChildren([], 3)).toEqual([]);
    expect(selectIndexChildren(numbered(3), 0)).toEqual([]);
  });

  // The false negative this replaces: a positional midpoint pick over 8 children
  // is [1, 4, 6] — products in child 0 or child 7 are invisible to the probe.
  it("reaches both ends of an index the midpoint pick could not", () => {
    const locs = numbered(8);
    const picked = selectIndexChildren(locs, 3);
    expect(picked).toHaveLength(3);
    expect(picked).toContain(locs[0]);
    expect(picked).toContain(locs[7]);
  });

  // A stock Yoast/Woo index: the catalog is in `product-sitemap.xml` at an
  // arbitrary position, which no positional rule can be relied on to hit.
  it("prefers a name-matched product child over its position", () => {
    const locs = [
      "https://vendor.example/post-sitemap.xml",
      "https://vendor.example/page-sitemap.xml",
      "https://vendor.example/product-sitemap.xml",
      "https://vendor.example/category-sitemap.xml",
      "https://vendor.example/product_cat-sitemap.xml",
      "https://vendor.example/product_tag-sitemap.xml",
      "https://vendor.example/author-sitemap.xml",
    ];
    // The catalog child, plus both ends of the index. In document order.
    expect(selectIndexChildren(locs, 3)).toEqual([
      "https://vendor.example/post-sitemap.xml",
      "https://vendor.example/product-sitemap.xml",
      "https://vendor.example/author-sitemap.xml",
    ]);
  });

  // Woo/Yoast ships product_cat/product_tag/product_brand next to the catalog and
  // all of them match the product hint. Letting them share one rank with the
  // catalog child lets three taxonomies fill a 3-child budget and skip it — worse
  // than the plain midpoint pick, which reached it here.
  it("picks the catalog child over the taxonomy children that share its prefix", () => {
    const locs = [
      "https://vendor.example/product_cat-sitemap.xml",
      "https://vendor.example/product-sitemap.xml", // the catalog
      "https://vendor.example/product_tag-sitemap.xml",
      "https://vendor.example/product_brand-sitemap.xml",
      "https://vendor.example/post-sitemap.xml",
      "https://vendor.example/page-sitemap.xml",
    ];
    expect(selectIndexChildren(locs, 3)).toContain("https://vendor.example/product-sitemap.xml");
  });

  // The endpoint guarantee has to survive the hint spending part of the budget:
  // with two taxonomy matches taking two of three slots, a single leftover slot
  // used to go to the head of the remainder and the last child went unfetched.
  it("keeps both ends reachable when the hint matches only some children", () => {
    const locs = [
      "https://vendor.example/post-sitemap.xml",
      "https://vendor.example/page-sitemap.xml",
      "https://vendor.example/product_cat-sitemap.xml",
      "https://vendor.example/product_tag-sitemap.xml",
      "https://vendor.example/author-sitemap.xml",
      "https://vendor.example/tag-sitemap.xml",
      "https://vendor.example/news-sitemap.xml",
      "https://vendor.example/inventory-sitemap.xml", // the catalog, unhinted
    ];
    const picked = selectIndexChildren(locs, 3);
    expect(picked).toContain(locs[0]);
    expect(picked).toContain(locs[7]);
  });

  // The guarantee stated on selectIndexChildren, pinned where it is made rather
  // than on edgeSpreadIndices alone: whatever the names do, a budget of 3 always
  // spends two slots on the ends.
  it("always samples both ends of the index at a budget of three", () => {
    const shapes = [
      numbered(8),
      [...numbered(7), "https://vendor.example/product-sitemap.xml"],
      ["https://vendor.example/shop-sitemap.xml", ...numbered(9)],
      ["https://vendor.example/shop-sitemap.xml", "https://vendor.example/store-sitemap.xml", ...numbered(6)],
    ];
    for (const locs of shapes) {
      const unique = [...new Set(locs)];
      const picked = selectIndexChildren(locs, 3);
      expect(picked).toContain(unique[0]);
      expect(picked).toContain(unique[unique.length - 1]);
      expect(picked).toHaveLength(3);
    }
  });

  // `catalog` contains "cat" and `shop.example.com` contains "shop": the hints
  // read the file name and respect word boundaries, or every child of a vendor on
  // a shop.* host is a product hit.
  it("matches on the file name and does not read catalog as a taxonomy", () => {
    const locs = [
      "https://shop.vendor.example/post-sitemap.xml",
      ...Array.from({ length: 5 }, (_, i) => `https://shop.vendor.example/page-${i}-sitemap.xml`),
      "https://shop.vendor.example/catalog-sitemap.xml",
      "https://shop.vendor.example/author-sitemap.xml",
    ];
    expect(selectIndexChildren(locs, 3)).toContain("https://shop.vendor.example/catalog-sitemap.xml");
  });

  it("fills the remaining slots from the rest when too few children are name-matched", () => {
    const locs = [...numbered(6), "https://vendor.example/store-sitemap.xml"];
    const picked = selectIndexChildren(locs, 3);
    expect(picked).toContain("https://vendor.example/store-sitemap.xml");
    expect(picked).toContain(locs[0]);
    expect(picked).toHaveLength(3);
  });

  // The Montefortuna shape, and the reason the probe's budget is 5 (#270): a Woo
  // index of ten whose catalog is split across three `product-sitemap*.xml`
  // children, with three product_* TERM archives beside them. At a budget of 3
  // the catalog got one slot and the probe counted 1,001 of 2,087 locs; at
  // MAX_PROBE_CHILDREN the cap is `want - 2` = 3, so all three come first and
  // the two ends still fit.
  it("takes all three catalog children of a Woo index before the ends", () => {
    const locs = [
      "post-sitemap.xml",
      "page-sitemap.xml",
      "product-sitemap.xml",
      "product-sitemap2.xml",
      "product-sitemap3.xml",
      "category-sitemap.xml",
      "post_tag-sitemap.xml",
      "product_brand-sitemap.xml",
      "product_cat-sitemap.xml",
      "product_tag-sitemap.xml",
    ].map((n) => `https://vendor.example/${n}`);

    const picked = selectIndexChildren(locs, MAX_PROBE_CHILDREN);

    expect(picked).toHaveLength(MAX_PROBE_CHILDREN);
    expect(picked).toEqual([
      "https://vendor.example/post-sitemap.xml", // first child
      "https://vendor.example/product-sitemap.xml",
      "https://vendor.example/product-sitemap2.xml",
      "https://vendor.example/product-sitemap3.xml",
      "https://vendor.example/product_tag-sitemap.xml", // last child
    ]);
    // The term archives that share the `product` hint are still demoted: they
    // spend no slot while a catalog-shaped child is unpicked.
    expect(picked).not.toContain("https://vendor.example/product_cat-sitemap.xml");
    expect(picked).not.toContain("https://vendor.example/product_brand-sitemap.xml");
  });

  it("dedupes a repeated child loc rather than spending a slot twice", () => {
    const locs = [...numbered(8), "https://vendor.example/sitemap-0.xml"];
    const picked = selectIndexChildren(locs, 3);
    expect(new Set(picked).size).toBe(picked.length);
    expect(picked).toHaveLength(3);
  });
});

describe("collectSitemapSamples", () => {
  const ROOT = "https://vendor.example/sitemap.xml";
  const A = "https://vendor.example/store/a/";
  const B = "https://vendor.example/store/b/";
  const C = "https://vendor.example/store/c/";
  const D = "https://vendor.example/store/d/";

  it("with samples=1 returns exactly what collectSitemapUrls returns", async () => {
    const routes = { "https://foxcigar.com/sitemap.xml": { body: loadFixture("sitemap.xml") } };
    const plain = await collectSitemapUrls(createMockFetcher(routes), "https://foxcigar.com/sitemap.xml");
    const sampled = await collectSitemapSamples(createMockFetcher(routes), "https://foxcigar.com/sitemap.xml");
    expect(sampled.urls).toEqual(plain);
    expect(sampled.varied).toBe(false);
    expect(sampled.samples).toHaveLength(1);
  });

  // The 2 Guys shape (live 2026-08-29): the same URL serves different content per
  // request, so the union is the only enumeration that sees the whole catalog.
  it("unions varying samples in first-seen order and records what each contributed", async () => {
    const fetcher = createMockFetcher({
      [ROOT]: {
        sequence: [
          { body: urlsetXml([A, B, C]) },
          { body: urlsetXml([]) },
          { body: urlsetXml([A, B, D]) },
        ],
      },
    });
    const sampled = await collectSitemapSamples(fetcher, ROOT, { samples: 3 });

    expect(sampled.urls).toEqual([A, B, C, D]);
    expect(sampled.varied).toBe(true);
    expect(sampled.samples.map((s) => s.enumerated)).toEqual([3, 0, 3]);
    expect(sampled.samples.map((s) => s.newUrls)).toEqual([3, 0, 1]);
    expect(sampled.samples[2]!.attempt).toBe(3);
  });

  it("reports no variance when every sample is empty", async () => {
    const fetcher = createMockFetcher({ [ROOT]: { body: urlsetXml([]) } });
    const sampled = await collectSitemapSamples(fetcher, ROOT, { samples: 3 });
    expect(sampled.urls).toEqual([]);
    expect(sampled.varied).toBe(false);
    expect(sampled.samples.every((s) => s.enumerated === 0)).toBe(true);
  });

  it("keeps a good sample's urls when another sample's root fetch fails", async () => {
    const fetcher = createMockFetcher({
      [ROOT]: { sequence: [{ status: 503 }, { body: urlsetXml([A, B]) }] },
    });
    const sampled = await collectSitemapSamples(fetcher, ROOT, { samples: 2 });
    expect(sampled.urls).toEqual([A, B]);
    expect(sampled.samples[0]).toMatchObject({ status: 503, kind: null, enumerated: 0, rootLocs: 0 });
    expect(sampled.samples[1]!.status).toBe(200);
    // A 503 enumerates nothing; that is a failed fetch, not a vendor that serves
    // different content per request. Scoring it as variance would write a
    // permanent varied=true into crawl_runs.stats for a one-off flake.
    expect(sampled.varied).toBe(false);
  });

  it("reports variance between two SUCCESSFUL samples that differ", async () => {
    const fetcher = createMockFetcher({
      [ROOT]: { sequence: [{ status: 503 }, { body: urlsetXml([A, B]) }, { body: urlsetXml([A]) }] },
    });
    const sampled = await collectSitemapSamples(fetcher, ROOT, { samples: 3 });
    expect(sampled.varied).toBe(true);
  });

  // A response that drops one loc and duplicates another has the same length and
  // the same MEMBERSHIP as the original — set comparison calls the pair identical
  // and reports a varying vendor as stable.
  it("counts a duplicate-padded subset as variance, not as the same enumeration", async () => {
    const fetcher = createMockFetcher({
      [ROOT]: { sequence: [{ body: urlsetXml([A, B]) }, { body: urlsetXml([A, A]) }] },
    });
    const sampled = await collectSitemapSamples(fetcher, ROOT, { samples: 2 });
    expect(sampled.urls).toEqual([A, B]);
    expect(sampled.varied).toBe(true);
  });

  it("sleeps between samples only — never before the first or after the last", async () => {
    const slept: number[] = [];
    const fetcher = createMockFetcher({ [ROOT]: { body: urlsetXml([A]) } });
    await collectSitemapSamples(fetcher, ROOT, {
      samples: 3,
      intervalMs: 900,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([900, 900]);
  });

  it("descends a spread of children when maxChildren bounds the walk", async () => {
    const children = [1, 2, 3, 4, 5].map((n) => `https://vendor.example/sitemap-${n}.xml`);
    const indexXml = indexXmlFor(children);
    const routes: Record<string, { body: string }> = { [ROOT]: { body: indexXml } };
    for (const [i, child] of children.entries()) routes[child] = { body: urlsetXml([`https://vendor.example/store/p${i}/`]) };

    const fetcher = createMockFetcher(routes);
    const sampled = await collectSitemapSamples(fetcher, ROOT, { maxChildren: 2 });

    // Endpoint-inclusive: the first and last child, not two interior ones.
    expect(sampled.samples[0]!.children).toEqual([children[0], children[4]]);
    expect(sampled.urls).toEqual(["https://vendor.example/store/p0/", "https://vendor.example/store/p4/"]);
    // Root + two children only — the other three are never fetched.
    expect(fetcher.pagesFetched).toBe(3);
  });

  // A child that 403s enumerates zero URLs, exactly like an empty one. The
  // bounded walk records which children failed so the probe can say so.
  it("records a bounded child's non-200 status instead of silently skipping it", async () => {
    const children = [1, 2].map((n) => `https://vendor.example/sitemap-${n}.xml`);
    const fetcher = createMockFetcher({
      [ROOT]: { body: indexXmlFor(children) },
      [children[0]!]: { status: 403, body: "" },
      [children[1]!]: { body: urlsetXml([A]) },
    });
    const sampled = await collectSitemapSamples(fetcher, ROOT, { maxChildren: 3 });

    expect(sampled.urls).toEqual([A]);
    expect(sampled.samples[0]!.childFailures).toEqual([{ url: children[0], status: 403 }]);
  });

  it("walks every child when maxChildren is unset (the ingest path)", async () => {
    const fetcher = createMockFetcher({
      "https://foxcigar.com/sitemap-index.xml": { body: loadFixture("sitemap-index.xml") },
      "https://foxcigar.com/sitemap-products-1.xml": { body: loadFixture("sitemap-products-1.xml") },
      "https://foxcigar.com/sitemap-products-2.xml": { body: loadFixture("sitemap-products-2.xml") },
    });
    const sampled = await collectSitemapSamples(fetcher, "https://foxcigar.com/sitemap-index.xml");
    expect(sampled.urls).toHaveLength(3);
    expect(sampled.samples[0]!.kind).toBe("sitemapindex");
    expect(sampled.samples[0]!.rootLocs).toBe(2);
    expect(fetcher.pagesFetched).toBe(3);
  });

  it("clamps the sample count to MAX_SITEMAP_SAMPLES", async () => {
    const fetcher = createMockFetcher({ [ROOT]: { body: urlsetXml([A]) } });
    const sampled = await collectSitemapSamples(fetcher, ROOT, { samples: 99 });
    expect(sampled.samples).toHaveLength(MAX_SITEMAP_SAMPLES);
    expect(fetcher.pagesFetched).toBe(MAX_SITEMAP_SAMPLES);
  });
});
