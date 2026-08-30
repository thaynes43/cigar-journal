"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { actionErrorMessage } from "@/lib/trpc/error";
import { ui } from "@/lib/ui";

// Reverse one merge from its ledger, then refresh the console. Sits on the row
// under "Recent merges"; the section renders a state label instead of this button
// when the merge is already undone or blocked by a later merge.
export function UnmergeButton({ mergeId }: { mergeId: string }) {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const unmerge = api.curation.unmerge.useMutation({ onSuccess: () => router.refresh() });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={ui.button}
        disabled={unmerge.isPending}
        onClick={() => unmerge.mutate({ clientRequestId: requestId.current, mergeId })}
      >
        Unmerge
      </button>
      {unmerge.error ? (
        <span className={`text-sm ${ui.muted}`}>{actionErrorMessage(unmerge.error)}</span>
      ) : null}
    </span>
  );
}
