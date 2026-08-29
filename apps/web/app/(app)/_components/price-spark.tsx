import type { CigarPricePoint } from "@cj/domain";

// The price-history sparkline (DESIGN-002 §Price): a small, honest per-stick line
// over time. Ash-to-ember materials (mirroring burn-line.tsx), never the amber
// accent — the accent is the want mark's alone. The page renders this only past
// the ≥3-observations-over-≥2-distinct-days gate, so the x-axis always spans real
// days and the line is never a fake axis; a flat price honestly sits mid-height.
// Fixed small size (uniform scale), so the markers stay round on any width.

const W = 168;
const H = 40;
const PAD = 5;

export function PriceSpark({ points }: { points: CigarPricePoint[] }) {
  const times = points.map((p) => new Date(p.seenAt).getTime());
  const prices = points.map((p) => p.pricePerStick);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);

  const x = (t: number): number =>
    tMax === tMin ? W / 2 : PAD + ((t - tMin) / (tMax - tMin)) * (W - 2 * PAD);
  // Higher price sits higher (smaller y); a flat series rests at mid-height.
  const y = (p: number): number =>
    pMax === pMin ? H / 2 : H - PAD - ((p - pMin) / (pMax - pMin)) * (H - 2 * PAD);

  const coords = points.map((_, i) => ({ px: x(times[i]!), py: y(prices[i]!), last: i === points.length - 1 }));
  const d = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.px.toFixed(1)} ${c.py.toFixed(1)}`).join(" ");

  return (
    <svg
      role="img"
      aria-label="Per-stick price history"
      viewBox={`0 0 ${W} ${H}`}
      className="h-10 w-auto"
    >
      <defs>
        <linearGradient id="price-spark-stroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--ash)" />
          <stop offset="1" stopColor="var(--ember)" />
        </linearGradient>
      </defs>
      <path d={d} fill="none" stroke="url(#price-spark-stroke)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {coords.map((c, i) => (
        <circle
          key={i}
          cx={c.px}
          cy={c.py}
          r={c.last ? 2.4 : 1.5}
          className={c.last ? "fill-ember" : "fill-ash"}
        />
      ))}
    </svg>
  );
}
