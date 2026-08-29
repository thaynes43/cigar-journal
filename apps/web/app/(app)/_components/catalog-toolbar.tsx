"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { CatalogSort, OwnershipFacet } from "@cj/domain";
import { filterChip, ui } from "@/lib/ui";
import { useDebounced } from "@/lib/use-debounced";
import {
  CATALOG_ALL_SORTS,
  CATALOG_CHIPS,
  CATALOG_OWNERSHIP_FACETS,
  CATALOG_TYPE_FACETS,
  CATALOG_VIEWS,
  OWNERSHIP_FACET_VIEWS,
  TYPE_FACET_VIEWS,
  catalogUrl,
  type CatalogState,
  type CatalogTypeFacet,
  type CatalogView,
} from "./catalog-registry";
import { BrandChip } from "./catalog-brand-chip";

// The catalog toolbar owns all browse state (view, q, type, own, sort), and those
// are the only URL params, so it rebuilds the target URL from its props (via the
// registry's pure catalogUrl) rather than reading the params back. Filter edits
// (search, type, ownership, sort) `router.replace` to stay shareable and
// back-button quiet; the view switch `push`es (PRD-002 conventions). Rails carry
// leading `label-caps` labels so adjacent segmented groups never read as competing
// filters (DESIGN-003 §IA labeled-rails). It stays one row that pans on mobile.
// After the rails, the grid-only filter chips (Brand popover + In stock / Smoked /
// Favorites toggles) compose with q/own/type/sort and apply the same way — each
// `router.replace`s a URL the registry builds, keeping the URL the state store.

export function CatalogToolbar({ view, q, type, own, sort, brand, inStock, smoked, favorites }: CatalogState) {
  const router = useRouter();
  const pathname = usePathname();

  const urlFor = (next: CatalogState): string => catalogUrl(pathname, next);

  const state: CatalogState = { view, q, type, own, sort, brand, inStock, smoked, favorites };
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

  // The filter chips (grid-only). Each edits its own param and `router.replace`s,
  // composing with the rest of the slice state. Brand carries a value; the rest
  // are presence toggles. `Clear all` drops every chip at once.
  function selectBrand(next?: string): void {
    router.replace(urlFor({ ...state, q: text, brand: next }));
  }

  function toggleInStock(): void {
    router.replace(urlFor({ ...state, q: text, inStock: !inStock }));
  }

  function toggleSmoked(): void {
    router.replace(urlFor({ ...state, q: text, smoked: !smoked }));
  }

  function toggleFavorites(): void {
    router.replace(urlFor({ ...state, q: text, favorites: !favorites }));
  }

  function clearAllChips(): void {
    router.replace(
      urlFor({ ...state, q: text, brand: undefined, inStock: false, smoked: false, favorites: false }),
    );
  }

  const activeType: CatalogTypeFacet = type ?? "all";
  const showFacets = OWNERSHIP_FACET_VIEWS.includes(view);
  const showTypeFacet = TYPE_FACET_VIEWS.includes(view);
  const activeChipCount =
    (brand ? 1 : 0) + (inStock ? 1 : 0) + (smoked ? 1 : 0) + (favorites ? 1 : 0);

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
        options={CATALOG_VIEWS.map((v) => ({ value: v.value, label: v.label }))}
        active={view}
        onSelect={switchView}
      />

      {showFacets ? (
        <Rail label="Own">
          <Segmented
            ariaLabel="Ownership"
            options={CATALOG_OWNERSHIP_FACETS.map((f) => ({ value: f.value, label: f.label }))}
            active={own}
            onSelect={selectOwn}
          />
        </Rail>
      ) : null}

      {showTypeFacet ? (
        <Rail label="Type">
          <Segmented
            ariaLabel="Type"
            options={CATALOG_TYPE_FACETS.map((f) => ({ value: f.value, label: f.label }))}
            active={activeType}
            onSelect={selectType}
          />
        </Rail>
      ) : null}

      {view === "all" ? (
        <Rail label="Sort">
          <Segmented
            ariaLabel="Sort"
            options={CATALOG_ALL_SORTS.map((s) => ({ value: s.value, label: s.label }))}
            active={sort}
            onSelect={selectSort}
          />
        </Rail>
      ) : null}

      {view === "all" ? (
        <div className="flex shrink-0 items-center gap-2">
          <BrandChip value={brand} onSelect={selectBrand} />
          <ToggleChip label={CATALOG_CHIPS.inStock} active={inStock} onToggle={toggleInStock} />
          <ToggleChip label={CATALOG_CHIPS.smoked} active={smoked} onToggle={toggleSmoked} />
          <ToggleChip label={CATALOG_CHIPS.favorites} active={favorites} onToggle={toggleFavorites} />
          {activeChipCount >= 2 ? (
            <button
              type="button"
              onClick={clearAllChips}
              className="label-caps whitespace-nowrap text-muted transition-colors hover:text-ink"
            >
              {CATALOG_CHIPS.clearAll}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// A boolean filter chip (In stock / Smoked / Favorites): a ghost pill when off,
// an accent-tinted pill with a ✕ when on. Clicking toggles it; there is no value,
// so the ✕ is a decorative "clear" signal, not a separate control.
function ToggleChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={`${filterChip.base} ${active ? filterChip.active : filterChip.inactive}`}
    >
      <span>{label}</span>
      {active ? (
        <span aria-hidden className="ml-0.5 text-sm leading-none opacity-70">
          ×
        </span>
      ) : null}
    </button>
  );
}

// A labeled rail: a muted lead label before its segmented group (DESIGN-003
// §IA), so two adjacent groups never read as one competing filter. The view
// group stays unlabeled and first.
function Rail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="label-caps whitespace-nowrap">{label}</span>
      {children}
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
