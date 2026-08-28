"use client";

import { useEffect, useRef } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import type { CigarType } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { CigarStillTile } from "./cigar-still-tile";

const GRID = "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4";
const SKELETON_COUNT = 8;

// The All view: server-paginated still tiles with infinite scroll. An
// IntersectionObserver sentinel (600px rootMargin) fetches ahead, with a manual
// Load more button as the fallback. Filter changes keep the prior page visible
// and dimmed while the new one loads (keepPreviousData); the first load shows a
// skeleton grid. State (q/type) is owned by the URL and passed in as props.
export function CatalogAllGrid({ q, type }: { q?: string; type?: CigarType }) {
  const query = api.catalog.browse.useInfiniteQuery(
    { q, type },
    {
      getNextPageParam: (last) => last.nextCursor,
      placeholderData: keepPreviousData,
    },
  );

  const cigars = query.data?.pages.flatMap((page) => page.cigars) ?? [];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

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
      <ul className={GRID} aria-hidden>
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <li key={i} className="flex flex-col gap-2">
            <div className="aspect-video animate-pulse rounded-card border border-line bg-surface" />
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
      <ul className={`${GRID} transition-opacity ${query.isPlaceholderData ? "opacity-55" : ""}`}>
        {cigars.map((cigar) => (
          <li key={cigar.cigarId}>
            <CigarStillTile
              cigar={cigar}
              imageUrl={cigar.hasProductPhoto ? `/api/product-photos/${cigar.cigarId}/thumb` : undefined}
            />
          </li>
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
