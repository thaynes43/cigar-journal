import { describe, it, expect } from "vitest";
import { parseSitemap, collectSitemapUrls } from "./sitemap.js";
import { createMockFetcher, loadFixture } from "../testing/fixtures.js";

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
