import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { migrate } from "../scripts/migrate.js";
import { createDatabase, type Database } from "../index.js";

// Test harness: a throwaway Postgres 16 instance from the `embedded-postgres`
// binary (no Docker in this environment), migrated to head. Real Postgres —
// citext, pg_trgm, tsvector and gen_random_uuid all behave as in production.

export interface TestPostgres {
  db: Database;
  url: string;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// `freePort` closes its probe socket before Postgres binds, so the port is only
// probably free by the time it is used. With one instance per test FILE, vitest
// running dozens of files in parallel loses that race often enough to be the
// suite's standing flake (a whole file's beforeAll throws and every test in it
// reports skipped). Retrying with a fresh port and data directory costs nothing
// on the happy path and removes the failure class.
const START_ATTEMPTS = 5;

// A throwaway Postgres 16 instance with NO migrations applied — the empty
// substrate. Tests that need to observe a specific migration (e.g. the 0008
// consumption backfill running against pre-seeded rows) migrate a subset
// themselves. Most callers want startTestPostgres (raw + migrate to head).
export async function startRawTestPostgres(): Promise<TestPostgres> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), "cj-pg-"));
    const port = await freePort();
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      port,
      user: "postgres",
      password: "postgres",
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });

    try {
      await pg.initialise();
      await pg.start();
    } catch (error) {
      lastError = error;
      await pg.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      continue;
    }

    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    const { db, pool } = createDatabase(url);
    return {
      db,
      url,
      stop: async () => {
        await pool.end();
        await pg.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  throw new Error(`embedded Postgres did not start after ${START_ATTEMPTS} attempts`, {
    cause: lastError,
  });
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const raw = await startRawTestPostgres();
  await migrate(raw.url);
  return raw;
}
