import type { CatalogSort, CigarType, OwnershipFacet } from "@cj/domain";

// Level registry (PRD-002 "Design conventions", extended for PRD-003 R-UNI /
// DESIGN-003): the catalog surface declares exactly which facets and sorts it
// answers, and how the URL contract maps to them, in one typed place, so the
// toolbar, the page, and the tests never drift from what the domain read
// supports. Type-only imports from @cj/domain keep this client-safe; the literals
// are checked against the domain unions, and the server re-validates against the
// domain CATALOG_SORTS / ownership enums.

// The unified grid is the default surface (DESIGN-003 §IA): `/cigars` IS the
// grid; `brands` and `ledger` are presentations reached by an explicit `view`
// param. The `all` value is the grid — kept as the internal name of the default
// presentation, but it carries NO URL param (the default emits nothing).
export type CatalogView = "all" | "brands" | "ledger";

// The view segments, in display order — All (default) · Brands · Ledger.
export const CATALOG_VIEWS: readonly { value: CatalogView; label: string }[] = [
  { value: "all", label: "All" },
  { value: "brands", label: "Brands" },
  { value: "ledger", label: "Ledger" },
];

// Normalize the `view` URL param to a CatalogView (DESIGN-003 URL contract). The
// unified grid is the default: a missing param, the legacy `?view=all`, and any
// unknown value all resolve to it. Only `brands` and `ledger` are explicit.
export function parseView(param: string | undefined): CatalogView {
  return param === "brands" ? "brands" : param === "ledger" ? "ledger" : "all";
}

// The shared fluid catalog grid (DESIGN-003 §Tile grid-mechanics): fill columns
// with ~160px tiles so they multiply rather than inflate (`auto-fill`, never
// `auto-fit`), with a fixed 3-col floor ≤480px so minmax never overflows a phone.
// Every catalog grid — the cigar grid, its skeleton, the brand wall, and the
// brand-page line/loose grids — imports this ONE string so their geometry agrees.
export const CATALOG_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4 max-[480px]:grid-cols-3";

export type CatalogTypeFacet = CigarType | "all";

export const CATALOG_TYPE_FACETS: readonly { value: CatalogTypeFacet; label: string }[] = [
  { value: "all", label: "Both" },
  { value: "NC", label: "NC" },
  { value: "CC", label: "CC" },
];

// Which views answer the type facet (owner-approved extension to Brands): both
// the cigar grid and the brand wall filter by type; on Brands it composes with
// the ownership facet and re-badges shelf counts, same mechanics.
export const TYPE_FACET_VIEWS: readonly CatalogView[] = ["all", "brands"];

// The exclusive ownership facet (DESIGN-002 approved strings). `all` carries no
// URL param — like the type facet's default, it is the absence of a filter.
export const CATALOG_OWNERSHIP_FACETS: readonly { value: OwnershipFacet; label: string }[] = [
  { value: "all", label: "All" },
  { value: "have", label: "Have" },
  { value: "want", label: "Want" },
  { value: "dont", label: "Don't have" },
];

// Which views answer the ownership facet (DESIGN-003 §IA: the grid and the brand
// wall; Ledger IS the Have detail and takes no facet). Typed as
// `readonly CatalogView[]` so `.includes(view)` accepts any view.
export const OWNERSHIP_FACET_VIEWS: readonly CatalogView[] = ["all", "brands"];

// The grid sorts, with their labels (DESIGN-003 §Sort row). `price` is un-deferred:
// the domain path is complete and tested (unpriced rows group after priced under
// the explicit break, R-UNI-3), so the registry row + the param parse are all the
// web needs. The values are checked against the domain CatalogSort union.
export const CATALOG_ALL_SORTS: readonly { value: CatalogSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "my-rating", label: "My rating" },
  { value: "recently-added", label: "Recently added" },
  { value: "price", label: "Price" },
];

// The filter chips (DESIGN-003 §IA), grid-only. `Brand` carries an exact brand
// value; `In stock` / `Smoked` / `Favorites` are boolean presence flags. Each maps
// to an independent, composable domain overlay filter that ANDs with the `own`
// rail. The chip strings are fixed by the design (`Clear all` is the one addition,
// flagged — it is not in the DESIGN-003 strings table).
export const CATALOG_CHIPS = {
  brand: "Brand",
  inStock: "In stock",
  smoked: "Smoked",
  favorites: "Favorites",
  clearAll: "Clear all",
} as const;

// The full browse slice state the toolbar owns and the URL stores. `brand` /
// `inStock` / `smoked` / `favorites` are the grid-only filter chips (DESIGN-003
// wave 6); every non-grid presentation drops them (see catalogUrl).
export interface CatalogState {
  view: CatalogView;
  q: string;
  type?: CigarType;
  own: OwnershipFacet;
  sort: CatalogSort;
  brand?: string;
  inStock: boolean;
  smoked: boolean;
  favorites: boolean;
}

// True when any grid filter chip is active — the same "non-root" signal the rails
// carry (an active chip collapses the shelves; the grid persists). Pure, so both
// the page's `atRoot` test and the toolbar's `Clear all` gate read it identically.
export function hasActiveChip(state: Pick<CatalogState, "brand" | "inStock" | "smoked" | "favorites">): boolean {
  return Boolean(state.brand) || state.inStock || state.smoked || state.favorites;
}

// Build the target URL for a slice state, emitting only the params a given view
// answers and omitting each default so a shared URL stays minimal (DESIGN-003 URL
// contract): the grid (default) emits no `view` and carries q/type/own/sort plus
// the filter chips (brand/instock/smoked/favorites); Brands carries `view=brands`
// + q/type/own (drops sort and chips); Ledger carries only `view=ledger` (it is
// the Have detail, no facets — DESIGN-002 §IA). Pure, so the contract is
// unit-tested directly. Legacy URLs are unaffected — a chip param that is off
// emits nothing, so pre-wave URLs round-trip unchanged.
export function catalogUrl(pathname: string, next: CatalogState): string {
  const params = new URLSearchParams();
  if (next.view === "brands") params.set("view", "brands");
  if (next.view === "ledger") params.set("view", "ledger");
  if (next.view !== "ledger") {
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.own !== "all") params.set("own", next.own);
    // Type composes on the grid and Brands (owner-approved); sort is grid-only.
    if (next.type) params.set("type", next.type);
  }
  if (next.view === "all") {
    if (next.sort !== "name") params.set("sort", next.sort);
    // Filter chips are grid-only. `brand` carries its exact value; the booleans
    // are presence flags (present=on, absent=off) — the "1" is a placeholder, the
    // parse only tests presence.
    if (next.brand?.trim()) params.set("brand", next.brand.trim());
    if (next.inStock) params.set("instock", "1");
    if (next.smoked) params.set("smoked", "1");
    if (next.favorites) params.set("favorites", "1");
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
