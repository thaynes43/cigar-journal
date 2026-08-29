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
  // --- registry posture ----------------------------------------------------
  // The vendors row this adapter seeds (ADR-006: the registry is admin-managed
  // data, the admin UI lands later, so the seed posture rides the adapter). The
  // CLI's resolveVendor projects these into a fresh row (insert-if-absent — an
  // existing admin-owned row is never overwritten). Encoded here so a new vendor
  // is one adapter object, not a hand-written INSERT.
  //
  // NC vs CC vs both — drives focus and, for CC, the approved-list posture.
  focus: "NC" | "CC" | "both";
  // Has a live robots/ToS read + probe PASSED for this vendor? The dev pod cannot
  // reach these domains, so a new adapter ships false; the coordinator flips it
  // true (or an admin enables the row) once the in-cluster probe verifies robots,
  // sitemap shape, and one product parse. Seeds vendors.crawl_enabled.
  crawlEnabled: boolean;
  // r/cubancigars approval posture (seeds vendors.approval_status). NC vendors the
  // owner buys from are 'owner-added'; a CC vendor off the approved list (Cuban
  // Lou's) is 'unapproved' and labeled wherever shown.
  approvalStatus: "owner-added" | "approved" | "unapproved";
  // Whether this vendor's offers may be displayed at all (seeds display_enabled).
  displayEnabled: boolean;
  // Is this vendor a place to buy? false = offers/photos ingested and shown, but
  // never as a purchase destination — no listing link-out (seeds purchase_linkout,
  // owner ruling 2026-08-29). Cuban Lou's is the sole false today.
  purchaseLinkout: boolean;
  // --- crawl shape ---------------------------------------------------------
  // A URL path whose prefix marks a product listing (Fox: `/shop/`).
  productPathPrefix: string;
  // A breadcrumb path (joined) matching this is a cigar category…
  cigarCategoryPattern: RegExp;
  // …unless it also matches this (accessories, samplers, humidors, etc.).
  excludePattern: RegExp;
  // Name-level exclusion for products whose CATEGORY is cigars but which are
  // not one catalog cigar (sets, kits, mixed cases) — dry-run finding 2026-08-28.
  excludeNamePattern?: RegExp;
  // Per-vendor politeness overrides the CLI passes to the fetcher (the floor still
  // wins — createFetcher clamps to MIN_INTERVAL_FLOOR_MS). Set on large catalogs:
  // Small Batch (~20k URLs) crawls slower and caps pages so a misconfigured run
  // cannot walk the whole store. Absent → the fetcher's polite defaults.
  minIntervalMs?: number;
  maxPages?: number;
}
