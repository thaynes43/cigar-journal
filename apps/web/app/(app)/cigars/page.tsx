import type { CatalogSort, CigarType, OwnershipFacet } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { requireAuth } from "@/lib/require-auth";
import { CatalogToolbar } from "../_components/catalog-toolbar";
import { CatalogAllGrid } from "../_components/catalog-all-grid";
import { CatalogShelves } from "../_components/catalog-shelves";
import { BrandPosterTile } from "../_components/brand-poster-tile";
import { LedgerTable } from "../_components/ledger-table";
import type { CatalogView } from "../_components/catalog-registry";

// The unified Catalog surface (PRD-003 R-UNI): one nav entry, three views —
// Brands (default) · All · Ledger — with the ownership facet (?own=) overlaying
// Brands and All, and the humidor Ledger folded in as a view (DESIGN-002 §IA).
// All slice state (view, q, type, own, sort) lives in the URL, so every view is
// shareable, and `/inventory` redirects here (next.config).
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    q?: string;
    type?: string;
    own?: string;
    sort?: string;
  }>;
}) {
  await requireAuth();
  const params = await searchParams;
  const view: CatalogView =
    params.view === "all" ? "all" : params.view === "ledger" ? "ledger" : "brands";
  const q = (typeof params.q === "string" ? params.q : "").trim();
  const type: CigarType | undefined =
    params.type === "NC" || params.type === "CC" ? params.type : undefined;
  const own: OwnershipFacet =
    params.own === "have" || params.own === "want" || params.own === "dont" ? params.own : "all";
  const sort: CatalogSort =
    params.sort === "my-rating" || params.sort === "recently-added" ? params.sort : "name";

  // The root shelves belong to the true brand-wall root: default view, no active
  // facet (ownership or type), no search. Any narrowing swaps them out for the
  // filtered result.
  const atRoot = view === "brands" && own === "all" && type === undefined && q === "";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Catalog</h1>
      <CatalogToolbar view={view} q={q} type={type} own={own} sort={sort} />
      {view === "ledger" ? (
        <LedgerView />
      ) : view === "all" ? (
        <CatalogAllGrid q={q || undefined} type={type} own={own} sort={sort} />
      ) : (
        <>
          {atRoot ? <CatalogShelves /> : null}
          <BrandsView q={q} own={own} type={type} />
        </>
      )}
    </div>
  );
}

// The default view: every brand as a 2:3 poster, filtered by name against `?q=`
// and by the ownership + type facets (which compose). An active facet re-badges
// each shelf's counts to the matching subset and drops brands with no match
// (domain browseBrands).
async function BrandsView({
  q,
  own,
  type,
}: {
  q: string;
  own: OwnershipFacet;
  type?: CigarType;
}) {
  const caller = await getServerCaller();
  const { brands } = await caller.catalog.brands({ own, type });
  const needle = q.toLowerCase();
  const shown = needle
    ? brands.filter((shelf) => (shelf.brand ?? "").toLowerCase().includes(needle))
    : brands;

  if (shown.length === 0) {
    return <p className="font-serif text-muted">No matches.</p>;
  }

  return (
    <ul className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5">
      {shown.map((shelf) => (
        <li key={shelf.slug ?? " unbranded"}>
          <BrandPosterTile
            shelf={shelf}
            imageUrl={
              shelf.coverCigarId ? `/api/product-photos/${shelf.coverCigarId}/thumb` : undefined
            }
          />
        </li>
      ))}
    </ul>
  );
}

// The Ledger view: the caller's purchase lots (DESIGN-002 §IA). Absent-when-empty
// per the honest-degradation rule — no table skeleton over an empty humidor.
async function LedgerView() {
  const caller = await getServerCaller();
  const { holdings } = await caller.inventory.list();
  if (holdings.length === 0) {
    return <p className="font-serif text-muted">No inventory yet.</p>;
  }
  return <LedgerTable holdings={holdings} />;
}
