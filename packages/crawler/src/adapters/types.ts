// A vendor adapter is small, disposable configuration (ADR-006): where the
// sitemap lives, how to recognize a product URL, and which breadcrumb paths are
// cigars vs accessories. The generic core (fetch/sitemap/jsonld/normalize/match/
// ingest) is driven entirely by these fields, so a new vendor is a new adapter
// object plus a registry entry — no core changes.
export interface VendorAdapterBase {
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
  // A breadcrumb path (joined) matching this is a cigar category…
  cigarCategoryPattern: RegExp;
  // …unless it also matches this (accessories, samplers, humidors, etc.).
  excludePattern: RegExp;
  // Name-level exclusion for products whose CATEGORY is cigars but which are
  // not one catalog cigar (sets, kits, mixed cases) — dry-run finding 2026-08-28.
  excludeNamePattern?: RegExp;
  // Opt-in defense against a vendor whose sitemap CONTENT varies between fetches
  // (2 Guys, live 2026-08-29: one request returned 1,462 `/store/` product locs,
  // the next 6,356 locs with none). Absent — the norm — means one fetch, exactly
  // as before. Present, the enumeration is the union of N root fetches.
  sitemapSampling?: SitemapSampling;
  // Per-vendor politeness overrides the CLI passes to the fetcher (the floor still
  // wins — createFetcher clamps to MIN_INTERVAL_FLOOR_MS). Set on large catalogs:
  // Small Batch (~20k URLs) crawls slower and caps pages so a misconfigured run
  // cannot walk the whole store. Absent → the fetcher's polite defaults.
  minIntervalMs?: number;
  maxPages?: number;
}

export interface SitemapSampling {
  // Root fetches to take. Clamped to [1, MAX_SITEMAP_SAMPLES] by the core so a
  // typo cannot turn a probe into a hammer.
  samples: number;
  // Extra delay BETWEEN samples, on top of the fetcher's ≥2.5s global limiter.
  // Unset (the default) relies on the limiter alone — we have no measurement of
  // any vendor's cache TTL, so a specific interval would be invented. Raise it
  // from live per-sample counts if the union still under-enumerates.
  intervalMs?: number;
}

// --- product gate ------------------------------------------------------------
// Two modes, discriminated by `productPathPrefix`: present = Mode A, absent =
// Mode B. `productPathSegments`/`robotsProbePath` stay Mode-B-only via `?: never`,
// so putting one on a prefix adapter fails to typecheck (the error reads
// `Type 'X' is not assignable to type 'undefined'` — that means "you put a
// Mode-B-only field on a Mode-A adapter"). `nonProductPathPattern` is legal in
// BOTH modes: required in Mode B, where it is the whole gate; optional in Mode A,
// where it subtracts a non-product subtree from an otherwise-correct prefix.
// `product-url.test.ts` asserts the same invariants at runtime over the registry.

// Mode A — every product URL shares one path prefix (Fox `/shop/`), or the
// sitemap is already product-only and the prefix is just `/` (Cuban Lou's).
export interface PrefixProductGate {
  productPathPrefix: string;
  // Optional subtraction, applied AFTER the prefix: a path that starts with the
  // prefix but matches this is NOT a product. Exists because a prefix broad
  // enough to be right can also be broad enough to admit a non-catalog subtree —
  // 2 Guys' `/store/` also matches `/store/go/registry/<n>/`, gift-registry pages
  // that carry no Product JSON-LD (live probe 2026-08-30).
  //
  // MUST be anchored at `^` on every top-level branch, and MUST end a reserved
  // word at a full SEGMENT boundary `(?:\/|$)`, never `\b`: `\b` also fires at a
  // hyphen, which is how Small Batch's `^\/cart\b` silently ate
  // `/cart-blanche-robusto/`. No `g`/`y` flags — they make `.test` stateful.
  // Over-matching here drops real products SILENTLY; under-matching only wastes
  // fetches, since normalize + isCigarListing still gate the writes.
  nonProductPathPattern?: RegExp;
  productPathSegments?: never;
  robotsProbePath?: never;
}

// Mode B — products are ROOT-LEVEL slugs with no shared prefix (Small Batch,
// live-probed 2026-08-29), so the gate is negative: reject the known non-product
// paths, then constrain path depth.
export interface ExclusionProductGate {
  productPathPrefix?: never;
  // Matched against URL.pathname (query strings are dropped — a sitemap should
  // not enumerate `?variant=` URLs). MUST be anchored.
  nonProductPathPattern: RegExp;
  // Inclusive bounds on non-empty path segments. Carries most of the load for a
  // root-level catalog: `/blogs/news/x` is out on shape alone.
  productPathSegments?: { min?: number; max?: number };
  // The coarse path the robots gate is asked about; defaults to "/".
  robotsProbePath?: string;
}

// Each adapter file annotates itself with the mode it implements, so a mis-typed
// field errors on the offending line rather than somewhere downstream — and so a
// test can spread one without the union distributing over both modes.
export type PrefixVendorAdapter = VendorAdapterBase & PrefixProductGate;
export type ExclusionVendorAdapter = VendorAdapterBase & ExclusionProductGate;
export type VendorAdapter = PrefixVendorAdapter | ExclusionVendorAdapter;
