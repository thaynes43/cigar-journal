"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { actionErrorMessage } from "@/lib/trpc/error";
import { ui } from "@/lib/ui";

// Record that a surfaced pair is distinct products, then refresh the queue —
// the pair never comes back. One button per duplicate pair.
export function DismissButton({ cigarAId, cigarBId }: { cigarAId: string; cigarBId: string }) {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const dismiss = api.curation.dismiss.useMutation({ onSuccess: () => router.refresh() });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={ui.button}
        disabled={dismiss.isPending}
        onClick={() => dismiss.mutate({ clientRequestId: requestId.current, cigarAId, cigarBId })}
      >
        Not duplicates
      </button>
      {dismiss.error ? <span className={`text-sm ${ui.muted}`}>{actionErrorMessage(dismiss.error)}</span> : null}
    </span>
  );
}
