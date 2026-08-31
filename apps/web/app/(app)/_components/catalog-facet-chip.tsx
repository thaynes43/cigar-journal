"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { keepPreviousData } from "@tanstack/react-query";
import type { CigarType, OwnershipFacet } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { filterChip } from "@/lib/ui";
import { chipPopoverStyle } from "@/lib/chip-popover";
import {
  CATALOG_DIMENSION_META,
  UNFILED_SLUG,
  type CatalogDimension,
  type CatalogHierarchy,
} from "./catalog-registry";

// The hierarchy filter chip (DESIGN-004 D-06) — one component for all four of
// Brand / Line / Blend / Vitola, because a chip and a drill are ONE mechanism
// with two entrances: both write the same single URL param at the same level.
// It replaces the DESIGN-003 `BrandChip`, whose unscoped `catalog.brands` feed
// could only ever answer the top level.
//
// Three properties the design pins, in the order they matter:
//   1. Options are SCOPED by the levels already set — the Line chip under
//      `brand=drew-estate` offers only Drew Estate's lines.
//   2. Counts are computed against the OTHER active facets, so the number
//      answers "what would I get if I picked this" rather than restating the
//      current result. `catalog.facetOptions` drops this dimension's own value
//      from the filter set to get that.
//   3. A facet with no options at the current scope HIDES. With this catalog's
//      sparsity an explain-yourself chip row would dominate the toolbar, so the
//      books-wall rule is taken and the hnet *arr "render it dead with a
//      message" rule is deliberately not.
//
// Multi-select is deliberately not offered: one value per level is what keeps
// the chip and the drill the same state and the drill header honest.

// The filter scope the options are counted against — everything the toolbar
// knows, so the chip never has to read the URL back for itself.
export interface FacetScope {
  hierarchy: CatalogHierarchy;
  q?: string;
  type?: CigarType;
  own: OwnershipFacet;
  inStock: boolean;
  smoked: boolean;
  favorites: boolean;
}

export function CatalogFacetChip({
  dimension,
  value,
  scope,
  onSelect,
}: {
  dimension: CatalogDimension;
  value?: string;
  scope: FacetScope;
  onSelect: (slug?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const label = CATALOG_DIMENSION_META[dimension].chip;
  const active = Boolean(value);

  // Eager, not lazy: the empty-facet HIDE rule is a property of the option list,
  // so the row cannot decide what to render without it. `keepPreviousData` is
  // what keeps that honest without jank — a refetch after a neighbouring filter
  // edit holds the current options (and therefore the chip) in place instead of
  // blinking the whole row out and back, which is the reflow ADR-015 forbids.
  // Every chip in the row issues its own query; httpBatchLink coalesces them
  // into one request.
  const optionsQuery = api.catalog.facetOptions.useQuery(
    {
      dimension,
      hierarchy: scope.hierarchy,
      q: scope.q,
      type: scope.type,
      own: scope.own === "all" ? undefined : scope.own,
      inStock: scope.inStock ? true : undefined,
      smoked: scope.smoked ? true : undefined,
      favorited: scope.favorites ? true : undefined,
    },
    { placeholderData: keepPreviousData },
  );

  // Position on open and arm dismissal, but only on the NEXT frame: deferring
  // past the opening click means the browser's own "scroll the clicked chip into
  // view" (the toolbar pans horizontally on a phone) neither fires the
  // scroll-dismiss on itself nor is measured before it settles. The panel renders
  // only once `style` is set, so it never flashes at the origin.
  useEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const close = () => setOpen(false);
    const place = () => {
      const pill = rootRef.current;
      if (!pill) return;
      setStyle(
        chipPopoverStyle(pill.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || rootRef.current?.contains(target)) return;
      close();
    };
    // A fixed panel detaches from its anchor the moment anything scrolls, so an
    // outside scroll closes it. Scrolling INSIDE the panel's own overflow must
    // not.
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    };
    const raf = requestAnimationFrame(() => {
      place();
      document.addEventListener("keydown", onKey);
      document.addEventListener("mousedown", onPointer);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", close);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const options = optionsQuery.data?.options ?? [];

  // The empty-facet hide. An ACTIVE chip always survives it: the options read
  // excludes this dimension's own filter, so a live value is normally in the
  // list, and on the edge where it is not (a slug that matches nothing) the chip
  // must still render — it is the only control that can clear it.
  if (options.length === 0 && !active) return null;

  // Resolve the pill's display text. The slug is the URL's business; the pill
  // shows the name, falling back to the raw slug only when nothing resolves it.
  const selected = options.find((option) => option.slug === value);
  const shown =
    value === UNFILED_SLUG ? "Unfiled" : (selected?.name ?? value);

  return (
    <>
      {/* The pill is a WRAPPER holding two sibling buttons, not one button with a
          clear control nested inside it (port: FilterChip.tsx:160-196). Nesting
          them — which the DESIGN-003 BrandChip did — is invalid interactive
          content, and it also folds the clear button's label into the trigger's
          accessible name, so the trigger announces as "Vitola · Toro Clear Vitola
          filter" and no assistive tech can address either control cleanly. */}
      <span
        ref={rootRef}
        className={`${filterChip.base} ${active ? filterChip.active : filterChip.inactive}`}
      >
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 rounded-chip focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none"
        >
          <span className="truncate">{active ? `${label} · ${shown}` : label}</span>
          <span aria-hidden className="text-[0.5rem] leading-none opacity-60">
            ▾
          </span>
        </button>
        {/* The ✕ renders ONLY while the facet has a value. That is what lets the
            chip stay in the row permanently — an always-present clear button on
            an empty chip is the thing that makes a chip bar reflow. */}
        {active ? (
          <button
            type="button"
            aria-label={`Clear ${label} filter`}
            onClick={() => onSelect(undefined)}
            className="ml-0.5 rounded-chip text-sm leading-none opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none"
          >
            ×
          </button>
        ) : null}
      </span>
      {open && style
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              aria-label={`Filter by ${label.toLowerCase()}`}
              style={style}
              className="z-50 w-80 overflow-y-auto rounded-card border border-line bg-surface p-1.5 shadow-lg"
            >
              {options.map((option) => {
                const isSelected = option.slug === value;
                return (
                  <button
                    key={option.slug}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onSelect(isSelected ? undefined : option.slug);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 rounded-field px-3 py-1.5 text-left text-sm transition-colors hover:bg-raised ${
                      isSelected ? "text-accent" : "text-ink"
                    }`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{option.name}</span>
                      {option.parentName ? (
                        <span className="truncate text-xs text-muted">{option.parentName}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 tabular-nums text-xs text-muted">{option.count}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
