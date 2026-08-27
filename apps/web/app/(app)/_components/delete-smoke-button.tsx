"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";

// Inline confirm (no window.confirm): the first press reveals the confirmation
// controls in place; the second deletes.
export function DeleteSmokeButton({ smokeId }: { smokeId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const del = api.smokes.delete.useMutation({
    onSuccess: () => {
      router.push("/");
      router.refresh();
    },
  });

  if (!confirming) {
    return (
      <button type="button" className={ui.danger} onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-sm">Delete this smoke?</span>
      <button type="button" className={ui.danger} disabled={del.isPending} onClick={() => del.mutate({ smokeId })}>
        Delete
      </button>
      <button type="button" className={ui.button} onClick={() => setConfirming(false)}>
        Cancel
      </button>
      {del.error ? <span className={`text-sm ${ui.muted}`}>{del.error.message}</span> : null}
    </span>
  );
}
