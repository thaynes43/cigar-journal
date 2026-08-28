"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CigarType } from "@cj/domain";
import { ui } from "@/lib/ui";
import { useDebounced } from "@/lib/use-debounced";
import { CATALOG_TYPE_FACETS, type CatalogTypeFacet } from "./catalog-registry";

type View = "brands" | "all";

// The catalog toolbar owns all browse state (view, q, type), and those are the
// only URL params, so it rebuilds the target URL from its props rather than
// reading the params back. Filter edits (search, type) `router.replace` to stay
// shareable and back-button quiet; the view switch `push`es (PRD conventions).
export function CatalogToolbar({
  view,
  q,
  type,
}: {
  view: View;
  q: string;
  type?: CigarType;
}) {
  const router = useRouter();
  const pathname = usePathname();

  function urlFor(next: { view: View; q: string; type?: CigarType }): string {
    const params = new URLSearchParams();
    if (next.view === "all") params.set("view", "all");
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.view === "all" && next.type) params.set("type", next.type);
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  const [text, setText] = useState(q);
  const debounced = useDebounced(text, 250);

  // Push the debounced query into the URL when it settles on something new.
  // Only the debounced value drives this effect; the rest comes from URL props.
  useEffect(() => {
    if (debounced.trim() === q) return;
    router.replace(urlFor({ view, q: debounced, type }));
  }, [debounced]);

  function switchView(next: View): void {
    if (next === view) return;
    router.push(urlFor({ view: next, q: text, type: next === "all" ? type : undefined }));
  }

  function selectType(next: CatalogTypeFacet): void {
    const nextType = next === "all" ? undefined : next;
    if (nextType === type) return;
    router.replace(urlFor({ view, q: text, type: nextType }));
  }

  const activeType: CatalogTypeFacet = type ?? "all";

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Search the catalog"
        className={`${ui.field} w-full sm:w-64`}
      />
      <div className="inline-flex overflow-hidden rounded-field border border-line">
        {(["brands", "all"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => switchView(option)}
            aria-pressed={view === option}
            className={`label-caps px-3 py-1.5 transition-colors ${
              view === option ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"
            }`}
          >
            {option === "brands" ? "Brands" : "All"}
          </button>
        ))}
      </div>
      {view === "all" ? (
        <div className="inline-flex overflow-hidden rounded-field border border-line">
          {CATALOG_TYPE_FACETS.map((facet) => (
            <button
              key={facet.value}
              type="button"
              onClick={() => selectType(facet.value)}
              aria-pressed={activeType === facet.value}
              className={`label-caps px-3 py-1.5 transition-colors ${
                activeType === facet.value
                  ? "bg-accent text-accent-ink"
                  : "text-muted hover:text-ink"
              }`}
            >
              {facet.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
