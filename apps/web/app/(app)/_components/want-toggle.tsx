"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { wantChip } from "@/lib/ui";

// The WantToggle (DESIGN-002 §Want): the single want mark's interactive control on
// the cigar detail hero. Chip-shaped, accent-filled when set and outlined when
// unset (`aria-pressed` carries the state for assistive tech); the label is
// "Want" in both states — the fill signals state, per the approved strings. The
// set/clear is idempotent server-side, so the click optimistically flips and
// reverts only if the mutation fails.
export function WantToggle({ cigarId, initialWanted }: { cigarId: string; initialWanted: boolean }) {
  const router = useRouter();
  const [wanted, setWanted] = useState(initialWanted);
  const setWant = api.cigars.setWant.useMutation({
    onSuccess: (result) => {
      setWanted(result.wanted);
      router.refresh();
    },
  });

  const toggle = () => {
    const next = !wanted;
    setWanted(next); // optimistic
    setWant.mutate({ cigarId, wanted: next }, { onError: () => setWanted(!next) });
  };

  return (
    <button
      type="button"
      aria-pressed={wanted}
      onClick={toggle}
      disabled={setWant.isPending}
      className={`${wantChip.base} ${wanted ? wantChip.set : wantChip.unset} self-start transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-50`}
    >
      Want
    </button>
  );
}
