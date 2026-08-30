"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { actionErrorMessage } from "@/lib/trpc/error";
import { ui } from "@/lib/ui";

// Set a cigar's canonical name (#45) — the smallest honest affordance: a Rename
// button that reveals an inline field prefilled with the current name. The request
// id is stable per instance, so a retry after an error replays through the envelope.
export function RenameButton({ cigarId, canonicalName }: { cigarId: string; canonicalName: string }) {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(canonicalName);
  const rename = api.curation.rename.useMutation({
    onSuccess: () => {
      setEditing(false);
      router.refresh();
    },
  });

  if (!editing) {
    return (
      <button type="button" className={ui.button} onClick={() => setEditing(true)}>
        Rename
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <input
        className={ui.field}
        aria-label="Canonical name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="button"
        className={ui.primary}
        disabled={rename.isPending || name.trim().length === 0}
        onClick={() => rename.mutate({ clientRequestId: requestId.current, cigarId, canonicalName: name })}
      >
        Save
      </button>
      <button
        type="button"
        className={ui.button}
        onClick={() => {
          setEditing(false);
          setName(canonicalName);
        }}
      >
        Cancel
      </button>
      {rename.error ? <span className={`text-sm ${ui.muted}`}>{actionErrorMessage(rename.error)}</span> : null}
    </span>
  );
}
