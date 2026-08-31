"use client";

import type {
  CatalogSortDir,
  CatalogSortField,
  CatalogSortToken,
  RegistrySort,
} from "./catalog-registry";
import { cycleSort } from "./catalog-registry";

// The sort row (DESIGN-003 §Sort row, given direction by DESIGN-004 D-04): one
// ghost pill per key the ACTIVE LEVEL declares, entering at that key's best-first
// direction and reversing on a second click — a two-state cycle, never a
// three-state one that could strand the grid with no ordering at all.
//
// Every pill reserves a fixed-width arrow slot after its label (port:
// `.sort-btn__arrow`, app.css:1727-1732). The glyph therefore appears and
// disappears inside space that was always there, so toggling a sort never nudges
// its neighbours — the reflow discipline the whole toolbar is built on. This was
// carried as debt by DESIGN-003, which had no direction to show yet.
//
// The row renders exactly what the registry hands it, so a level cannot grow a
// control for a sort the domain will not answer at that level.

const ARROW: Record<CatalogSortDir, string> = { asc: "▲", desc: "▼" };

export function CatalogSortRow<F extends CatalogSortField>({
  sorts,
  active,
  onSelect,
}: {
  sorts: readonly RegistrySort<F>[];
  active: CatalogSortToken<F>;
  onSelect: (next: CatalogSortToken<F>) => void;
}) {
  return (
    <div role="group" aria-label="Sort" className="flex shrink-0 items-center gap-1">
      {sorts.map((sort) => {
        const isActive = active.field === sort.key;
        return (
          <button
            key={sort.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(cycleSort(active, sort.key))}
            className={`label-caps flex shrink-0 items-center rounded-chip border px-3 py-1 whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none ${
              isActive
                ? "border-accent/50 bg-accent/10 text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {sort.label}
            {/* Reserved whether or not it is filled — see the arrow-slot note. */}
            <span aria-hidden className="inline-block w-[1.1em] text-center text-[0.625rem]">
              {isActive ? ARROW[active.dir] : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}
