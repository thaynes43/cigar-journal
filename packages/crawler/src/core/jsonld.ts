// JSON-LD extraction for product pages (ADR-006: no vendor exposes a structured
// API, so we parse the schema.org Product embedded in `<script
// type="application/ld+json">`). Each block is parsed independently and a broken
// block is tolerated — one malformed script never sinks the page. `@graph` is
// flattened so the Product and BreadcrumbList nodes surface regardless of nesting.

export interface JsonLdPriceSpecification {
  price?: string | number;
  priceCurrency?: string;
}

export interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
  url?: string;
  priceSpecification?: JsonLdPriceSpecification | JsonLdPriceSpecification[];
}

export interface JsonLdImageObject {
  url?: string;
}

export interface JsonLdProduct {
  "@type"?: string | string[];
  name?: string;
  url?: string;
  description?: string;
  image?: string | string[] | JsonLdImageObject | JsonLdImageObject[];
  sku?: string;
  offers?: JsonLdOffer | JsonLdOffer[];
  [key: string]: unknown;
}

export interface ExtractedJsonLd {
  product: JsonLdProduct | null;
  breadcrumbs: string[];
}

const SCRIPT_RE =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function typeIncludes(node: Record<string, unknown>, wanted: string): boolean {
  const type = node["@type"];
  if (typeof type === "string") return type === wanted;
  if (Array.isArray(type)) return type.some((t) => t === wanted);
  return false;
}

// Collect every object node, descending through arrays and `@graph`.
function flatten(parsed: unknown, into: Record<string, unknown>[]): void {
  if (Array.isArray(parsed)) {
    for (const item of parsed) flatten(item, into);
    return;
  }
  if (parsed && typeof parsed === "object") {
    const node = parsed as Record<string, unknown>;
    if (Array.isArray(node["@graph"])) flatten(node["@graph"], into);
    into.push(node);
  }
}

function breadcrumbNames(node: Record<string, unknown>): string[] {
  const items = node.itemListElement;
  if (!Array.isArray(items)) return [];
  return items
    .map((raw) => {
      if (!raw || typeof raw !== "object") return { position: 0, name: null as string | null };
      const item = raw as Record<string, unknown>;
      const position = typeof item.position === "number" ? item.position : 0;
      let name = typeof item.name === "string" ? item.name : null;
      if (!name && item.item && typeof item.item === "object") {
        const inner = item.item as Record<string, unknown>;
        if (typeof inner.name === "string") name = inner.name;
      }
      return { position, name };
    })
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

export function extractJsonLd(html: string): ExtractedJsonLd {
  const nodes: Record<string, unknown>[] = [];
  for (const match of html.matchAll(SCRIPT_RE)) {
    const rawBlock = match[1]!.trim();
    if (!rawBlock) continue;
    try {
      flatten(JSON.parse(rawBlock) as unknown, nodes);
    } catch {
      // A single malformed ld+json block is skipped; other blocks still parse.
    }
  }

  const product = (nodes.find((n) => typeIncludes(n, "Product")) as JsonLdProduct | undefined) ?? null;
  const crumbNode = nodes.find((n) => typeIncludes(n, "BreadcrumbList"));
  const breadcrumbs = crumbNode ? breadcrumbNames(crumbNode) : [];

  return { product, breadcrumbs };
}
