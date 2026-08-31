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
      // Production is UTF8; initdb under this pod's C locale would otherwise
      // default the cluster to SQL_ASCII, which is not merely a different
      // default but a different SQL dialect: `normalize()` and `U&'\XXXX'`
      // escapes above 007F are rejected outright on a non-UTF8 server, and
      // lower()/length() degrade to per-byte operations on multibyte text. That
      // divergence made migration 0026's accent folding — which runs fine in
      // production — fail in the suite that is supposed to prove it applies.
      // The locale is pinned rather than inherited: an unset LANG here yields C,
      // but CI runners export C.UTF-8, and the two disagree on ordering and on
      // lower(). Pinning gives every machine production's encoding with C
      // collation and ctype — the semantics 0026's slug derivation assumes.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
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

    // Shutting the server down terminates any client the pool still holds, and
    // node-postgres surfaces that as an 'error' event on the POOL. `createDatabase`
    // attaches no listener (production pools outlive the server), and an 'error'
    // event with no listener is an UNHANDLED error — which fails the whole vitest
    // process even though every test passed. That is the standing CI flake (#174):
    // the job printed "66 files / 932 tests passed" and still exited 1 on a single
    // pg 57P01 "terminating connection due to administrator command".
    //
    // The race is inherent to tearing a server down under a live pool, so the fix
    // is to expect it rather than to try to order it away: swallow the shutdown
    // class, and once `stop()` has been entered swallow everything, since nothing
    // a dying server says is a test result. Anything else, at any other time, is
    // still reported — loudly, but without killing an otherwise green run.
    let stopping = false;
    pool.on("error", (error: unknown) => {
      const code = (error as { code?: string } | null)?.code;
      if (stopping || code === "57P01" || code === "ECONNRESET" || code === "EPIPE") return;
      console.error("[embedded-pg] unexpected pool error", error);
    });

    return {
      db,
      url,
      stop: async () => {
        stopping = true;
        await pool.end().catch(() => {});
        await pg.stop().catch(() => {});
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
