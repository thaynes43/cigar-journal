import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Playwright config for the click-through e2e suite. `webServer` runs the harness
// (server.ts): embedded Postgres + seed + a production `next start` on a fixed
// port; Playwright waits on the health URL before the first spec. Specs are named
// `*.e2e.ts` so Vitest's default `*.{test,spec}` glob never picks them up — e2e
// stays out of `pnpm test`, keeping the 3-check CI contract intact.
//
// Execution is single-worker and serial: every spec shares one Postgres and the
// seeded accounts, so ordering-independent assertions plus one worker is the
// reliable choice over parallel speed. Projects split by identity via storage
// state — anonymous (no cookie, exercises the edge middleware), the seeded admin,
// and the downgraded non-admin.

const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(CONFIG_DIR, ".artifacts");

const HOST = "127.0.0.1";
const PORT = Number(process.env.E2E_PORT ?? "3100");
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: CONFIG_DIR,
  testMatch: "**/*.e2e.ts",
  outputDir: join(ARTIFACTS, "test-results"),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "anon",
      testMatch: "**/anon.*.e2e.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "admin",
      testMatch: "**/admin.*.e2e.ts",
      use: { ...devices["Desktop Chrome"], storageState: join(ARTIFACTS, "admin-state.json") },
    },
    {
      name: "nonadmin",
      testMatch: "**/nonadmin.*.e2e.ts",
      use: { ...devices["Desktop Chrome"], storageState: join(ARTIFACTS, "nonadmin-state.json") },
    },
  ],
  webServer: {
    command: "pnpm exec tsx server.ts",
    cwd: CONFIG_DIR,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
