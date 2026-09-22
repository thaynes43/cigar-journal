import type { ReactElement } from "react";

// The house seal — the mark this app signs itself with: the favicon, the app
// icon, the header lockup, the cigar band the burn line draws, and the share
// cards.
//
// Brand orange is the GROUND, full bleed, never a rounded badge. On it sit an
// espresso keyline frame and a serif H drawn entirely from rectangles, so the
// mark needs no font at any size and rasterizes identically in a browser, in
// satori (the OG cards) and in a 180px PNG. At 48px and up a fine cream inline
// runs down the H like an engraved monogram; below that it closes up into mud,
// so it is dropped — `inline` defaults to that rule and is overridable, because
// the burn line's band wants the engraving at 32px where it reads against the
// stick.
//
// The orange is the seal's alone (`--brand`, globals.css): it is never a UI
// accent — amber stays the accent — and nothing but the seal may spend it.
//
// Two grounds: "brand" paints the orange square (the standalone mark), "none"
// draws the seal onto a surface that is ALREADY the brand orange (the band, the
// share cards), where painting it again would only fight the ground. The frame
// follows the ground by default and is overridable the same way.

// Geometry in the 32-unit box. Stems, crossbar and the four slab serifs.
const H_RECTS = [
  { x: 8.6, y: 7.8, width: 3.6, height: 16.4 },
  { x: 19.8, y: 7.8, width: 3.6, height: 16.4 },
  { x: 12.2, y: 14.8, width: 7.6, height: 2.4 },
  { x: 6.9, y: 7.8, width: 7, height: 1.2 },
  { x: 6.9, y: 23, width: 7, height: 1.2 },
  { x: 18.1, y: 7.8, width: 7, height: 1.2 },
  { x: 18.1, y: 23, width: 7, height: 1.2 },
];

// The engraved inline: a hairline of cream down each stem and along the crossbar.
const INLINE_RECTS = [
  { x: 10.1, y: 9.6, width: 0.6, height: 12.8 },
  { x: 21.3, y: 9.6, width: 0.6, height: 12.8 },
  { x: 12.2, y: 15.7, width: 7.6, height: 0.6 },
];

interface SealPaint {
  brand: string;
  ink: string;
  cream: string;
}

interface SealShape {
  ground: boolean;
  frame: boolean;
  inline: boolean;
}

// A flat array, not a fragment tree: satori walks the children of an inline svg
// and a nested fragment is one more thing for it to get wrong.
function sealChildren(paint: SealPaint, shape: SealShape): ReactElement[] {
  const parts: ReactElement[] = [];
  if (shape.ground) parts.push(<rect key="ground" width="32" height="32" fill={paint.brand} />);
  if (shape.frame) {
    parts.push(
      <rect
        key="frame"
        x="2"
        y="2"
        width="28"
        height="28"
        fill="none"
        stroke={paint.ink}
        strokeOpacity="0.72"
        strokeWidth="0.8"
      />,
    );
  }
  H_RECTS.forEach((rect, i) => parts.push(<rect key={`h${i}`} {...rect} fill={paint.ink} />));
  if (shape.inline) {
    INLINE_RECTS.forEach((rect, i) =>
      parts.push(<rect key={`i${i}`} {...rect} fill={paint.cream} fillOpacity="0.9" />),
    );
  }
  return parts;
}

export interface HouseSealProps {
  size?: number;
  className?: string;
  ground?: "brand" | "none";
  frame?: boolean;
  // Defaults to `size >= 48`. The band overrides it: at 32px on the stick the
  // engraving is what tells the mark apart from a smudge.
  inline?: boolean;
}

export function HouseSeal({ size = 22, className, ground = "brand", frame, inline }: HouseSealProps) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ display: "block" }}
    >
      {sealChildren(
        { brand: "var(--brand)", ink: "var(--brand-ink)", cream: "var(--parchment-100)" },
        { ground: ground === "brand", frame: frame ?? ground === "brand", inline: inline ?? size >= 48 },
      )}
    </svg>
  );
}

// The same mark for the OG cards. satori resolves no CSS variables, so the three
// colors arrive as literals from the card palette — the one place in the app
// allowed to name them (see app/_og/palette.ts and its drift test).
export function houseSealSvg({
  size,
  brand,
  ink,
  cream,
  ground = "brand",
  frame,
  inline,
}: {
  size: number;
  brand: string;
  ink: string;
  cream: string;
  ground?: "brand" | "none";
  frame?: boolean;
  inline?: boolean;
}): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {sealChildren(
        { brand, ink, cream },
        { ground: ground === "brand", frame: frame ?? ground === "brand", inline: inline ?? size >= 48 },
      )}
    </svg>
  );
}

// The same mark placed INSIDE another svg — the band on the card's ribbon. It is
// a transformed `<g>`, not a nested `<svg x y>`: satori's renderer draws a nested
// svg at its parent's origin as well as at its own coordinates, which put a
// second seal on the cigar's foot.
export function houseSealGroup({
  size,
  x,
  y,
  elementKey,
  brand,
  ink,
  cream,
  ground = "none",
  frame = true,
  inline = true,
}: {
  size: number;
  x: number;
  y: number;
  // The factory is called from inside an array of svg children, so it takes the
  // React key rather than making every call site wrap it.
  elementKey?: string;
  brand: string;
  ink: string;
  cream: string;
  ground?: "brand" | "none";
  frame?: boolean;
  inline?: boolean;
}): ReactElement {
  return (
    <g key={elementKey} transform={`translate(${x} ${y}) scale(${size / 32})`}>
      {sealChildren({ brand, ink, cream }, { ground: ground === "brand", frame, inline })}
    </g>
  );
}
