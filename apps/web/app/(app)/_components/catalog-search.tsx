"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { useDebounced } from "@/lib/use-debounced";

export function CatalogSearch() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 250);
  const search = api.cigars.search.useQuery(
    { query: debouncedQuery },
    { enabled: debouncedQuery.trim().length >= 2 },
  );
  const matches = search.data?.matches ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Catalog</h1>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search the catalog"
        className={ui.field}
        autoFocus
      />
      {matches.length > 0 ? (
        <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
          {matches.map((match) => (
            <li key={match.cigarId} className="py-3">
              <Link href={`/cigars/${match.cigarId}`} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{match.canonicalName}</span>
                  {match.verification === "unverified" ? <span className={ui.chip}>unverified</span> : null}
                </div>
                <span className={`text-sm ${ui.muted}`}>
                  {[match.brand, match.vitola.name, match.type].filter(Boolean).join(" · ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
