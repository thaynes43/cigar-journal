"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CatalogSort, OwnershipFacet } from "@cj/domain";
import { filterChip, ui } from "@/lib/ui";
import { useDebounced } from "@/lib/use-debounced";
import {
  CATALOG_CHIPS,
  CATALOG_DIMENSION_META,
  CATALOG_OWNERSHIP_FACETS,
  CATALOG_TYPE_FACETS,
  GROUP_SORTS,
  catalogUrl,
  chipsFor,
  cleanSwitchWithin,
  clearVisibleChips,
  groupingsFor,
  isGrouped,
  segmentOf,
  visibleChipCount,
  CATALOG_LEVELS,
  levelOf,
  type CatalogSegment,
  type CatalogSortToken,
  type CatalogState,
  type CatalogTypeFacet,
  type GroupSortField,
  type HierarchyAncestor,
} from "./catalog-registry";
import { CatalogFacetChip, type FacetScope } from "./catalog-facet-chip";
import { CatalogSortRow } from "./catalog-sort-row";

// The catalog toolbar owns all browse state, and the URL is the only store, so it
// rebuilds the target URL from its props (via the registry's pure `catalogUrl`)
// rather than reading params back.
//
// THREE history behaviours, and they are the whole navigation model (DESIGN-004
// D-04):
//   • seg switch (a dimension or the ledger) — a CLEAN PUSH. Facets, sort and
//     search drop; the new shape starts fresh. The hierarchy scope SURVIVES,
//     because a drilled screen's seg only offers that level's groupings —
//     switching Lines→Blends inside Drew Estate must stay inside Drew Estate.
//   • drill in / out — a PRESERVING PUSH, and it is not here: it is the group
//     card's and the drill header's `<Link>`, so the browser does the push.
//   • every refinement (search, rails, sort, chips) — REPLACE with scroll:false,
//     so Back/Forward cross screens rather than replaying each keystroke.
//
// What renders comes from the registry's per-level table, never from a local
// copy of it: the seg offers `groupingsFor`, the sort row offers the level's
// declared sorts, and the chip row offers `chipsFor` — which already subtracts
// any dimension the drill has pinned, because the drill IS that filter.

