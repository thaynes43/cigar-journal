"use client";

import { usePathname, useRouter } from "next/navigation";

// The Grid | Table segmented control. View state lives in the URL (?view=table),
// so it is shareable and back-button safe (PRD-002); switching is a replace.
export function InventoryViewToggle({ view }: { view: "grid" | "table" }) {
  const router = useRouter();
  const pathname = usePathname();

  function select(next: "grid" | "table") {
    if (next === view) return;
    router.replace(next === "table" ? `${pathname}?view=table` : pathname);
  }

  return (
    <div className="inline-flex overflow-hidden rounded-field border border-line">
      {(["grid", "table"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => select(option)}
          aria-pressed={view === option}
          className={`label-caps px-3 py-1.5 transition-colors ${
            view === option ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"
          }`}
        >
          {option === "grid" ? "Grid" : "Table"}
        </button>
      ))}
    </div>
  );
}
