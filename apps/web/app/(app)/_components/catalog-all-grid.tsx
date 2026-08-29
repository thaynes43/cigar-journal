"use client";

import { Fragment, useEffect, useRef } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import type { CatalogCigarTile, CatalogSort, CigarType, OwnershipFacet } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { CATALOG_GRID } from "./catalog-registry";
import { CigarStillTile } from "./cigar-still-tile";

const SKELETON_COUNT = 12;

// A tile carries a per-stick figure only when its best offer derives one; a
// package-only offer (or no offer) does not, and those rows are exactly the
// price-sort null tail the domain groups last (best_pps_cents NULLS LAST). So the
// first tile without a per-stick figure marks the `No current offer` break.
const hasPerStick = (c: CatalogCigarTile): boolean => c.price != null && c.price.perStick;

// The unified cigar grid (DESIGN-003 §IA): server-paginated still tiles with
// infinite scroll. An IntersectionObserver sentinel (600px rootMargin) fetches
// ahead, with a manual Load more button as the fallback. Filter changes keep the
// prior page visible and dimmed while the new one loads (keepPreviousData); the
// first load shows a skeleton grid holding the exact geometry. State
// (q/type/own/sort) is owned by the URL and passed in as props. `own: "all"` is
// normalized to undefined so it carries no filter. The result count and, under
// price sort, the unpriced break render from the same payload.
export function CatalogAllGrid({
  q,
  type,
  own,
  sort,
}: {
  q?: string;
  type?: CigarType;
  own?: OwnershipFacet;
  sort?: CatalogSort;
}) {
  const query = api.catalog.browse.useInfiniteQuery(
    { q, type, own: own === "all" ? undefined : own, sort },
    {
      getNextPageParam: (last) => last.nextCursor,
      placeholderData: keepPreviousData,
    },
  );

  const cigars = query.data?.pages.flatMap((page) => page.cigars) ?? [];
  const totalCount = query.data?.pages[0]?.totalCount ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  // Under price sort, the domain groups unpriced (no per-stick figure) rows after
  // priced ones; surface that break in the grid (R-UNI-3). The break falls at the
  // first tile lacking a per-stick figure, but only when priced tiles precede it.
  const breakIndex = sort === "price" ? cigars.findIndex((c) => !hasPerStick(c)) : -1;
  const showBreak = breakIndex > 0;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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

  if (cigars.length === 0) {
    return <p className="font-serif text-muted">No matches.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="label-caps tabular-nums">{totalCount} cigars</p>
      <ul
        className={`${CATALOG_GRID} transition-opacity ${query.isPlaceholderData ? "opacity-55" : ""}`}
      >
        {cigars.map((cigar, i) => (
          <Fragment key={cigar.cigarId}>
            {showBreak && i === breakIndex ? (
              <li className="col-span-full pt-2">
                <span className="label-caps">No current offer</span>
              </li>
            ) : null}
            <li>
              <CigarStillTile
                cigar={cigar}
                imageUrl={
                  cigar.hasProductPhoto ? `/api/product-photos/${cigar.cigarId}/thumb` : undefined
                }
              />
            </li>
          </Fragment>
        ))}
      </ul>
      {hasNextPage ? (
        <div className="relative flex justify-center">
          <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 -top-px h-px" />
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className={ui.button}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
