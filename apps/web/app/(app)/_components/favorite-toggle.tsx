"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc/react";
import { favoriteChip } from "@/lib/ui";

// The FavoriteToggle (DESIGN-002) — the second cigar-level mark's interactive
// control, sitting beside the WantToggle on the cigar detail hero. Chip-shaped
// like Want, but the state signal is the HEART's fill (♥ set / ♡ unset) in the
// ember reserved for hearts, not the amber accent Want owns; the label is
// "Favorite" in both states. `aria-pressed` carries the state for assistive tech.
// The set/clear is idempotent server-side, so the click optimistically flips and
// reverts only if the mutation fails.
export function FavoriteToggle({
  cigarId,
  initialFavorited,
}: {
  cigarId: string;
  initialFavorited: boolean;
}) {
  const router = useRouter();
  const [favorited, setFavorited] = useState(initialFavorited);
  const setFavorite = api.cigars.setFavorite.useMutation({
    onSuccess: (result) => {
      setFavorited(result.favorited);
      router.refresh();
    },
  });

  const toggle = () => {
    const next = !favorited;
    setFavorited(next); // optimistic
    setFavorite.mutate({ cigarId, favorited: next }, { onError: () => setFavorited(!next) });
  };

  return (
    <button
      type="button"
      aria-pressed={favorited}
      onClick={toggle}
      disabled={setFavorite.isPending}
      className={`${favoriteChip.base} ${favorited ? favoriteChip.set : favoriteChip.unset} self-start focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-50`}
    >
      <span aria-hidden className={favorited ? favoriteChip.heartSet : favoriteChip.heartUnset}>
        {favorited ? "♥" : "♡"}
      </span>
      Favorite
    </button>
  );
}
