import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProcessedPhoto } from "@cj/photos";
import type { Fetcher } from "../core/fetcher.js";

// Test-only helpers: load the recorded Fox fixtures, drive ingest through an
// injected in-memory fetcher (no network — guardrail), and a photo-pipeline stub
// so the harness needs neither sharp nor real image bytes.

export function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../__fixtures__/fox/${name}`, import.meta.url)), "utf8");
}

export interface MockRoute {
  status?: number;
  body?: string;
  binary?: Buffer;
  contentType?: string;
}

export interface MockFetcher extends Fetcher {
  requested: string[];
}

// A Fetcher backed by a fixed url→response map. Every fetchText counts as a page
// (as the real fetcher does), and unmapped URLs answer 404.
export function createMockFetcher(routes: Record<string, MockRoute>): MockFetcher {
  let pages = 0;
  const requested: string[] = [];
  return {
    requested,
    get pagesFetched() {
      return pages;
    },
    async fetchText(url: string) {
      requested.push(url);
      pages += 1;
      const route = routes[url];
      if (!route) return { status: 404, body: "" };
      return { status: route.status ?? 200, body: route.body ?? "" };
    },
    async fetchBinary(url: string) {
      requested.push(url);
      const route = routes[url];
      if (!route) return { status: 404, body: Buffer.alloc(0), contentType: "application/octet-stream" };
      return {
        status: route.status ?? 200,
        body: route.binary ?? Buffer.from("bytes"),
        contentType: route.contentType ?? "image/jpeg",
      };
    },
  };
}

export function urlsetXml(urls: string[]): string {
  const entries = urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

// Deterministic pipeline stub — fixed dims + tiny buffers, no decode. Ignores its
// input (the harness passes throwaway bytes) but keeps the real signature.
export function fakeProcessPhoto(input: Buffer, contentType: string): Promise<ProcessedPhoto> {
  void input;
  void contentType;
  return Promise.resolve({
    full: Buffer.from("full-bytes"),
    thumb: Buffer.from("thumb-bytes"),
    contentType: "image/jpeg",
    width: 800,
    height: 600,
  });
}
