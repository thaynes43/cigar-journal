import type { VendorAdapter } from "./types.js";

// Fox Cigar (foxcigar.com) — a WooCommerce store, the softest of the initial NC
// vendors (ADR-006 / vendor-sources.md). One flat sitemap (~2035 locs), products
// under `/shop/`, each carrying a JSON-LD `@graph` with a BreadcrumbList
// (Home → Shop → category path → product) and a Product node. robots.txt allows
// `*` on `/` (only /wp-admin/ disallowed) and bans named AI-training bots we are
// not one of — verified live from the cluster 2026-08-28.
//
// Category posture: a breadcrumb path is a cigar when it mentions "cigar" and is
// NOT an accessory/sampler/etc. Accessories live under their own "Accessories"
// category; samplers stay excluded on purpose (mixed-blend boxes are not a
// single catalog cigar) — both are counted as skipped-non-cigar.
export const foxCigar: VendorAdapter = {
  slug: "fox-cigar",
  name: "Fox Cigar",
  url: "https://foxcigar.com",
  sitemapUrl: "https://foxcigar.com/sitemap.xml",
  productPathPrefix: "/shop/",
  cigarCategoryPattern: /cigar/i,
  excludePattern: /accessor|ashtray|lighter|cutter|humidor|sampler?/i,
};
