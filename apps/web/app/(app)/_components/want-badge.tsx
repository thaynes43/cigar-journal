import { wantChip } from "@/lib/ui";

// The static variant of the WantToggle (DESIGN-002): a non-interactive chip that
// signals a want mark on a tile. Server-safe (no client boundary, no router), so
// catalog tiles render it inline. Accent-filled by default — the tile only shows
// it when the mark is set; the outlined form exists for symmetry with the toggle.
export function WantBadge({ filled = true }: { filled?: boolean }) {
  return <span className={`${wantChip.base} ${filled ? wantChip.set : wantChip.unset}`}>Want</span>;
}
