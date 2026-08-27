"use client";

import Link from "next/link";
import { useState } from "react";
import type { CatalogCigar } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { useDebounced } from "@/lib/use-debounced";
import { BandTile } from "./band-tile";

// The catalog's default state is the browse grid (server-rendered, passed in);
// typing two or more characters hands the grid over to fuzzy search results.
// Both render through the same band-tile grid, so the surface never reflows.
export function CatalogSearch({
  browse,
  totalCount,
}: {
  browse: CatalogCigar[];
  totalCount: number;
}) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 250);
  const searching = debouncedQuery.trim().length >= 2;
  const search = api.cigars.search.useQuery({ query: debouncedQuery }, { enabled: searching });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Catalog</h1>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search the catalog"
        className={`${ui.field} max-w-md`}
        autoFocus
      />
      {searching ? (
        <CigarGrid items={search.data?.matches ?? []} />
      ) : (
        <>
          <CigarGrid items={browse} />
          {totalCount > browse.length ? (
            <p className="text-sm text-muted">
              Showing {browse.length} of {totalCount}.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

// Structural minimum both browse rows and search matches satisfy.
type GridCigar = Pick<
  CatalogCigar,
  "cigarId" | "canonicalName" | "brand" | "vitola" | "type" | "verification"
>;

function CigarGrid({ items }: { items: GridCigar[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((cigar) => (
        <li key={cigar.cigarId}>
          <Link
            href={`/cigars/${cigar.cigarId}`}
            className="flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-3 transition-colors hover:border-accent/60"
          >
            <BandTile
              name={cigar.canonicalName}
              vitola={cigar.vitola.name}
              type={cigar.type}
              size="card"
            />
            <div className="flex flex-col gap-1">
              <span className="font-display leading-snug font-semibold text-ink">
                {cigar.canonicalName}
              </span>
              {cigar.brand ? <span className="text-xs text-muted">{cigar.brand}</span> : null}
              {cigar.verification === "unverified" ? (
                <span className={`${ui.chipOutline} self-start`}>unverified</span>
              ) : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
