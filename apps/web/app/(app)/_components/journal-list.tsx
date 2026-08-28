"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { BandTile } from "./band-tile";
import { RatingSeal } from "./rating-seal";
import { Chips } from "./chips";
import { StrengthMeter } from "./strength-meter";
import { LocalDate } from "./local-date";

const LIST = "mx-auto flex max-w-3xl flex-col gap-4";
const SKELETON_COUNT = 6;

// The journal: the signed-in user's smokes, newest first, keyset-paginated for
// infinite scroll. An IntersectionObserver sentinel (600px rootMargin) fetches
// ahead, with a manual Load more button as the fallback — the same pattern as
// catalog-all-grid.tsx. Dates render viewer-local via <LocalDate>.
export function JournalList() {
  const query = api.smokes.list.useInfiniteQuery(
    {},
    { getNextPageParam: (last) => last.nextCursor },
  );

  const smokes = query.data?.pages.flatMap((page) => page.smokes) ?? [];
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
      <ul className={LIST} aria-hidden>
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <li key={i} className="flex gap-4 rounded-card border border-line bg-surface p-4">
            <div className="aspect-square h-14 animate-pulse rounded-tile bg-raised" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="h-5 w-1/2 animate-pulse rounded-field bg-raised" />
              <div className="h-4 w-3/4 animate-pulse rounded-field bg-raised" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (smokes.length === 0) {
    return (
      <p className="mx-auto max-w-2xl py-16 text-center font-serif text-lg">
        No smokes yet.{" "}
        <Link href="/smokes/new" className="text-accent underline underline-offset-4">
          Record your first.
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ul className={LIST}>
        {smokes.map((smoke) => (
          <li key={smoke.smokeId}>
            <Link
              href={`/smokes/${smoke.smokeId}`}
              className="flex gap-4 rounded-card border border-line bg-surface p-4 transition-colors hover:border-accent/60"
            >
              <BandTile name={smoke.cigar.canonicalName} size="thumb" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-display text-lg leading-snug font-semibold text-ink">
                      {smoke.cigar.canonicalName}
                    </span>
                    <div className="flex items-center gap-2">
                      <LocalDate format="smokedAt" value={smoke.smokedAt} className="label-caps" />
                      {smoke.fromHumidor ? (
                        <span className={ui.chipOutline}>humidor</span>
                      ) : null}
                    </div>
                  </div>
                  <RatingSeal rating={smoke.rating} liked={smoke.liked} size="sm" />
                </div>
                {smoke.summary ? (
                  <p className="line-clamp-2 font-serif text-[0.9375rem] leading-relaxed text-muted">
                    {smoke.summary}
                  </p>
                ) : null}
                <Chips items={smoke.descriptors.slice(0, 4)} />
                {smoke.strength ? (
                  <div className="flex items-center gap-2">
                    <span className="label-caps">Strength</span>
                    <StrengthMeter value={smoke.strength} />
                  </div>
                ) : null}
              </div>
            </Link>
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