export function CatalogToolbar({ state }: { state: CatalogState }) {
  const router = useRouter();
  const pathname = usePathname();

  const [text, setText] = useState(state.q);
  const debounced = useDebounced(text, 250);

  // The last `q` this component put on the URL. It is what separates "the URL
  // changed because of my own keystrokes" from "the URL changed under me" —
  // Back/Forward, a drill link, a seg switch — which is the only way the input
  // can be resynced without also fighting the debounce that is still in flight.
  const pushedQ = useRef(state.q);

  const urlFor = (next: CatalogState): string => catalogUrl(pathname, next);
  const refine = (next: CatalogState): void => {
    pushedQ.current = next.q.trim();
    router.replace(urlFor(next), { scroll: false });
  };

  // Push the debounced query into the URL when it settles on something new.
  // Only the debounced value drives this effect; the rest comes from URL props.
  useEffect(() => {
    if (debounced.trim() === state.q) return;
    refine({ ...state, q: debounced });
  }, [debounced]);

  // Adopt an externally-driven `q`. The box is local state seeded once at mount,
  // so without this Back restored the URL and left the stale text sitting in the
  // input — and because every refinement sends `q: text`, the next chip tap wrote
  // that stale text straight back into the URL and resurrected a search the user
  // had already navigated away from.
  //
  // The guard is the whole trick: when `state.q` is what we ourselves last
  // pushed, the round trip is complete and there is nothing to adopt, so an
  // in-flight debounce is never clobbered by the URL it just produced.
  useEffect(() => {
    if (state.q === pushedQ.current) return;
    pushedQ.current = state.q;
    setText(state.q);
  }, [state.q]);

  const grouped = isGrouped(state);
  const level = levelOf(state.hierarchy);
  const segment = segmentOf(state);
  const activeType: CatalogTypeFacet = state.type ?? "all";
  const chipDimensions = chipsFor(state.hierarchy);

  // The seg: All, then only the groupings this level answers, then Ledger.
  const segments: { value: CatalogSegment; label: string }[] = [
    { value: "all", label: "All" },
    ...groupingsFor(state.hierarchy).map((d) => ({
      value: d as CatalogSegment,
      label: CATALOG_DIMENSION_META[d].plural,
    })),
    { value: "ledger", label: "Ledger" },
  ];

  // A seg switch is the CLEAN push, and the search box is part of what it clears.
  // The push drops `q` from the URL; clearing the input in the same breath is
  // what stops the old text — still sitting in local state — from riding the next
  // refinement back onto the URL.
  function switchSegment(next: CatalogSegment): void {
    if (next === segment) return;
    setText("");
    pushedQ.current = "";
    router.push(urlFor(cleanSwitchWithin(state.hierarchy, next)));
  }

  const scope: FacetScope = {
    hierarchy: state.hierarchy,
    q: state.q || undefined,
    type: state.type,
    own: state.own,
    inStock: state.inStock,
    smoked: state.smoked,
    favorites: state.favorites,
  };

  return (
    // ONE fixed-height row that pans horizontally when crowded and never wraps
    // on a phone (port: the `.library-chipbar` overflow idiom, app.css:1662-1700).
    // Adding or clearing a chip can therefore never grow the bar, so the grid
    // below never shifts.
    <div className="no-scrollbar flex min-h-11 snap-x flex-nowrap items-center gap-3 overflow-x-auto sm:flex-wrap sm:overflow-visible">
      {state.view !== "ledger" ? (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Search the catalog"
          className={`${ui.field} w-40 shrink-0 sm:w-64`}
        />
      ) : null}

      <Segmented
        ariaLabel="Catalog view"
        options={segments}
        active={segment}
        onSelect={switchSegment}
      />

      {state.view === "grid" ? (
        <>
          <Rail label="Own">
            <Segmented
              ariaLabel="Ownership"
              options={CATALOG_OWNERSHIP_FACETS.map((f) => ({ value: f.value, label: f.label }))}
              active={state.own}
              onSelect={(own: OwnershipFacet) => {
                if (own === state.own) return;
                refine({ ...state, q: text, own });
              }}
            />
          </Rail>

          <Rail label="Type">
            <Segmented
              ariaLabel="Type"
              options={CATALOG_TYPE_FACETS.map((f) => ({ value: f.value, label: f.label }))}
              active={activeType}
              onSelect={(next: CatalogTypeFacet) => {
                const type = next === "all" ? undefined : next;
                if (type === state.type) return;
                refine({ ...state, q: text, type });
              }}
            />
          </Rail>

          <Rail label="Sort">
            {grouped ? (
              <CatalogSortRow
                sorts={GROUP_SORTS}
                active={state.groupSort}
                onSelect={(groupSort: CatalogSortToken<GroupSortField>) =>
                  refine({ ...state, q: text, groupSort })
                }
              />
            ) : (
              <CatalogSortRow
                sorts={CATALOG_LEVELS[level].sorts}
                active={state.sort}
                onSelect={(sort: CatalogSortToken<CatalogSort>) => refine({ ...state, q: text, sort })}
              />
            )}
          </Rail>
        </>
      ) : null}

      {/* Chips are leaf-grid only: group cards do not facet in v1, and a chip row
          over aggregate cards would filter the members without saying so. */}
      {state.view === "grid" && !grouped ? (
        <div className="flex shrink-0 items-center gap-2">
          {chipDimensions.map((dimension) => (
            <CatalogFacetChip
              key={dimension}
              dimension={dimension}
              value={state.hierarchy[dimension]}
              scope={scope}
              onSelect={(slug, ancestor?: HierarchyAncestor | null) => {
                const hierarchy = { ...state.hierarchy };
                if (slug) {
                  // A chip writes the same param a drill writes, so it also has
                  // to write the same SCOPE: line and blend slugs are unique only
                  // within their parent, and an option picked at the root would
                  // otherwise select every marca's `Reserva` at once — under a
                  // pill naming just one of them.
                  if (ancestor && !hierarchy[ancestor.dimension]) {
                    hierarchy[ancestor.dimension] = ancestor.slug;
                  }
                  hierarchy[dimension] = slug;
                } else delete hierarchy[dimension];
                refine({ ...state, q: text, hierarchy });
              }}
            />
          ))}
          <ToggleChip
            label={CATALOG_CHIPS.inStock}
            active={state.inStock}
            onToggle={() => refine({ ...state, q: text, inStock: !state.inStock })}
          />
          <ToggleChip
            label={CATALOG_CHIPS.smoked}
            active={state.smoked}
            onToggle={() => refine({ ...state, q: text, smoked: !state.smoked })}
          />
          <ToggleChip
            label={CATALOG_CHIPS.favorites}
            active={state.favorites}
            onToggle={() => refine({ ...state, q: text, favorites: !state.favorites })}
          />
          {/* Gated and scoped to the chips this row actually renders. A drill's
              own param is neither counted nor cleared — the drill header's back
              link is its only exit, and it is a PUSH. */}
          {visibleChipCount(state) >= 2 ? (
            <button
              type="button"
              onClick={() => refine({ ...clearVisibleChips(state), q: text })}
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

// A labeled rail: a muted lead label before its group (DESIGN-003 §IA), so two
// adjacent groups never read as one competing filter. The seg stays unlabeled
// and first.
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
