"use client";

import { useState, type KeyboardEvent } from "react";
import { ui } from "@/lib/ui";

// Tag input: type a descriptor, Enter or comma commits it, Backspace on an empty
// field removes the last. Verbatim wording is captured elsewhere; these are the
// tags the domain normalizes.
export function DescriptorsInput({
  value,
  onChange,
  id,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  id?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const tag = draft.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-neutral-300 px-2 py-1.5 dark:border-neutral-700">
      {value.map((tag) => (
        <span key={tag} className={ui.chip}>
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            aria-label={`Remove ${tag}`}
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  );
}
