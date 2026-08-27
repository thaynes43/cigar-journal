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

export async function startTestPostgres(): Promise<TestPostgres> {
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
  await pg.initialise();
  await pg.start();
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  await migrate(url);
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
