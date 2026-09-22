import type { ReactElement } from "react";
import { houseSealGroup, houseSealSvg } from "../(app)/_components/house-seal";
import {
  OG,
  INK_EYEBROW,
  INK_FRAME,
  INK_SEAL_KEYLINE,
  INK_SEAL_RING,
  INK_STICK_OUTLINE,
  SHADE_HIGHLIGHT,
  SHADE_SHADOW,
} from "./palette";
import { OG_FONT_FAMILY } from "./fonts";

// The share card every unfurled link renders: the journal as a cigar band —
// brand orange, espresso engraving, a keyline frame, the house seal top right,
// and the burn line along the bottom.
//
// Three routes draw it (the site default, a smoke, a catalog cigar) and they
// differ only in the text and whether a score seal and a lit ribbon are present,
// so the composition lives here once.
//
// Everything is absolutely positioned or an explicit flex row/column: satori
// implements a subset of CSS, defaults every element to `display: flex`, and
// silently drops what it does not understand — so no shorthand, no `display:
// block`, no filters (the ember's glow is layered translucent rects, not a
// blur), and no CSS variables (see ./palette.ts).

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
const MARGIN = 64;
const FRAME_INSET = 28;
const MARK_SIZE = 96;
const SEAL_SIZE = 96;

const RIBBON_WIDTH = CARD_WIDTH - MARGIN * 2;
// Drawn at 72 rather than the live component's 40: a card is read at thumbnail
// size in someone else's timeline, and at 40 the cigar was a hairline with a
// great deal of dead orange under it. The stick's bottom edge sits 104px above
// the card's, and the markers hang below it — hence the two numbers.
const RIBBON_HEIGHT = 72;
const MARKER_OVERHANG = 12;
const RIBBON_BASELINE = 104;

// The band, in stick percent — the same two numbers the live component uses.
const BAND_START = 0.82;
const BAND_END = 0.92;

function eyebrowStyle(fontSize = 22) {
  return {
    fontSize,
    fontWeight: 600,
    letterSpacing: "0.16em",
    color: INK_EYEBROW,
    textTransform: "uppercase" as const,
  };
}

// The cigar, as SVG: satori lays out flex boxes, but the stick is a drawing, and
// an inline svg is the one place a shape can be a shape. Geometry mirrors
// burn-line.tsx — dome cap, veins, ash with cracks, ember ring plus char edge,
// the band with the full seal — translated from percentage divs to user units
// and scaled to the card's taller stick.
//
// The ash cracks are an explicit irregular list, not a repeating step: evenly
// spaced ticks read as a ruler rather than as ash, which is the same reason the
// live component layers gradients with periods that do not divide each other.
const CRACKS = [
  0.06, 0.11, 0.17, 0.21, 0.28, 0.33, 0.39, 0.46, 0.5, 0.57, 0.62, 0.69, 0.74, 0.8, 0.86, 0.91,
  0.96,
];

