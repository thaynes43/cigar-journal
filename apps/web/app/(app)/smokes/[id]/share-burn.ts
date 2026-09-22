import type { ProgressionEntryView } from "@cj/domain";

// How far the cigar had burned, for the share card's ribbon.
//
// The furthest recorded position, and nothing inferred: a progression that
// carries no position at all leaves the card's cigar UNLIT rather than lit to
// zero — the same rule the live burn line follows (a missing position is never
// interpolated, and "unlit" and "burned to the foot" are different claims).
export function smokeBurn(progression: ProgressionEntryView[]): {
  burn: number | null;
  markers: number[];
} {
  const positions = progression
    .map((entry) => entry.approximatePosition)
    .filter((position): position is number => position != null)
    .map((position) => Math.min(1, Math.max(0, position)));
  if (positions.length === 0) return { burn: null, markers: [] };
  return { burn: Math.max(...positions), markers: positions };
}
