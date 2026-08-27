"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { useDebounced } from "@/lib/use-debounced";
import { BandTile } from "./band-tile";

export function CatalogSearch() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 250);
  const search = api.cigars.search.useQuery(
    { query: debouncedQuery },
    { enabled: debouncedQuery.trim().length >= 2 },
  );
  const matches = search.data?.matches ?? [];

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
      {matches.length > 0 ? (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {matches.map((match) => (
            <li key={match.cigarId}>
              <Link
                href={`/cigars/${match.cigarId}`}
                className="flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-3 transition-colors hover:border-accent/60"
              >
                <BandTile
                  name={match.canonicalName}
                  vitola={match.vitola.name}
                  type={match.type}
                  size="card"
                />
                <div className="flex flex-col gap-1">
                  <span className="font-display leading-snug font-semibold text-ink">
                    {match.canonicalName}
                  </span>
                  {match.brand ? <span className="text-xs text-muted">{match.brand}</span> : null}
                  {match.verification === "unverified" ? (
                    <span className={`${ui.chipOutline} self-start`}>unverified</span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
