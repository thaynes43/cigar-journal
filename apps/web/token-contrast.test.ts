import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The measured half of the token contract (DESIGN-001 amendment, issue #49).
// `design-tokens.test.ts` pins that components only ever *reference* tokens;
// this file pins that the token VALUES clear the criteria the amendment records,
// so a future palette edit that reintroduces an invisible tile or an unreadable
// chip fails here rather than at the owner's walkthrough.
//
// Before the retune the live values failed three of these outright: stop 8 sat
// at 1.25:1 on the dark card (a hole, not a tile), stops 4 and 5 carried 3.94:1
// and 4.43:1 monogram ink, and the ramp's worst adjacent pair was ΔE 8.8.
//
// A theme-constant stop's paper contrast and its espresso contrast are zero sum,
// so "every stop improves in both themes" is unreachable and the floors below
// are deliberately asymmetric. `PREVIOUS` pins what the palette this one
// replaced actually measured, and the regression suite asserts that each theme's
// WORST stop, the worst ink and the worst separation all move the right way —
// the check that was missing when an earlier revision of this branch raised the
// espresso floor by dropping the paper floor from 1.90:1 to 1.67:1.

const CSS = readFileSync(fileURLToPath(new URL("./app/globals.css", import.meta.url)), "utf8");

// --- token resolution ------------------------------------------------------
// Only the `:root` declaration block is read; `light-dark(a, b)` splits into the
// two themes exactly as the browser resolves it under `color-scheme`.
const ROOT = /:root\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";
const DECLS = new Map<string, string>();
for (const match of ROOT.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
  DECLS.set(match[1]!, match[2]!.trim());
}

type Theme = "light" | "dark";

function resolve(name: string, theme: Theme): string {
  const raw = DECLS.get(name);
  if (raw === undefined) throw new Error(`globals.css declares no ${name}`);
  const lightDark = /^light-dark\(\s*(.+?)\s*,\s*(.+?)\s*\)$/.exec(raw);
  if (lightDark) return resolveValue(lightDark[theme === "light" ? 1 : 2]!, theme);
  return resolveValue(raw, theme);
}

function resolveValue(value: string, theme: Theme): string {
  const varRef = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (varRef) return resolve(varRef[1]!, theme);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`unresolvable token value: ${value}`);
  return value.toLowerCase();
}

// --- colour math (sRGB → relative luminance, sRGB → CIELAB) ----------------
const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const D65 = [0.95047, 1, 1.08883];
const fLab = (v: number): number => (v > 216 / 24389 ? Math.cbrt(v) : (841 / 108) * v + 4 / 29);

function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  const xyz = [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  ].map((v, i) => fLab(v / D65[i]!)) as [number, number, number];
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

