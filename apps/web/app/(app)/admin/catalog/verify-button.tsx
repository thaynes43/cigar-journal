"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";

// Flip an unverified catalog cigar to verified, then refresh the queue so the row
// drops out. The request id is stable per button instance, so a retry after an
// error replays through the mutation envelope rather than double-firing.
export function VerifyButton({ cigarId }: { cigarId: string }) {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const verify = api.curation.verify.useMutation({ onSuccess: () => router.refresh() });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={ui.button}
        disabled={verify.isPending}
        onClick={() => verify.mutate({ clientRequestId: requestId.current, cigarId })}
      >
        Verify
      </button>
      {verify.error ? <span className={`text-sm ${ui.muted}`}>{verify.error.message}</span> : null}
    </span>
  );
}
