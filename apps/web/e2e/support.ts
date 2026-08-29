import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Handoff } from "./seed.js";

// Read the handoff the harness (server.ts) wrote after seeding — the seeded ids,
// account credentials, and known catalog names the specs assert against. Read
// lazily inside a test/hook, never at import time: Playwright collects (imports)
// the spec files before the webServer runs, so the file does not yet exist then.

const HANDOFF_PATH = join(dirname(fileURLToPath(import.meta.url)), ".artifacts", "handoff.json");

export function readHandoff(): Handoff {
  return JSON.parse(readFileSync(HANDOFF_PATH, "utf8")) as Handoff;
}