// CIE76 — coarse next to CIEDE2000, but it is the metric the amendment's
// numbers were measured with, and the criteria are stated in its units.
function deltaE(a: string, b: string): number {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// Polar Lab — chroma and hue are how the ramp's "one ordered leaf family" reads,
// and hue is what turns an oscuro brown into burgundy.
function lch(hex: string): [number, number, number] {
  const [l, a, b] = lab(hex);
  return [l, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

const THEMES: Theme[] = ["light", "dark"];
const STOPS = [1, 2, 3, 4, 5, 6, 7, 8];
const GROUNDS = ["--bg", "--surface"];

// Floors for a decorative art box that must still read as an object on the page
// ground. Not WCAG figures — the arithmetic ceiling for a theme-constant stop
// against BOTH grounds at once is 3.90:1, and a ramp that spans a usable range
// sits far below it — so BandTile also paints its own hairline edge; this keeps
// the art from dissolving between the edges. The two floors differ because the
// grounds do: warm paper is L* 94 and espresso L* 8, so the same stop is never
// equally safe on both, and each floor is set at what this ramp actually
// reaches. Raising either one lowers the other.
const PAPER_FLOOR = 2.1;
const ESPRESSO_FLOOR = 1.6;
const GROUND_FLOOR: Record<Theme, number> = { light: PAPER_FLOOR, dark: ESPRESSO_FLOOR };
// Monogram and the `vitola · type` footer are read as text: full text contrast.
const INK_FLOOR = 4.5;
// What a muted wrapper-shade family admits once the floors above are held. The
// ink criterion carves the ramp into two disjoint bands (L* ≥ 56.8 dark-ink,
// L* ≤ 44.2 light-ink) and the paper floor caps the top at L* 66.5, leaving the
// dark-ink band ~10 L* wide for four stops — so separation there is carried by
// hue, and ΔE tops out near 10 for a ramp that still reads as one ordered leaf
// family. ΔE 11 is reachable only by widening past the paper floor and swinging
// the oscuro end to burgundy; both were built, measured and rejected. Evidence
// is on the PR for issue #49.
const ADJACENT_DELTA_E = 9.5;
const ALL_PAIRS_DELTA_E = 9.5;
const CHIP_FLOOR = 1.5;
const MATERIAL_DELTA_E = 20;

describe("tobacco ramp", () => {
  it.each(THEMES.flatMap((t) => GROUNDS.map((g) => [t, g] as const)))(
    "every stop stays visible against %s %s",
    (theme, ground) => {
      const behind = resolve(ground, theme);
      for (const stop of STOPS) {
        const ratio = contrast(resolve(`--tobacco-${stop}`, theme), behind);
        expect(ratio, `--tobacco-${stop} on ${ground}`).toBeGreaterThanOrEqual(
          GROUND_FLOOR[theme],
        );
      }
    },
  );

  it.each(STOPS)("stop %i carries its monogram ink at text contrast", (stop) => {
    // The ramp is theme-constant, so one side resolves both.
    const tile = resolve(`--tobacco-${stop}`, "dark");
    const ink = resolve(`--tobacco-${stop}-ink`, "dark");
    expect(contrast(tile, ink)).toBeGreaterThanOrEqual(INK_FLOOR);
  });

  it("pairs each stop with the only ink that clears text contrast", () => {
    // The 1–4 / 5–8 split is arithmetic, not convention: assert no stop could
    // have taken the other ink, so a retune cannot silently keep a stale pairing.
    const inks = { dark: resolve("--tobacco-ink-dark", "dark"), light: resolve("--tobacco-ink-light", "dark") };
    for (const stop of STOPS) {
      const tile = resolve(`--tobacco-${stop}`, "dark");
      const clearing = Object.values(inks).filter((ink) => contrast(tile, ink) >= INK_FLOOR);
      expect(clearing, `--tobacco-${stop} should clear exactly one ink`).toHaveLength(1);
      expect(resolve(`--tobacco-${stop}-ink`, "dark")).toBe(clearing[0]);
    }
  });

  it("keeps adjacent stops apart", () => {
    for (let stop = 1; stop < 8; stop++) {
      const gap = deltaE(resolve(`--tobacco-${stop}`, "dark"), resolve(`--tobacco-${stop + 1}`, "dark"));
      expect(gap, `ΔE ${stop}→${stop + 1}`).toBeGreaterThanOrEqual(ADJACENT_DELTA_E);
    }
  });

  it("keeps every pair of stops apart", () => {
    for (let a = 1; a <= 8; a++) {
      for (let b = a + 1; b <= 8; b++) {
        const gap = deltaE(resolve(`--tobacco-${a}`, "dark"), resolve(`--tobacco-${b}`, "dark"));
        expect(gap, `ΔE ${a}↔${b}`).toBeGreaterThanOrEqual(ALL_PAIRS_DELTA_E);
      }
    }
  });

  it("is theme-constant — a tile is an object, not chrome", () => {
    for (const stop of STOPS) {
      expect(resolve(`--tobacco-${stop}`, "light")).toBe(resolve(`--tobacco-${stop}`, "dark"));
    }
  });
});

describe("descriptor chip", () => {
  it.each(THEMES.flatMap((t) => GROUNDS.map((g) => [t, g] as const)))(
    "reads as a filled object against %s %s",
    (theme, ground) => {
      expect(contrast(resolve("--chip", theme), resolve(ground, theme))).toBeGreaterThanOrEqual(
        CHIP_FLOOR,
      );
    },
  );

  it.each(THEMES)("keeps its label at text contrast in %s", (theme) => {
    expect(contrast(resolve("--chip", theme), resolve("--chip-ink", theme))).toBeGreaterThanOrEqual(
      INK_FLOOR,
    );
  });

  it.each(THEMES)("stays distinct from the raised surface in %s", (theme) => {
    // The filled tier used to be byte-identical to `--raised` on paper, which is
    // why the two chip tiers collapsed into one object.
    expect(resolve("--chip", theme)).not.toBe(resolve("--raised", theme));
  });
});

describe("burn-line materials", () => {
  // `--wrapper-leaf` is a ramp stop, so retuning the ramp restyles the burn-line
  // rail. The unsmoked leaf must stay separable from both ends of the ash→ember
  // gradient burnt across it, or the signature element regresses while tiles improve.
  it.each(THEMES)("keeps unsmoked leaf apart from ash and ember in %s", (theme) => {
    const leaf = resolve("--wrapper-leaf", theme);
    expect(deltaE(leaf, resolve("--ash", theme)), "leaf vs ash").toBeGreaterThanOrEqual(
      MATERIAL_DELTA_E,
    );
    expect(deltaE(leaf, resolve("--ember", theme)), "leaf vs ember").toBeGreaterThanOrEqual(
      MATERIAL_DELTA_E,
    );
  });
});

// --- no-regression guard ---------------------------------------------------
// The palette this ramp replaced, byte-for-byte off `main` at 122d8fa. A retune
// is allowed to trade individual stops — it has to, the two themes are zero sum
// — but it may not make any theme's worst stop, the worst ink, or the worst
// separation worse than what it replaced. Without this, "the dark theme got
// better" hides "the light theme got worse".
const PREVIOUS = [
  "#98995f",
  "#c9aa70",
  "#b78f5c",
  "#a1764a",
  "#8a613b",
  "#6f4a2c",
  "#573722",
  "#3e2517",
];

const worstGround = (ramp: string[], theme: Theme): number =>
  Math.min(...ramp.flatMap((hex) => GROUNDS.map((g) => contrast(hex, resolve(g, theme)))));
const worstInk = (ramp: string[]): number =>
  Math.min(
    ...ramp.map((hex, i) =>
      contrast(hex, resolve(i < 4 ? "--tobacco-ink-dark" : "--tobacco-ink-light", "dark")),
    ),
  );
const worstAdjacent = (ramp: string[]): number =>
  Math.min(...ramp.slice(0, -1).map((hex, i) => deltaE(hex, ramp[i + 1]!)));

describe("tobacco ramp vs the palette it replaced", () => {
  const current = STOPS.map((stop) => resolve(`--tobacco-${stop}`, "dark"));

  it.each(THEMES)("does not lower %s's worst stop against its grounds", (theme) => {
    expect(worstGround(current, theme)).toBeGreaterThanOrEqual(worstGround(PREVIOUS, theme));
  });

  it("does not lower the worst monogram-ink contrast", () => {
    expect(worstInk(current)).toBeGreaterThanOrEqual(worstInk(PREVIOUS));
  });

  it("does not lower the worst adjacent separation", () => {
    expect(worstAdjacent(current)).toBeGreaterThanOrEqual(worstAdjacent(PREVIOUS));
  });

  it("keeps the oscuro end in the chocolate family", () => {
    // Deviation 1 rejected a hue sweep for turning stops 7–8 burgundy, and an
    // earlier revision of this branch shipped that artifact anyway at hue 38°
    // with chroma 31. Pin the family: no more than a few degrees off what the
    // previous palette read, at no more chroma.
    for (const stop of [7, 8]) {
      const [, chroma, hue] = lch(resolve(`--tobacco-${stop}`, "dark"));
      const [, wasChroma, wasHue] = lch(PREVIOUS[stop - 1]!);
      expect(hue, `--tobacco-${stop} hue`).toBeGreaterThan(wasHue - 6);
      expect(chroma, `--tobacco-${stop} chroma`).toBeLessThanOrEqual(wasChroma + 2);
    }
  });
});
