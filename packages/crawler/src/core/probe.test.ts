import { describe, it, expect } from "vitest";
import { runProbe } from "./probe.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import { createMockFetcher, urlsetXml } from "../testing/fixtures.js";
import type { VendorAdapter } from "../adapters/types.js";

// The probe is a pure read (no DB, no storage) — mock the fetcher per the
// guardrail (NEVER live sites) and assert the verdict it prints.

const ROBOTS = "https://www.cubanlous.com/robots.txt";
const SITEMAP = "https://www.cubanlous.com/product-sitemap.xml";
const PRODUCT = "https://www.cubanlous.com/montecristo-cigars/montecristo-no-4/";
const NON_PRODUCT = "https://www.cubanlous.com/about/";

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

describe("runProbe", () => {
  it("passes a well-formed WooCommerce-style vendor (robots + sitemap + one product)", async () => {
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: "User-agent: *\nAllow: /\n" },
      [SITEMAP]: { body: urlsetXml([PRODUCT, NON_PRODUCT]) },
      [PRODUCT]: { body: productHtml("Montecristo No. 4", "18.00") },
    });

    const result = await runProbe(fetcher, cubanLous);
    expect(result.verdict).toBe("ok");
    expect(result.robots.productPathAllowed).toBe(true);
    expect(result.sitemap.kind).toBe("urlset");
    expect(result.sitemap.productLocs).toBe(2); // "/" prefix admits every loc; JSON-LD is the product gate
    expect(result.product?.hasProduct).toBe(true);
    expect(result.product?.name).toBe("Montecristo No. 4");
    expect(result.product?.priceCents).toBe(1800);
    expect(result.product?.isCigar).toBe(true);
    // A pure read: robots + sitemap + exactly one product page = 3 fetches.
    expect(fetcher.pagesFetched).toBe(3);
  });

  it("flags needs-attention when robots disallows the product path", async () => {
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: "User-agent: *\nDisallow: /\n" },
      [SITEMAP]: { body: urlsetXml([PRODUCT]) },
      [PRODUCT]: { body: productHtml("Montecristo No. 4", "18.00") },
    });

    const result = await runProbe(fetcher, cubanLous);
    expect(result.verdict).toBe("needs-attention");
    expect(result.robots.productPathAllowed).toBe(false);
    expect(result.product).toBeNull(); // no product sampled when the path is disallowed
    expect(result.notes.join(" ")).toMatch(/DISALLOWS/);
  });

  it("flags needs-attention when the productPathPrefix matches nothing", async () => {
    // Uses 2 Guys (real "/store/" prefix) — cubanLous now carries "/" which
    // matches every loc by design (its sitemap is product-only).
    const fetcher = createMockFetcher({
      ["https://www.2guyscigars.com/robots.txt"]: { body: "User-agent: *\nAllow: /\n" },
      ["https://www.2guyscigars.com/sitemap.xml"]: { body: urlsetXml(["https://www.2guyscigars.com/blog/monte-4/"]) },
    });

    const result = await runProbe(fetcher, twoGuysCigars);
    expect(result.verdict).toBe("needs-attention");
    expect(result.sitemap.productLocs).toBe(0);
    expect(result.notes.join(" ")).toMatch(/productPathPrefix/);
  });

  it("descends one level into a sitemapindex to sample a product", async () => {
    const CHILD = "https://www.cubanlous.com/product-sitemap-1.xml";
    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${CHILD}</loc></sitemap>
      </sitemapindex>`;
    const adapter: VendorAdapter = { ...cubanLous };
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: "User-agent: *\nAllow: /\n" },
      [SITEMAP]: { body: indexXml },
      [CHILD]: { body: urlsetXml([PRODUCT]) },
      [PRODUCT]: { body: productHtml("Montecristo No. 4", "18.00") },
    });

    const result = await runProbe(fetcher, adapter);
    expect(result.verdict).toBe("ok");
    expect(result.sitemap.kind).toBe("sitemapindex");
    expect(result.sitemap.sampledChild).toBe(CHILD);
    expect(result.product?.name).toBe("Montecristo No. 4");
  });
});