function ribbonSvg({
  width,
  burn,
  markers = [],
}: {
  width: number;
  burn: number | null;
  markers?: number[];
}): ReactElement {
  const height = RIBBON_HEIGHT;
  const radius = height / 2;
  const x = (fraction: number) => fraction * width;
  const body = `M0,0 H${width - radius} A${radius},${radius} 0 0 1 ${width - radius},${height} H0 Z`;
  const burnX = burn == null ? null : x(burn);
  const bandOn = burn == null || burn < BAND_START;
  const bandX = x(BAND_START);
  const bandWidth = x(BAND_END) - bandX;
  const parts: ReactElement[] = [];

  // Wrapper veins, then the two cap seams just inside the dome.
  for (let i = 1; i <= 7; i++) {
    const vx = (i / 8) * width;
    parts.push(
      <path
        key={`v${i}`}
        d={`M${vx},0 L${vx + 47},${height}`}
        stroke={OG.ink}
        strokeOpacity="0.11"
        strokeWidth="1"
        fill="none"
      />,
    );
  }
  for (const seam of [width - radius - 9, width - radius - 23]) {
    parts.push(
      <path
        key={`s${seam}`}
        d={`M${seam},4 A14,${radius - 4} 0 0 1 ${seam},${height - 4}`}
        stroke={OG.ink}
        strokeOpacity="0.28"
        strokeWidth="1"
        fill="none"
      />,
    );
  }

  // Unlit: a flat foot cut where the ember would be.
  if (burnX == null) {
    parts.push(<rect key="foot" x="0" y="0" width="4" height={height} fill={OG.ink} fillOpacity="0.25" />);
  }

  if (bandOn) {
    parts.push(
      <rect key="band" x={bandX} y="0" width={bandWidth} height={height} fill={OG.brand} />,
      <rect key="rule-top" x={bandX} y="3" width={bandWidth} height="1.5" fill={OG.ink} fillOpacity="0.8" />,
      <rect
        key="rule-bottom"
        x={bandX}
        y={height - 4.5}
        width={bandWidth}
        height="1.5"
        fill={OG.ink}
        fillOpacity="0.8"
      />,
    );
    parts.push(
      houseSealGroup({
        elementKey: "seal",
        size: 56,
        x: bandX + bandWidth / 2 - 28,
        y: height / 2 - 28,
        brand: OG.brand,
        ink: OG.ink,
        cream: OG.cream,
      }),
    );
  }

  if (burnX != null) {
    const ashEnd = burnX - 5;
    parts.push(<rect key="ash" x="0" y="0" width={Math.max(ashEnd, 0)} height={height} fill={OG.ash} />);
    CRACKS.forEach((fraction, i) => {
      const cx = x(fraction);
      if (cx <= 8 || cx >= ashEnd - 8) return;
      parts.push(
        <path
          key={`c${i}`}
          d={`M${cx},5 L${cx + 3},${height - 5}`}
          stroke={OG.ink}
          strokeOpacity="0.16"
          strokeWidth="1"
          fill="none"
        />,
      );
      // Every second crack throws a short flake line across the grain.
      if (i % 2 === 0) {
        parts.push(
          <path
            key={`f${i}`}
            d={`M${cx},${height * 0.55} L${Math.min(cx + 16, ashEnd - 3)},${height * 0.5}`}
            stroke={OG.ink}
            strokeOpacity="0.11"
            strokeWidth="1"
            fill="none"
          />,
        );
      }
    });
    // The glow, as two translucent rects: satori has no blur filter.
    parts.push(
      <rect key="glow-wide" x={burnX - 20} y="0" width="38" height={height} fill={OG.ember} fillOpacity="0.28" />,
      <rect key="glow-tight" x={burnX - 13} y="0" width="23" height={height} fill={OG.ember} fillOpacity="0.45" />,
      <rect key="ember" x={burnX - 5} y="0" width="8" height={height} fill={OG.ember} />,
      <rect key="char" x={burnX + 3} y="0" width="4" height={height} fill={OG.ink} fillOpacity="0.78" />,
    );
  }

  // Cylinder shading over everything inside the stick.
  parts.push(<rect key="shade" x="0" y="0" width={width} height={height} fill="url(#cylinder)" />);

  return (
    <svg
      width={width}
      height={height + MARKER_OVERHANG}
      viewBox={`0 0 ${width} ${height + MARKER_OVERHANG}`}
    >
      <defs>
        <clipPath id="stick">
          <path d={body} />
        </clipPath>
        <linearGradient id="cylinder" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={SHADE_HIGHLIGHT} stopOpacity="0.22" />
          <stop offset="0.38" stopColor={SHADE_HIGHLIGHT} stopOpacity="0" />
          <stop offset="0.62" stopColor={SHADE_SHADOW} stopOpacity="0" />
          <stop offset="1" stopColor={SHADE_SHADOW} stopOpacity="0.34" />
        </linearGradient>
      </defs>
      <path d={body} fill={OG.wrapper} />
      <g clipPath="url(#stick)">{parts}</g>
      {/* The stick would dissolve into the orange ground without its own edge. */}
      <path d={body} fill="none" stroke={INK_STICK_OUTLINE} strokeWidth="1" />
      {markers.map((fraction, i) => (
        <circle
          key={`m${i}`}
          cx={x(fraction)}
          cy={height}
          r="6"
          fill={OG.brand}
          stroke={OG.ink}
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}

// The score seal: the rating a smoke carries, or a cigar's journal/critic
// aggregate. Espresso on the orange, never the amber the app's own seal uses —
// amber on this ground is a smudge.
function ScoreSeal({ value, label }: { value: string; label?: string | null }) {
  return (
    <div
      style={{
        position: "absolute",
        right: MARGIN,
        top: 208,
        width: SEAL_SIZE,
        height: SEAL_SIZE,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: SEAL_SIZE / 2,
        border: `2px solid ${INK_SEAL_RING}`,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 3,
          left: 3,
          right: 3,
          bottom: 3,
          borderRadius: SEAL_SIZE / 2,
          border: `1px solid ${INK_SEAL_KEYLINE}`,
        }}
      />
      <div style={{ fontSize: 40, fontWeight: 600, color: OG.ink, lineHeight: 1 }}>{value}</div>
      {/* Tighter than the card's eyebrows: inside a 96px ring the letterspacing
          the headline uses would run the label into the keyline. */}
      {label ? (
        <div style={{ ...eyebrowStyle(14), letterSpacing: "0.08em", marginTop: 4 }}>{label}</div>
      ) : null}
    </div>
  );
}

export interface ShareCardProps {
  eyebrow: string;
  title: string;
  titleSize?: number;
  // A muted line above the title — the cigar card's brand.
  overline?: string | null;
  // A letterspaced line under the title — a smoke's date, a cigar's vitola.
  meta?: string | null;
  seal?: { value: string; label?: string | null } | null;
  // 0–1 along the stick, or null for an unlit cigar.
  burn?: number | null;
  markers?: number[];
}

export function ShareCard({
  eyebrow,
  title,
  titleSize = 64,
  overline,
  meta,
  seal,
  burn = null,
  markers = [],
}: ShareCardProps): ReactElement {
  return (
    <div
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        display: "flex",
        position: "relative",
        backgroundColor: OG.brand,
        fontFamily: OG_FONT_FAMILY,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: FRAME_INSET,
          left: FRAME_INSET,
          right: FRAME_INSET,
          bottom: FRAME_INSET,
          border: `1px solid ${INK_FRAME}`,
        }}
      />

      <div style={{ position: "absolute", top: MARGIN, right: MARGIN, display: "flex" }}>
        {houseSealSvg({
          size: MARK_SIZE,
          brand: OG.brand,
          ink: OG.ink,
          cream: OG.cream,
          ground: "none",
          frame: false,
          inline: true,
        })}
      </div>

      <div
        style={{
          position: "absolute",
          left: MARGIN,
          top: 72,
          width: CARD_WIDTH - MARGIN * 2 - MARK_SIZE - 48,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={eyebrowStyle()}>{eyebrow}</div>
        {overline ? (
          <div style={{ fontSize: 24, color: INK_EYEBROW, marginTop: 26 }}>{overline}</div>
        ) : null}
        <div
          style={{
            display: "flex",
            marginTop: overline ? 8 : 26,
            maxHeight: Math.round(titleSize * 1.1 * 2),
            overflow: "hidden",
            fontSize: titleSize,
            lineHeight: 1.1,
            fontWeight: 600,
            color: OG.ink,
          }}
        >
          {title}
        </div>
        {meta ? <div style={{ ...eyebrowStyle(), marginTop: 26 }}>{meta}</div> : null}
      </div>

      {seal ? <ScoreSeal value={seal.value} label={seal.label} /> : null}

      <div
        style={{
          position: "absolute",
          left: MARGIN,
          bottom: RIBBON_BASELINE - MARKER_OVERHANG,
          display: "flex",
        }}
      >
        {ribbonSvg({ width: RIBBON_WIDTH, burn, markers })}
      </div>
    </div>
  );
}
