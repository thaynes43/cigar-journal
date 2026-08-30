import type { CigarType } from "@cj/domain";

// The no-image cigar identity mark (DESIGN-001): a band-like monogram on a
// wrapper-shade ground. Identity derives from the canonical name alone so the
// same cigar gets the same tile on every surface, and the ground is hashed
// from the leading word (≈ the house) so a brand keeps its color across
// lines. The outer box reserves its aspect ratio; when catalog art lands it
// fades in absolutely positioned over the tile with zero layout shift.

const RAMP_STOPS = 8;

// djb2 — stable across runtimes, no dependency.
function hash(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (h * 33) ^ seed.charCodeAt(i);
  return h >>> 0;
}

function letterWords(name: string): string[] {
  return name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ""))
    .filter(Boolean);
}

export function bandStop(name: string): number {
  const house = letterWords(name)[0] ?? name.trim();
  return (hash(house.toLowerCase()) % RAMP_STOPS) + 1;
}

export function monogram(name: string): string {
  const initials = letterWords(name)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return initials || name.trim().slice(0, 1).toUpperCase();
}

export type BandTileSize = "thumb" | "card" | "hero";

// "self": the tile owns its aspect box (the size table below). "fill": the tile
// fills a parent-provided aspect box (a poster 2:3 or still 16:9 frame), so the
// same ground + monogram art serves any ratio without forking the palette.
export type BandTileShape = "self" | "fill";

const BOX: Record<BandTileSize, string> = {
  thumb: "size-12 shrink-0",
  card: "aspect-[4/3] w-full",
  hero: "aspect-[4/3] w-full",
};

const RING: Record<BandTileSize, string> = {
  thumb: "size-9 border",
  card: "size-20 border",
  hero: "size-24 border-2",
};

const LETTERS: Record<BandTileSize, string> = {
  thumb: "text-sm",
  card: "text-2xl",
  hero: "text-3xl",
};

export function BandTile({
  name,
  vitola,
  type,
  size = "card",
  shape = "self",
}: {
  name: string;
  vitola?: string | null;
  type?: CigarType | null;
  size?: BandTileSize;
  shape?: BandTileShape;
}) {
  const stop = bandStop(name);
  const footer = [vitola, type].filter(Boolean).join(" · ");
  // A filled tile is pure art inside a framed parent — no footer, no own box.
  const showFooter = shape === "self" && size !== "thumb" && footer.length > 0;
  // A self-shaped tile carries its own hairline edge. Without it a dark stop on
  // the espresso ground has no boundary at all — the journal thumb and the
  // detail hero read as holes rather than objects (issue #49). Every `fill`
  // call site frames the tile in `border border-line` already, so a filled tile
  // stays edgeless rather than doubling the rule.
  const box =
    shape === "fill" ? "h-full w-full" : `rounded-tile border border-line ${BOX[size]}`;

  return (
    <div
      aria-hidden
      className={`relative overflow-hidden ${box}`}
      style={{ background: `var(--tobacco-${stop})`, color: `var(--tobacco-${stop}-ink)` }}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        <span
          className={`relative flex items-center justify-center rounded-full border-current/60 ${RING[size]}`}
        >
          {size !== "thumb" ? (
            <span className="absolute inset-1 rounded-full border border-current/40" />
          ) : null}
          <span className={`font-display font-semibold tracking-wide ${LETTERS[size]}`}>
            {monogram(name)}
          </span>
        </span>
        {showFooter ? (
          <span className="px-2 text-center text-[0.6875rem] font-semibold tracking-[0.14em] uppercase opacity-85">
            {footer}
          </span>
        ) : null}
      </div>
    </div>
  );
}
