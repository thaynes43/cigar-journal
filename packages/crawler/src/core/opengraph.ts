// OpenGraph + schema.org microdata extraction, the second structured source
// (ADR-006 amendment 2026-09-02, issue #252). Some vendors serve no
// `application/ld+json` at all — 2 Guys Cigars serves none on any of the 18 pages
// the 2026-09-01 in-cluster read fetched — but publish the same product facts as
// `og:*`/`product:*` meta tags plus a `schema.org/Product` itemscope. This reads
// those tags into the SAME `JsonLdProduct` shape `normalizeListing` consumes, so
// nothing downstream knows which extractor ran.
//
// Which extractor a vendor gets is DECLARED on its adapter (`productMarkup`),
// never sniffed from the page: a vendor whose markup silently changes then fails
// loudly at the probe instead of quietly parsing the other format.
//
// Pure string work — no DOM, matching the deliberately regex-shaped `jsonld.ts`.

import type { JsonLdProduct } from "./jsonld.js";
import { decodeEntities } from "./normalize.js";

// The synthesized node. `brand` is schema.org's own `Brand`, so what lands in the
// offer's `raw` payload is a well-formed Product rather than a bag of og keys.
export interface OpenGraphProduct extends JsonLdProduct {
  brand?: { "@type": "Brand"; name: string };
}

const META_RE = /<meta\b[^>]*>/gi;
const LINK_RE = /<link\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// `itemtype="https://schema.org/Product"` as served, and the scheme-less and
// http:// spellings the same platform emits elsewhere.
const PRODUCT_ITEMTYPE_RE = /\bitemtype\s*=\s*["'](?:https?:)?(?:\/\/)?(?:www\.)?schema\.org\/Product["']/i;
// The microdata name fallback: `<h1 itemprop="name">…</h1>` (any element).
const ITEMPROP_NAME_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bitemprop\s*=\s*["']name["'][^>]*>([\s\S]*?)<\/\1>/i;
// A NitroSell defect, live 2026-09-01: `og:image` is the store origin with an
// ALREADY-ABSOLUTE CDN URL concatenated onto it
// (`https://www.2guyscigars.comhttps://cdn.powered-by-nitrosell.com/…`), which no
// fetcher can resolve. Anchored so it only fires on origin-then-scheme with no
// separator between — an image-proxy URL carrying `?u=https://…` is untouched.
const DOUBLED_ORIGIN_RE = /^https?:\/\/[^/?#]+(https?:\/\/[^\s]+)$/i;

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(ATTR_RE)) {
    attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

// First `<meta>` whose `property` or `name` is `key` (OG uses `property`, the
// keywords/description tags use `name`), decoded. Empty content reads as absent.
//
// Exported since 2026-09-03 (#199 slice 2a): the halfwheel reviewer adapter reads
// `og:title`/`og:description`/`author` off a WordPress post, which is the same
// question this already answers for a product page. One meta reader, so one
// attribute parser and one entity-decoding rule serve both.
export function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(META_RE) ?? []) {
    const attrs = attributes(tag);
    const id = attrs.property ?? attrs.name;
    if (id?.toLowerCase() !== key) continue;
    const value = decodeEntities(attrs.content ?? "").trim();
    if (value) return value;
  }
  return null;
}

function canonicalUrl(html: string): string | null {
  for (const tag of html.match(LINK_RE) ?? []) {
    const attrs = attributes(tag);
    if (attrs.rel?.toLowerCase() !== "canonical") continue;
    const href = decodeEntities(attrs.href ?? "").trim();
    if (href) return href;
  }
  return null;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function repairImageUrl(url: string): string {
  return DOUBLED_ORIGIN_RE.exec(url)?.[1] ?? url;
}

// `og:availability` is bare ("instock"/"outofstock") where schema.org offers carry
// a URL. Mapped to the schema.org term so ONE availability vocabulary reaches
// `normalizeListing`; an unrecognized token is passed through, and normalize
// leaves stock null rather than guessing.
function availability(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const token = raw.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (token === "instock") return "https://schema.org/InStock";
  if (token === "outofstock" || token === "soldout") return "https://schema.org/OutOfStock";
  return raw;
}

// The vendor's own taxonomy tags: `<meta name="keywords">`, split on commas and
// trimmed. NOT a breadcrumb trail — every token is taxonomy, so nothing is
// dropped (ADR-006 amendment 2026-09-02). A page with no keywords tag yields an
// empty list, which the cigar gate then refuses; that refusal is the ruling.
export function extractKeywords(html: string): string[] {
  const raw = metaContent(html, "keywords");
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

// THE PAGE'S OG IMAGE, preferring `og:image:secure_url` (ADR-006 amendment
// 2026-09-02). The two name the same asset and differ only in scheme — EGM
// publishes `http://egmcigars.com/cdn/shop/files/....jpg` in `og:image` and the
// https spelling in `og:image:secure_url` — so taking the secure one costs
// nothing and avoids a plaintext fetch of a 2000x2000 image. `og:image` remains
// the answer for every vendor that emits only it (2 Guys serves no secure_url).
export function extractOgImage(html: string): string | null {
  const url = metaContent(html, "og:image:secure_url") ?? metaContent(html, "og:image");
  return url === null ? null : repairImageUrl(url);
}

// A product exists when the page DECLARES one — `og:type=product` or a
// `schema.org/Product` itemscope — and names it. A category landing page and a
// 404 declare neither, so both yield null and the caller writes nothing.
export function extractOpenGraphProduct(html: string): OpenGraphProduct | null {
  const isProduct =
    metaContent(html, "og:type")?.toLowerCase() === "product" || PRODUCT_ITEMTYPE_RE.test(html);
  if (!isProduct) return null;

  // og:title first, the microdata `itemprop="name"` as the fallback: the two agree
  // on every page sampled, and a vendor serving only the itemscope still parses.
  const name = metaContent(html, "og:title") ?? stripTags(ITEMPROP_NAME_RE.exec(html)?.[2] ?? "");
  if (!name) return null;

  const price = metaContent(html, "product:price:amount");
  const currency = metaContent(html, "product:price:currency");
  const stock = availability(metaContent(html, "og:availability"));
  const image = extractOgImage(html);
  const brand = metaContent(html, "og:brand");
  const url = canonicalUrl(html) ?? metaContent(html, "og:url");
  const description = metaContent(html, "og:description") ?? metaContent(html, "description");
  // The platform's product code, repeated as `og:upc` — the sku the offer keys on.
  const sku = metaContent(html, "og:upc");

  return {
    "@type": "Product",
    name,
    ...(url ? { url } : {}),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(sku ? { sku } : {}),
    ...(brand ? { brand: { "@type": "Brand" as const, name: brand } } : {}),
    // One offer, shaped like the JSON-LD offers normalize already reads. Price and
    // currency stay absent when the page states neither — never zero.
    offers: [
      {
        ...(price ? { price } : {}),
        ...(currency ? { priceCurrency: currency } : {}),
        ...(stock ? { availability: stock } : {}),
      },
    ],
  };
}
