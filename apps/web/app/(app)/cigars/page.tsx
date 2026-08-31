import { redirect } from "next/navigation";
import { getServerCaller } from "@/lib/trpc/server";
import { requireAuth } from "@/lib/require-auth";
import { CatalogToolbar } from "../_components/catalog-toolbar";
import { CatalogAllGrid } from "../_components/catalog-all-grid";
import { CatalogGroupGrid } from "../_components/catalog-group-grid";
import { CatalogShelves } from "../_components/catalog-shelves";
import { LedgerTable } from "../_components/ledger-table";
import type { DrillHeaderProps } from "../_components/catalog-drill-header";
import {
  CATALOG_DIMENSION_META,
  CATALOG_GROUP_STRINGS,
  UNFILED_SLUG,
  catalogUrl,
  drillOut,
  hasActiveChip,
  isGrouped,
  legacyViewDimension,
  resolveCatalogState,
  type CatalogSearchParams,
  type CatalogState,
} from "../_components/catalog-registry";

// The unified Catalog surface. `/cigars` is the ONE catalog surface (DESIGN-004
// D-01) and hierarchy state is URL state: `?by=` chooses a grouped view,
// `?brand=/?line=/?blend=/?vitola=` scope it, and everything else — search, the
// rails, sort, the chips — composes with them by construction, because they are
// all just params on the same URL. So every screen is shareable and Back/Forward
// safe, and a drill needs no route of its own.

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<CatalogSearchParams>;
}) {
  await requireAuth();
  const params = await searchParams;

  // The legacy `?view=brands` presentation is the `?by=brand` grouped view now
  // (D-02). Canonicalized here, server-side, so it costs no history entry and
  // never flashes the old shape; every other param on the link survives.
  const legacy = legacyViewDimension(params.view);
  if (legacy) {
    const { state } = resolveCatalogState({ ...params, view: undefined, by: legacy });
    redirect(catalogUrl("/cigars", state));
  }

  // URL wins per-dimension → stored preference → default (D-09). The stored tier
  // is empty in v1; passing it explicitly is what lets preferences land later
  // without touching this call site.
  const { state } = resolveCatalogState(params);

  // Root shelves render only at the true grid root: the flat view, no hierarchy
  // scope, no active facet, no search, no chip. The grid is always present at
  // root, so narrowing collapses the shelves but never empties the page.
  const atRoot =
    state.view === "grid" &&
    state.by === undefined &&
    state.own === "all" &&
    state.type === undefined &&
    state.q === "" &&
    !hasActiveChip(state);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Catalog</h1>
      <CatalogToolbar state={state} />
      {state.view === "ledger" ? (
        <LedgerView />
      ) : (
        <>
          {atRoot ? <CatalogShelves /> : null}
          <CatalogBody state={state} />
        </>
      )}
    </div>
  );
}

// The grid surface: group cards when a grouping is active, leaf tiles otherwise —
// one surface swapping its cards, never two pages (D-03).
async function CatalogBody({ state }: { state: CatalogState }) {
  const header = await drillHeader(state);
  return isGrouped(state) ? (
    <CatalogGroupGrid by={state.by!} state={state} header={header} />
  ) : (
    <CatalogAllGrid state={state} header={header} />
  );
}

// The drill header's labels (D-04). Resolved server-side, and deliberately NOT
// through the facet reads: `resolveHierarchy` looks each pinned slug up directly,
// so a facet that narrows the drill to nothing still leaves the header able to
// say which entity you are inside. A slug that resolves to no row falls back to
// the slug itself rather than inventing a name.
async function drillHeader(state: CatalogState): Promise<Omit<DrillHeaderProps, "count"> | undefined> {
  const out = drillOut(state);
  if (out === null) return undefined;

  const caller = await getServerCaller();
  const resolved = await caller.catalog.resolveHierarchy({ hierarchy: state.hierarchy });
  const nameOf = (dimension: keyof typeof CATALOG_DIMENSION_META): string => {
    const slug = state.hierarchy[dimension];
    if (slug === UNFILED_SLUG) return CATALOG_GROUP_STRINGS.unfiled;
    return resolved[dimension]?.name ?? slug ?? "";
  };

  return {
    backHref: catalogUrl("/cigars", out.state),
    // Back to the parent entity by name when one still frames the screen, else
    // to the whole group screen you came from.
    backLabel: out.parent ? nameOf(out.parent) : CATALOG_DIMENSION_META[out.dimension].back,
    title: nameOf(out.dimension),
  };
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
