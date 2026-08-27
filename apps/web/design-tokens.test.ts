import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Token contract (DESIGN-001): globals.css is the only file allowed raw color
// values. Components style through semantic tokens, so no hex literal and no
// stock Tailwind palette class may appear in the component tree.

const webRoot = fileURLToPath(new URL(".", import.meta.url));

function componentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return componentFiles(full);
    return full.endsWith(".tsx") && !full.endsWith(".test.tsx") ? [full] : [];
  });
}

const files = [...componentFiles(join(webRoot, "app")), join(webRoot, "lib", "ui.ts")];

describe("token contract", () => {
  it("finds the component tree", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f.slice(webRoot.length), f]))("%s has no raw colors", (_rel, file) => {
    const source = readFileSync(file as string, "utf8");
    expect(source).not.toMatch(/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/);
    expect(source).not.toMatch(
      /\b(?:bg|text|border|ring|divide|outline|fill|stroke)-(?:neutral|gray|zinc|stone|slate|red|amber|white|black)(?:-\d+)?\b/,
    );
  });
});
