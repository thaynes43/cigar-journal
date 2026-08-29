"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogCigarTile } from "@cj/domain";
import { CigarStillTile } from "./cigar-still-tile";

// One root shelf strip (DESIGN-003 §Shelves): a horizontally-scrolled lens into
// the grid, tiles as normal links in DOM order (not the APG carousel pattern).
// The native scrollbar is hidden; the affordances the UX research requires stand
// in for it — a right-edge fade mask (token gradient, no raw color), hover-
// revealed chevron paddles (real buttons scrolling ~90% of the width, each hidden
// when that side can't scroll and hidden entirely on touch-only via the hover
// media query), and free swipe with proximity snap + contained overscroll. The
// container is a labeled region a keyboard can focus and arrow through; reduced
// motion drops the smooth scroll. The header links `See all` to the equivalent
// grid filter state below.
export function ShelfStrip({
  heading,
  href,
  cigars,
}: {
  heading: string;
  href: string;
  cigars: CatalogCigarTile[];
}) {
  const scroller = useRef<HTMLUListElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  function page(direction: 1 | -1): void {
    const el = scroller.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({
      left: direction * el.clientWidth * 0.9,
      behavior: reduced ? "auto" : "smooth",
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="font-display text-lg font-semibold text-ink">{heading}</h2>
        <span className="label-caps tabular-nums">{cigars.length}</span>
        <Link
          href={href}
          className="label-caps ml-auto shrink-0 transition-colors hover:text-accent"
        >
          See all
        </Link>
      </div>

      <div className="group relative">
        <ul
          ref={scroller}
          role="region"
          aria-label={heading}
          tabIndex={0}
          onScroll={measure}
          className="no-scrollbar flex snap-x snap-proximity gap-4 overflow-x-auto overscroll-x-contain pb-1"
        >
          {cigars.map((cigar) => (
            <li key={cigar.cigarId} className="w-40 shrink-0 snap-start sm:w-44">
              <CigarStillTile
                cigar={cigar}
                imageUrl={
                  cigar.hasProductPhoto ? `/api/product-photos/${cigar.cigarId}/thumb` : undefined
                }
              />
            </li>
          ))}
        </ul>

        {canRight ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-bg"
          />
        ) : null}

        {canLeft ? (
          <Paddle side="left" onClick={() => page(-1)} />
        ) : null}
        {canRight ? (
          <Paddle side="right" onClick={() => page(1)} />
        ) : null}
      </div>
    </section>
  );
}

// A chevron paddle: a real button named for assistive tech, shown only on a
// hover-capable pointer (`@media (hover: hover)`) and revealed on strip hover.
function Paddle({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const isLeft = side === "left";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isLeft ? "Scroll left" : "Scroll right"}
      className={`absolute inset-y-0 z-10 hidden items-center opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:hover)]:flex ${
        isLeft ? "left-0 pl-1" : "right-0 pr-1"
      }`}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink transition-colors hover:border-accent hover:text-accent">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden
        >
          <polyline points={isLeft ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
        </svg>
      </span>
    </button>
  );
}
