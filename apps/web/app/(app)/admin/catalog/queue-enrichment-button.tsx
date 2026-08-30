"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";

// The operator kickstart for the "Missing photos" worklist (issue 154): one press
// enqueues the listed cigars for the crawler's enrich runs. The request id is
// stable per instance, so a double-click replays through the envelope rather than
// queuing twice. The result line is the receipt — the section itself only changes
// once a run actually lands a photo.
export function QueueEnrichmentButton() {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const queue = api.curation.queueEnrichmentBacklog.useMutation({
    onSuccess: () => router.refresh(),
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
      {queue.error ? <span className={`text-sm ${ui.muted}`}>{queue.error.message}</span> : null}
    </span>
  );
}
