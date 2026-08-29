"use client";

import { useState } from "react";
import type { CigarRef, CigarType } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { useDebounced } from "@/lib/use-debounced";

interface Described {
  canonicalName: string;
  brand: string;
  vitola: string;
  type: "" | CigarType;
}

// Cigar resolution: search-as-you-type against the catalog; a picked match links
// by id. No match (or the "Describe it" affordance) reveals inline described
// fields — the domain creates an unverified catalog entry from them on save.
// `initial` pre-resolves the picker to a known cigar (the /smokes/new?cigarId=
// deep link from the detail page's record action); it stays changeable.
export function CigarPicker({
  onChange,
  initial,
}: {
  onChange: (ref: CigarRef | null) => void;
  initial?: { cigarId: string; canonicalName: string } | null;
}) {
  const [mode, setMode] = useState<"search" | "describe">("search");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ cigarId: string; canonicalName: string } | null>(
    initial ?? null,
  );
  const [described, setDescribed] = useState<Described>({ canonicalName: "", brand: "", vitola: "", type: "" });

  const debouncedQuery = useDebounced(query, 250);
  const search = api.cigars.search.useQuery(
    { query: debouncedQuery },
    { enabled: mode === "search" && !selected && debouncedQuery.trim().length >= 2 },
  );

  function pick(match: { cigarId: string; canonicalName: string }) {
    setSelected(match);
    onChange({ cigarId: match.cigarId });
  }

  function emitDescribed(next: Described) {
    setDescribed(next);
    const name = next.canonicalName.trim();
    onChange(
      name
        ? {
            described: {
              canonicalName: name,
              brand: next.brand.trim() || null,
              vitola: next.vitola.trim() ? { name: next.vitola.trim() } : null,
              type: next.type || null,
            },
          }
        : null,
    );
  }

  function toDescribe() {
    setSelected(null);
    setMode("describe");
    // Carry the search text in as the name — it's what the user calls it.
    const seeded = described.canonicalName ? described : { ...described, canonicalName: query.trim() };
    emitDescribed(seeded);
  }

  if (selected) {
    return (
      <div className="flex items-center gap-3">
        <span className="font-display font-semibold text-ink">{selected.canonicalName}</span>
        <button
          type="button"
          className={ui.button}
          onClick={() => {
            setSelected(null);
            onChange(null);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  if (mode === "describe") {
    return (
      <div className="flex flex-col gap-3">
        <label className={ui.label}>
          Name
          <input
            value={described.canonicalName}
            onChange={(e) => emitDescribed({ ...described, canonicalName: e.target.value })}
            className={ui.field}
            autoFocus
          />
        </label>
        <div className="flex gap-2">
          <label className={`${ui.label} flex-1`}>
            Brand
            <input
              value={described.brand}
              onChange={(e) => emitDescribed({ ...described, brand: e.target.value })}
              className={ui.field}
            />
          </label>
          <label className={`${ui.label} flex-1`}>
            Vitola
            <input
              value={described.vitola}
              onChange={(e) => emitDescribed({ ...described, vitola: e.target.value })}
              className={ui.field}
            />
          </label>
          <label className={`${ui.label} w-24`}>
            Type
            <select
              value={described.type}
              onChange={(e) => emitDescribed({ ...described, type: e.target.value as Described["type"] })}
              className={ui.field}
            >
              <option value="">—</option>
              <option value="NC">NC</option>
              <option value="CC">CC</option>
            </select>
          </label>
        </div>
        <button type="button" className={`${ui.button} self-start`} onClick={() => setMode("search")}>
          Search instead
        </button>
      </div>
    );
  }

  const matches = search.data?.matches ?? [];
  return (
    <div className="flex flex-col gap-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={ui.field}
        aria-label="Search the catalog"
        autoFocus
      />
      {matches.length > 0 ? (
        <ul className="flex flex-col overflow-hidden rounded-field border border-line bg-surface">
          {matches.map((match) => (
            <li key={match.cigarId} className="border-b border-line last:border-0">
              <button
                type="button"
                onClick={() => pick(match)}
                className="flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-raised"
              >
                <span className="font-medium">{match.canonicalName}</span>
                <span className={`text-xs ${ui.muted}`}>
                  {[match.brand, match.vitola.name, match.type].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : search.isSuccess && debouncedQuery.trim().length >= 2 ? (
        <p className={ui.muted}>Not in the catalog yet.</p>
      ) : null}
      <button type="button" className={`${ui.button} self-start`} onClick={toDescribe}>
        Add new
      </button>
    </div>
  );
}
