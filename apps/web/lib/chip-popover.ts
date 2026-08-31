import type { CSSProperties } from "react";

// The viewport-clamped `position: fixed` geometry for a chip-anchored popover
// (DESIGN-004 D-06; a direct port of `chipPopoverStyle`, FilterChip.tsx:46-60).
//
// Fixed rather than absolute, and that is the load-bearing choice: the catalog
// toolbar is a horizontally-panning overflow container, and an absolutely
// positioned panel inside one is CLIPPED by it. Fixed escapes the scroller — at
// the cost of having to clamp by hand, because a fixed panel has no parent to
// keep it on screen and no automatic flip.
//
// Pure, so the 390px-viewport contract is unit-tested directly rather than only
// through a browser.

export interface PopoverAnchor {
  bottom: number;
  left: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

export interface PopoverOptions {
  maxWidth?: number;
  margin?: number;
  gap?: number;
}

export function chipPopoverStyle(
  anchor: PopoverAnchor,
  viewport: PopoverViewport,
  { maxWidth = 320, margin = 8, gap = 6 }: PopoverOptions = {},
): CSSProperties {
  // Shrink to fit a narrow viewport before anything else — on a 390px phone the
  // panel may not be 320 wide, and every clamp below depends on the real width.
  const width = Math.min(maxWidth, viewport.width - margin * 2);
  // Double-clamped: floored at the margin, then ceilinged so the right edge
  // clears it. The ceiling is ITSELF floored at the margin, so a viewport
  // narrower than the panel yields `margin` rather than a negative left.
  const left = Math.min(
    Math.max(margin, anchor.left),
    Math.max(margin, viewport.width - width - margin),
  );
  // Anchored bottom-start; it never flips above the trigger.
  const top = anchor.bottom + gap;
  // `max(160, …)` deliberately lets a panel near the fold OVERFLOW rather than
  // collapse into an unusable sliver — a scrollable 160px list beats a 12px one.
  const maxHeight = Math.max(160, Math.min(360, viewport.height - top - margin));
  return { position: "fixed", top, left, maxWidth: width, maxHeight };
}
