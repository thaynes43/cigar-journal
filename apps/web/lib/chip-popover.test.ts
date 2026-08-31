import { describe, expect, it } from "vitest";
import { chipPopoverStyle } from "./chip-popover";

// The clamp is the reason a fixed-position popover is usable at all, so it is
// tested as arithmetic rather than only through the browser. The 390×844 case is
// the one the e2e also pins (port: library-grid.spec.ts:221-253).

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const style = (anchor: { bottom: number; left: number }, viewport = PHONE) =>
  chipPopoverStyle(anchor, viewport) as {
    position: string;
    top: number;
    left: number;
    maxWidth: number;
    maxHeight: number;
  };

describe("chipPopoverStyle", () => {
  it("anchors bottom-start and never flips above the trigger", () => {
    const s = style({ bottom: 100, left: 24 }, DESKTOP);
    expect(s.position).toBe("fixed");
    expect(s.top).toBe(106);
    expect(s.left).toBe(24);
  });

  it("caps at 320px on a wide viewport", () => {
    expect(style({ bottom: 100, left: 24 }, DESKTOP).maxWidth).toBe(320);
  });

  it("keeps a far-right chip fully on a 390px viewport", () => {
    // The worst clamping case: a chip panned to the right edge of the toolbar.
    const s = style({ bottom: 60, left: 370 });
    expect(s.left).toBeGreaterThanOrEqual(8);
    expect(s.left + s.maxWidth).toBeLessThanOrEqual(390);
  });

  it("keeps a chip scrolled off the left edge on screen too", () => {
    const s = style({ bottom: 60, left: -40 });
    expect(s.left).toBe(8);
  });

  it("shrinks the panel rather than overflowing a viewport narrower than 336px", () => {
    const s = style({ bottom: 40, left: 200 }, { width: 300, height: 600 });
    expect(s.maxWidth).toBe(284);
    expect(s.left + s.maxWidth).toBeLessThanOrEqual(300);
  });

  it("never yields a negative left, even when the panel cannot fit", () => {
    const s = style({ bottom: 40, left: 100 }, { width: 10, height: 600 });
    expect(s.left).toBe(8);
  });

  it("caps height at 360 with room to spare", () => {
    expect(style({ bottom: 40, left: 20 }).maxHeight).toBe(360);
  });

  it("keeps a usable 160px list near the fold rather than collapsing to a sliver", () => {
    // Deliberately overflows the fold: a scrollable 160px list beats a 12px one.
    const s = style({ bottom: 830, left: 20 });
    expect(s.maxHeight).toBe(160);
  });
});
