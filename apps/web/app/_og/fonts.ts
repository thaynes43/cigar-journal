import { readFile } from "node:fs/promises";
import { join } from "node:path";

// satori rasterizes with a font BUFFER — it has no access to system fonts, and
// the app's serif stack ("Iowan Old Style", Palatino, …) is a list of faces that
// only exist on a reader's machine. So the cards ship their own face: Source
// Serif 4 (Adobe, SIL OFL 1.1 — the license travels with it in app/_fonts/).
//
// Read from disk at module scope, once per server process, and shared by the
// three OG routes; the promise is created on import so the first card does not
// pay for it twice under concurrency. Never fetched at runtime: a card must not
// depend on fonts.googleapis.com being reachable from the cluster.
//
// `process.cwd()` is apps/web in dev, under `next start`, and in the standalone
// server (its generated entrypoint chdirs to its own directory). next.config.ts
// carries an `outputFileTracingIncludes` entry so the files are copied into the
// standalone output — nothing in the bundle references them statically.

const FONT_DIR = join(process.cwd(), "app", "_fonts");

async function load() {
  const [regular, semibold] = await Promise.all([
    readFile(join(FONT_DIR, "SourceSerif4-Regular.ttf")),
    readFile(join(FONT_DIR, "SourceSerif4-Semibold.ttf")),
  ]);
  return [
    { name: "Source Serif 4", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Source Serif 4", data: semibold, weight: 600 as const, style: "normal" as const },
  ];
}

const fonts = load();

export const OG_FONT_FAMILY = "Source Serif 4";

export function ogFonts() {
  return fonts;
}
