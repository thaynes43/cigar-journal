import type { CatalogSort, CigarType, OwnershipFacet } from "@cj/domain";

// Level registry (PRD-002 "Design conventions", extended for PRD-003 R-UNI): the
// catalog views declare exactly which facets and sorts they answer, in one typed
// place, so the toolbar and the URL contract never drift from what the domain
// read supports. Type-only imports from @cj/domain keep this client-safe; the
// literals are checked against the domain unions, and the server re-validates
// against the domain CATALOG_SORTS / ownership enums.

export type CatalogView = "brands" | "all" | "ledger";

export type CatalogTypeFacet = CigarType | "all";

export const CATALOG_TYPE_FACETS: readonly { value: CatalogTypeFacet; label: string }[] = [
  { value: "all", label: "Both" },
  { value: "NC", label: "NC" },
  { value: "CC", label: "CC" },
];

// Which views answer the type facet (owner-approved extension to Brands): both
// the brand wall and the All grid filter by type; on Brands it composes with the
// ownership facet and re-badges shelf counts, same mechanics.
export const TYPE_FACET_VIEWS: readonly CatalogView[] = ["brands", "all"];

// The exclusive ownership facet (DESIGN-002 approved strings). `all` carries no
// URL param — like the type facet's default, it is the absence of a filter.
export const CATALOG_OWNERSHIP_FACETS: readonly { value: OwnershipFacet; label: string }[] = [
  { value: "all", label: "All" },
  { value: "have", label: "Have" },
  { value: "want", label: "Want" },
  { value: "dont", label: "Don't have" },
];

// Which views answer the ownership facet (DESIGN-002 §IA: Brands and All; Ledger
// IS the Have detail and takes no facet). Typed as `readonly CatalogView[]` so
// `.includes(view)` accepts any view (a narrow tuple would reject "ledger").
export const OWNERSHIP_FACET_VIEWS: readonly CatalogView[] = ["brands", "all"];

// The All-view sorts, with their labels. `price` WAITS for ADR-009's per-stick
// column — the registry entry is intentionally omitted rather than faked; adding
// it (label + the domain CatalogSort literal) is all the price-surfaces issue
// changes here. The values are checked against the domain CatalogSort union.
export const CATALOG_ALL_SORTS: readonly { value: CatalogSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "my-rating", label: "My rating" },
  { value: "recently-added", label: "Recently added" },
];
