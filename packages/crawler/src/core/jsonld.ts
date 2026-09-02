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
  // The vendor's own taxonomy string, where it publishes one — a path
  // ("Cigars > Cuban") or a single term ("Cigars", EGM). Read only by adapters
  // declaring `categorySource: "json-ld-category"`.
  category?: string | string[];
  offers?: JsonLdOffer | JsonLdOffer[];
  // A ProductGroup's variants (Shopify). See PRODUCT_TYPES below.
  hasVariant?: JsonLdProduct | JsonLdProduct[];
  [key: string]: unknown;
}

export interface ExtractedJsonLd {
  product: JsonLdProduct | null;
  breadcrumbs: string[];
}

const SCRIPT_RE =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// A `ProductGroup` IS a product page (ADR-006 amendment 2026-09-02, #270).
// Shopify emits one — name, brand, image, `category` and `hasVariant` on the
// group node — where other platforms emit `Product`, and EGM Cigars serves
// nothing else on any of the four pages the 2026-09-02 probe read. Refusing it
// meant reading a healthy catalogue as "no schema.org Product JSON-LD".
const PRODUCT_TYPES = ["Product", "ProductGroup"];

function typeIncludes(node: Record<string, unknown>, wanted: string): boolean {
  const type = node["@type"];
  if (typeof type === "string") return type === wanted;
  if (Array.isArray(type)) return type.some((t) => t === wanted);
  return false;
}

function isProductNode(node: Record<string, unknown>): boolean {
  return PRODUCT_TYPES.some((type) => typeIncludes(node, type));
}

function firstVariantOffers(node: JsonLdProduct): JsonLdOffer | JsonLdOffer[] | undefined {
  const variants = node.hasVariant;
  const first = Array.isArray(variants) ? variants[0] : variants;
  return first?.offers;
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

// The image URL a product node names — first of an array, `url` off an
// ImageObject. Exported because `normalizeListing` (the listing's `imageUrl`) and
// `extractProductMarkup` (the URL the photo is fetched from) must read the field
// the same way; two readers of one field is how they would come to disagree.
export function productImageUrl(image: JsonLdProduct["image"]): string | null {
  const first = Array.isArray(image) ? image[0] : image;
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof first.url === "string") return first.url;
  return null;
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

  const found = (nodes.find(isProductNode) as JsonLdProduct | undefined) ?? null;
  // A ProductGroup carries the page's name/brand/image/category and keeps the
  // priced offer one level down, on the variants. Lifting the FIRST variant's
  // offers onto the group is what lets one Product shape reach `normalizeListing`
  // — and it is a lift, not an override: a group that states its own offers keeps
  // them, and `hasVariant` stays on the node, so the offer's raw payload still
  // holds everything the page published.
  const product =
    found && found.offers === undefined && firstVariantOffers(found) !== undefined
      ? { ...found, offers: firstVariantOffers(found) }
      : found;
  const crumbNode = nodes.find((n) => typeIncludes(n, "BreadcrumbList"));
  const breadcrumbs = crumbNode ? breadcrumbNames(crumbNode) : [];

  return { product, breadcrumbs };
}
