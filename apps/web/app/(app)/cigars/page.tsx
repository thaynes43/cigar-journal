import type { CatalogSort, CigarType, OwnershipFacet } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { requireAuth } from "@/lib/require-auth";
import { CatalogToolbar } from "../_components/catalog-toolbar";
import { CatalogAllGrid } from "../_components/catalog-all-grid";
import { CatalogShelves } from "../_components/catalog-shelves";
import { BrandPosterTile } from "../_components/brand-poster-tile";
import { LedgerTable } from "../_components/ledger-table";
import { CATALOG_GRID, hasActiveChip, parseView } from "../_components/catalog-registry";

// The unified Catalog surface (DESIGN-003 §IA): `/cigars` IS the cigar grid.
// Landing = root shelves (lenses) above the full, filterable grid of every catalog
// cigar with personal state as badges; `?view=brands` and `?view=ledger` are the
// two other presentations. The default emits no `view` param (legacy `?view=all`
// normalizes to it). All slice state (view, q, type, own, sort) lives in the URL,
// so every surface is shareable, and `/inventory` redirects land on the grid.
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    q?: string;
    type?: string;
    own?: string;
    sort?: string;
    brand?: string;
    instock?: string;
    smoked?: string;
    favorites?: string;
  }>;
}) {
  await requireAuth();
  const params = await searchParams;
  const view = parseView(params.view);
  const q = (typeof params.q === "string" ? params.q : "").trim();
  const type: CigarType | undefined =
    params.type === "NC" || params.type === "CC" ? params.type : undefined;
  const own: OwnershipFacet =
    params.own === "have" || params.own === "want" || params.own === "dont" ? params.own : "all";
  const sort: CatalogSort =
    params.sort === "my-rating" || params.sort === "recently-added" || params.sort === "price"
      ? params.sort
      : "name";

  // The grid filter chips (DESIGN-003 wave 6). `brand` carries an exact value; the
  // rest are presence flags (present=on, absent=off). Parsed here and threaded to
  // both the toolbar (chip UI) and the grid (browse args).
  const brand =
    typeof params.brand === "string" && params.brand.trim() ? params.brand.trim() : undefined;
  const inStock = params.instock !== undefined;
  const smoked = params.smoked !== undefined;
  const favorites = params.favorites !== undefined;

  // Root shelves render only at the true grid root: default view, no active facet
  // (ownership or type), no search, and no active filter chip. The grid is always
  // present at root, so any narrowing collapses the shelves but never empties the
  // page (DESIGN-003 §IA — chips follow the same rule as the rails).
  const atRoot =
    view === "all" &&
    own === "all" &&
    type === undefined &&
    q === "" &&
    !hasActiveChip({ brand, inStock, smoked, favorites });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Catalog</h1>
      <CatalogToolbar
        view={view}
        q={q}
        type={type}
        own={own}
        sort={sort}
        brand={brand}
        inStock={inStock}
        smoked={smoked}
        favorites={favorites}
      />
      {view === "ledger" ? (
        <LedgerView />
      ) : view === "brands" ? (
        <BrandsView q={q} own={own} type={type} />
      ) : (
        <>
          {atRoot ? <CatalogShelves /> : null}
          <CatalogAllGrid
            q={q || undefined}
            type={type}
            own={own}
            sort={sort}
            brand={brand}
            inStock={inStock}
            smoked={smoked}
            favorites={favorites}
          />
        </>
      )}
    </div>
  );
}

// The Brands presentation: every brand as a poster, filtered by name against
// `?q=` and by the ownership + type facets (which compose). An active facet
// re-badges each shelf's counts to the matching subset and drops brands with no
// match (domain browseBrands).
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
    <ul className={CATALOG_GRID}>
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
