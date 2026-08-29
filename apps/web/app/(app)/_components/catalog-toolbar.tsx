"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CatalogSort, CigarType, OwnershipFacet } from "@cj/domain";
import { ui } from "@/lib/ui";
import { useDebounced } from "@/lib/use-debounced";
import {
  CATALOG_ALL_SORTS,
  CATALOG_OWNERSHIP_FACETS,
  CATALOG_TYPE_FACETS,
  OWNERSHIP_FACET_VIEWS,
  TYPE_FACET_VIEWS,
  type CatalogTypeFacet,
  type CatalogView,
} from "./catalog-registry";

// The catalog toolbar owns all browse state (view, q, type, own, sort), and those
// are the only URL params, so it rebuilds the target URL from its props rather
// than reading the params back. Filter edits (search, type, ownership, sort)
// `router.replace` to stay shareable and back-button quiet; the view switch
// `push`es (PRD-002 conventions). It stays one fixed-height row that pans on
// mobile, the ownership segments joining it (DESIGN-002 §Mobile / PRD-002 R-X-1).
interface ToolbarState {
  view: CatalogView;
  q: string;
  type?: CigarType;
  own: OwnershipFacet;
  sort: CatalogSort;
}

export function CatalogToolbar({ view, q, type, own, sort }: ToolbarState) {
  const router = useRouter();
  const pathname = usePathname();

  // Emit only the params a given view answers, each omitting its default so a
  // shared URL stays minimal: Brands carries `own`; All carries q/type/own/sort;
  // Ledger carries nothing (it is the Have detail, no facets — DESIGN-002 §IA).
  function urlFor(next: ToolbarState): string {
    const params = new URLSearchParams();
    if (next.view === "all") params.set("view", "all");
    if (next.view === "ledger") params.set("view", "ledger");
    if (next.view !== "ledger") {
      if (next.q.trim()) params.set("q", next.q.trim());
      if (next.own !== "all") params.set("own", next.own);
      // Type composes on Brands and All (owner-approved); only sort is All-only.
      if (next.type) params.set("type", next.type);
    }
    if (next.view === "all" && next.sort !== "name") params.set("sort", next.sort);
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  const state: ToolbarState = { view, q, type, own, sort };
  const [text, setText] = useState(q);
  const debounced = useDebounced(text, 250);

  // Push the debounced query into the URL when it settles on something new.
  // Only the debounced value drives this effect; the rest comes from URL props.
  useEffect(() => {
    if (debounced.trim() === q) return;
    router.replace(urlFor({ ...state, q: debounced }));
  }, [debounced]);

  function switchView(next: CatalogView): void {
    if (next === view) return;
    router.push(urlFor({ ...state, view: next, q: text }));
  }

  function selectType(next: CatalogTypeFacet): void {
    const nextType = next === "all" ? undefined : next;
    if (nextType === type) return;
    router.replace(urlFor({ ...state, q: text, type: nextType }));
  }

  function selectOwn(next: OwnershipFacet): void {
    if (next === own) return;
    router.replace(urlFor({ ...state, q: text, own: next }));
  }

  function selectSort(next: CatalogSort): void {
    if (next === sort) return;
    router.replace(urlFor({ ...state, q: text, sort: next }));
  }

  const activeType: CatalogTypeFacet = type ?? "all";
  const showFacets = OWNERSHIP_FACET_VIEWS.includes(view);
  const showTypeFacet = TYPE_FACET_VIEWS.includes(view);

  return (
    <div className="flex snap-x flex-nowrap items-center gap-3 overflow-x-auto sm:flex-wrap sm:overflow-visible">
      {view !== "ledger" ? (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Search the catalog"
          className={`${ui.field} w-40 shrink-0 sm:w-64`}
        />
      ) : null}

      <Segmented
        ariaLabel="Catalog view"
        options={[
          { value: "brands", label: "Brands" },
          { value: "all", label: "All" },
          { value: "ledger", label: "Ledger" },
        ]}
        active={view}
        onSelect={switchView}
      />

      {showFacets ? (
        <Segmented
          ariaLabel="Ownership"
          options={CATALOG_OWNERSHIP_FACETS.map((f) => ({ value: f.value, label: f.label }))}
          active={own}
          onSelect={selectOwn}
        />
      ) : null}

      {showTypeFacet ? (
        <Segmented
          ariaLabel="Type"
          options={CATALOG_TYPE_FACETS.map((f) => ({ value: f.value, label: f.label }))}
          active={activeType}
          onSelect={selectType}
        />
      ) : null}

      {view === "all" ? (
        <Segmented
          ariaLabel="Sort"
          options={CATALOG_ALL_SORTS.map((s) => ({ value: s.value, label: s.label }))}
          active={sort}
          onSelect={selectSort}
        />
      ) : null}
    </div>
  );
}

// The house segmented control (DESIGN-001): aria-pressed segments, label-caps,
// accent fill on the active one. Generic over its value so every facet reuses it.
function Segmented<T extends string>({
  ariaLabel,
  options,
  active,
  onSelect,
}: {
  ariaLabel: string;
  options: readonly { value: T; label: string }[];
  active: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 overflow-hidden rounded-field border border-line"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelect(option.value)}
          aria-pressed={active === option.value}
          className={`label-caps whitespace-nowrap px-3 py-1.5 transition-colors ${
            active === option.value ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
