"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { actionErrorMessage } from "@/lib/trpc/error";
import { ui } from "@/lib/ui";

// The operator kickstart for the "Missing photos" worklist (issue 154): one press
// enqueues the listed cigars for the crawler's enrich runs. The result line is the
// receipt — the section itself only changes once a run actually lands a photo.
//
// The request id is stable only for the duration of ONE press (a double-click while
// the mutation is in flight replays through the ADR-003 envelope instead of queuing
// twice) and is re-minted the moment it settles. Keeping it for the component's
// lifetime made the button single-use per page load: router.refresh() re-renders the
// server components but preserves this client instance and its ref, so every later
// press replayed the first press's stored result and rendered it as a fresh receipt.
export function QueueEnrichmentButton() {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const queue = api.curation.queueEnrichmentBacklog.useMutation({
    onSuccess: () => router.refresh(),
    onSettled: () => {
      requestId.current = crypto.randomUUID();
    },
  });

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={ui.button}
        disabled={queue.isPending}
        onClick={() => queue.mutate({ clientRequestId: requestId.current })}
      >
        Queue enrichment
      </button>
      {queue.data ? (
        <span className={`text-sm ${ui.muted}`}>
          Queued {queue.data.queued} · skipped {queue.data.skipped}
        </span>
      ) : null}
      {queue.error ? <span className={`text-sm ${ui.muted}`}>{actionErrorMessage(queue.error)}</span> : null}
    </span>
  );
}
