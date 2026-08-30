import { describe, it, expect } from "vitest";
import { parseSitemap, collectSitemapUrls, collectSitemapSamples, MAX_SITEMAP_SAMPLES } from "./sitemap.js";
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
    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        ${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}
      </sitemapindex>`;
    const routes: Record<string, { body: string }> = { [ROOT]: { body: indexXml } };
    for (const [i, child] of children.entries()) routes[child] = { body: urlsetXml([`https://vendor.example/store/p${i}/`]) };

    const fetcher = createMockFetcher(routes);
    const sampled = await collectSitemapSamples(fetcher, ROOT, { maxChildren: 2 });

    expect(sampled.samples[0]!.children).toEqual([children[1], children[3]]);
    expect(sampled.urls).toEqual(["https://vendor.example/store/p1/", "https://vendor.example/store/p3/"]);
    // Root + two children only — the other three are never fetched.
    expect(fetcher.pagesFetched).toBe(3);
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
