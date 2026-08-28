import type { CatalogSort, CigarType } from "@cj/domain";

// Level registry (PRD-002 "Design conventions"): the All view declares exactly
// which facets and sorts it answers, in one typed place, so the toolbar and the
// URL contract never drift from what the domain read supports. Type-only imports
// from @cj/domain keep this client-safe; the sort literals are checked against
// the domain's CatalogSort union, and the server re-validates against the
// domain CATALOG_SORTS registry.

export type CatalogTypeFacet = CigarType | "all";

export const CATALOG_TYPE_FACETS: readonly { value: CatalogTypeFacet; label: string }[] = [
  { value: "all", label: "Both" },
  { value: "NC", label: "NC" },
  { value: "CC", label: "CC" },
];

export const CATALOG_ALL_SORTS = ["name"] as const satisfies readonly CatalogSort[];
