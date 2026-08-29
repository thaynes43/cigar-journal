"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";

// Fold the source cigar into the target (this side survives), then refresh the
// queue. One button per direction lives under each side of a duplicate pair.
export function MergeButton({
  sourceCigarId,
  targetCigarId,
}: {
  sourceCigarId: string;
  targetCigarId: string;
}) {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const merge = api.curation.merge.useMutation({ onSuccess: () => router.refresh() });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={ui.button}
        disabled={merge.isPending}
        onClick={() =>
          merge.mutate({ clientRequestId: requestId.current, sourceCigarId, targetCigarId })
        }
      >
        Merge into this
      </button>
      {merge.error ? <span className={`text-sm ${ui.muted}`}>{merge.error.message}</span> : null}
    </span>
  );
}
