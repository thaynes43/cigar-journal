"use client";

import { usePathname } from "next/navigation";
import { keepPreviousData } from "@tanstack/react-query";
import { CatalogGroupCard, CatalogUnfiledCard } from "./catalog-group-card";
import { CatalogDrillHeader, type DrillHeaderProps } from "./catalog-drill-header";
import {
  CATALOG_GRID,
  CATALOG_PARENT_DIMENSION,
  UNFILED_SLUG,
  catalogUrl,
  drillInto,
  type CatalogDimension,
  type CatalogState,
  type HierarchyAncestor,
} from "./catalog-registry";
import { api } from "@/lib/trpc/react";

const SKELETON_COUNT = 12;

// A grouped view (DESIGN-004 D-03): the leaf grid is REPLACED, whole-screen, by
// one grid of aggregate group cards. Not section headers over sub-grids, not
// collapsible shelves — the same surface showing different cards, which is what
// makes a drill a plain URL change rather than a different page.
//
// Every card's href is `drillInto`: it adds exactly ONE hierarchy param and
// leaves everything else on the URL alone, so the ancestors, facets, sort and
// search that were already narrowing this screen survive the descent (D-04's
// preserving push). Because these are `<Link>`s, that push is the browser's own —
// Back lands on the group screen, which is the whole point of pushing.
export function CatalogGroupGrid({
  by,
  state,
  header,
}: {
  by: CatalogDimension;
  state: CatalogState;
  header?: Omit<DrillHeaderProps, "count">;
}) {
  const pathname = usePathname();
  const query = api.catalog.groups.useQuery(
    {
      by,
      hierarchy: state.hierarchy,
      q: state.q || undefined,
      type: state.type,
      own: state.own === "all" ? undefined : state.own,
      inStock: state.inStock ? true : undefined,
      smoked: state.smoked ? true : undefined,
      favorited: state.favorites ? true : undefined,
      groupSort: state.groupSort,
    },
    { placeholderData: keepPreviousData },
  );

  // A card's drill carries its own parent when the URL does not already pin one:
  // at the root, `Reserva` means nothing without the marca it belongs to, and two
  // cards would otherwise open the same merged screen.
  const parentDimension = CATALOG_PARENT_DIMENSION[by];
  const href = (slug: string, parentSlug?: string | null): string =>
    catalogUrl(
      pathname,
      drillInto(
        state,
        by,
        slug,
        parentDimension && parentSlug
          ? ({ dimension: parentDimension, slug: parentSlug } satisfies HierarchyAncestor)
          : null,
      ),
    );

  if (query.isLoading) {
    return (
      <ul className={CATALOG_GRID} aria-hidden>
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <li key={i} className="flex flex-col gap-2">
            <div className="aspect-[3/4] animate-pulse rounded-card border border-line bg-surface" />
            <div className="h-4 w-3/4 animate-pulse rounded-field bg-surface" />
          </li>
        ))}
      </ul>
    );
  }

  const groups = query.data?.groups ?? [];
  const unfiled = query.data?.unfiled ?? null;

  if (groups.length === 0 && unfiled === null) {
    return (
      <div className="flex flex-col gap-6">
        {header ? <CatalogDrillHeader {...header} count={0} /> : null}
        <p className="font-serif text-muted">No matches.</p>
      </div>
    );
  }

  // The header's count is the population these cards cover, Unfiled included —
  // the drill's honest total, not the number of cards.
  const total =
    groups.reduce((sum, group) => sum + group.cigarCount, 0) + (unfiled?.cigarCount ?? 0);

  return (
    <div className="flex flex-col gap-6">
      {header ? <CatalogDrillHeader {...header} count={total} /> : null}
      <ul
        className={`${CATALOG_GRID} transition-opacity ${query.isPlaceholderData ? "opacity-55" : ""}`}
      >
        {groups.map((group) => (
          // Keyed by the registry id. `dimension:slug` collided the moment two
          // brands each owned a line called `Reserva` — React reused one card's
          // DOM for the other, so the wall showed one of the two.
          <li key={group.id}>
            <CatalogGroupCard card={group} href={href(group.slug, group.parentSlug)} />
          </li>
        ))}
        {/* Unfiled renders LAST regardless of sort — it is not a peer of the
            named groups, it is the gap they leave. It is absent, not zeroed,
            when nothing is unfiled. */}
        {unfiled ? (
          <li key="unfiled">
            <CatalogUnfiledCard
              count={unfiled.cigarCount}
              inHumidorCount={unfiled.inHumidorCount}
              wantedCount={unfiled.wantedCount}
              href={href(UNFILED_SLUG)}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}
