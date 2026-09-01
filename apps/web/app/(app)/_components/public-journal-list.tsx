"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { BandTile } from "./band-tile";
import { RatingSeal } from "./rating-seal";
import { Chips } from "./chips";
import { LocalDate } from "./local-date";

const LIST = "mx-auto flex max-w-3xl flex-col gap-4";
const SKELETON_COUNT = 6;

// The public journal index (issue #96): a public journal's smokes, newest first,
// keyset-paginated for infinite scroll — the JournalList idiom, minus the
// personal-inventory signals (the humidor tag and the strength meter) and minus
// the owner-only empty-state prompt. Each card still links to the smoke's public
// detail. An empty result renders nothing (the no-blurbs rule is absolute).
//
// The heading is the page's only <h1> — the wordmark is chrome on every route —
// and lives here rather than in the page so it appears only with entries: a
// public journal that exists but has no visible smokes still renders nothing
// (issue 96 honest degradation, issue 219). The string matches the signed-in
// root's.
export function PublicJournalList() {
  const query = api.smokes.listPublic.useInfiniteQuery(
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

  if (smokes.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="mx-auto w-full max-w-3xl font-display text-2xl font-semibold text-ink">
        Journal
      </h1>
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
                    <LocalDate format="smokedAt" value={smoke.smokedAt} className="label-caps" />
                  </div>
                  <RatingSeal rating={smoke.rating} liked={smoke.liked} size="sm" />
                </div>
                {smoke.summary ? (
                  <p className="line-clamp-2 font-serif text-[0.9375rem] leading-relaxed text-muted">
                    {smoke.summary}
                  </p>
                ) : null}
                <Chips items={smoke.descriptors.slice(0, 4)} />
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
