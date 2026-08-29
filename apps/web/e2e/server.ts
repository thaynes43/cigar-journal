import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { seed, ALLOWLIST } from "./seed.js";

// The e2e server harness — the single command Playwright's `webServer` runs. It
// boots a throwaway Postgres 16 (embedded-postgres, migrated to head — the same
// rig the domain tests and the local preview use), seeds it through the real
// domain services, writes the storage-state + handoff artifacts the specs read,
// then launches a PRODUCTION `next start` (never `next dev`) on a fixed port with
// the auth env quartet. It stays in the foreground; Playwright polls the health
// URL to know the app is ready and later signals this process to tear the whole
// rig down. A prior `next build` is a prerequisite (the CI job and the local gate
// both build before running e2e).

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = dirname(E2E_DIR);
const ARTIFACTS_DIR = join(E2E_DIR, ".artifacts");

const HOST = "127.0.0.1";
const PORT = Number(process.env.E2E_PORT ?? "3100");
const BASE_URL = `http://${HOST}:${PORT}`;
// A fixed, sufficiently-long secret — the harness DB is thrown away each run, so
// there is nothing to protect; the value only needs to be shared between the
// seed's Better Auth instance and the app it launches (cookie signing).
const SECRET = "e2e-better-auth-secret-value-that-is-plenty-long-0123456789";

let pg: TestPostgres | undefined;
let child: ChildProcess | undefined;
let tearingDown = false;

async function teardown(code = 0): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await pg?.stop().catch(() => {});
  process.exit(code);
}

async function main(): Promise<void> {
  // 1) Real Postgres, migrated to head.
  pg = await startTestPostgres();

  // 2) Seed catalog + accounts + journals; capture the session storage states.
  const { handoff, adminState, nonAdminState } = await seed({
    databaseUrl: pg.url,
    baseURL: BASE_URL,
    secret: SECRET,
  });

  // 3) Write the artifacts the config + specs consume.
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  writeFileSync(join(ARTIFACTS_DIR, "handoff.json"), JSON.stringify(handoff, null, 2));
  writeFileSync(join(ARTIFACTS_DIR, "admin-state.json"), JSON.stringify(adminState));
  writeFileSync(join(ARTIFACTS_DIR, "nonadmin-state.json"), JSON.stringify(nonAdminState));

  // 4) Launch the production server against the seeded DB.
  child = spawn("pnpm", ["exec", "next", "start", "--hostname", HOST, "--port", String(PORT)], {
    cwd: WEB_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: pg.url,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: BASE_URL,
      BOOTSTRAP_ADMIN_EMAILS: ALLOWLIST.join(","),
      PORT: String(PORT),
    },
  });

  // If the app exits on its own, so does the harness — Playwright then reports the
  // webServer as failed rather than hanging.
  child.on("exit", (exitCode) => {
    child = undefined;
    void teardown(exitCode ?? 0);
  });
  child.on("error", (error) => {
    console.error("[e2e] failed to launch next start:", error);
    void teardown(1);
  });
}

process.on("SIGTERM", () => void teardown(0));
process.on("SIGINT", () => void teardown(0));

main().catch((error: unknown) => {
  console.error("[e2e] harness startup failed:", error);
  void teardown(1);
});
