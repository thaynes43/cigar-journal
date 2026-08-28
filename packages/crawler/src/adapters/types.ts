// A vendor adapter is small, disposable configuration (ADR-006): where the
// sitemap lives, how to recognize a product URL, and which breadcrumb paths are
// cigars vs accessories. The generic core (fetch/sitemap/jsonld/normalize/match/
// ingest) is driven entirely by these fields, so a new vendor is a new adapter
// object plus a registry entry — no core changes.
export interface VendorAdapter {
  // Registry key, used on the CLI (`--vendor <slug>`) and as the adapter id.
  slug: string;
  // The vendors.name this adapter resolves/creates its registry row by.
  name: string;
  url: string;
  sitemapUrl: string;
  // A URL path whose prefix marks a product listing (Fox: `/shop/`).
  productPathPrefix: string;
  // A breadcrumb path (joined) matching this is a cigar category…
  cigarCategoryPattern: RegExp;
  // …unless it also matches this (accessories, samplers, humidors, etc.).
  excludePattern: RegExp;
}
