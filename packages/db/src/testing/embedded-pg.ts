import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { migrate } from "../scripts/migrate.js";
import { createDatabase, swallowShutdownErrors, type Database } from "../index.js";

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

// How long a cluster gets to answer SIGINT before it is taken by force. Generous,
// because a loaded runner shutting down thirty Postgres instances at once is slow
// and killing a healthy one early would leave a half-written data directory.
const STOP_TIMEOUT_MS = 20_000;

// Only what `stopSafely` needs, so its own test can hand it a stub. `process` is
// `private` on EmbeddedPostgres, hence the cast at the call sites: reading a
// child's exit state is the whole fix, and there is no public accessor for it.
export interface StoppableCluster {
  stop: () => Promise<void>;
  process?: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
}

// `EmbeddedPostgres.stop()` CAN NEVER RETURN once its child is already gone.
//
// It waits on an 'exit' event that it registers AFTER sending SIGINT — and on a
// ChildProcess that has already exited, that event has fired and will not fire
// again, so the promise never settles. The retry path below reaches exactly that
// state: `start()` rejects from its own `close` handler, which means the process
// is gone by definition. A `beforeAll` that loses the port race then hangs on the
// cleanup rather than retrying, and reports the whole FILE as failed at vitest's
// 60 s hook timeout — the flake seen on
// apps/web/app/api/photos/[id]/thumb/route.test.ts.
//
// So ask the child before waiting on it, and bound the wait either way: a cluster
// that will not answer SIGINT must not hold a hook open either. Exported for its
// own test.
export async function stopSafely(
  cluster: StoppableCluster,
  timeoutMs: number = STOP_TIMEOUT_MS,
): Promise<void> {
  const child = cluster.process;
  // Never started, or already dead: there is nothing to wait for, and waiting is
  // the bug.
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    cluster.stop().then(
      () => false,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) child.kill("SIGKILL");
}

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
      // `start()` rejects with NO argument — its `close` handler calls a bare
      // `reject()` — so the honest report of a lost port race is a message this
      // harness writes, not the `undefined` the library hands over.
      lastError =
        error ??
        new Error(`embedded Postgres exited before it was ready (port ${port} was probably taken)`);
      await stopSafely(pg as unknown as StoppableCluster);
      rmSync(dir, { recursive: true, force: true });
      continue;
    }

    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    const { db, pool } = createDatabase(url);

    // Shutting the server down terminates any connection the pool still holds, and
    // node-postgres surfaces that as an 'error' EVENT — on the pool for an idle
    // client, on the CLIENT ITSELF for one that is checked out. An 'error' event
    // with no listener is an UNHANDLED error, which fails the whole vitest process
    // even though every test passed. That is the standing CI flake (#174): the job
    // printed "66 files / 932 tests passed" and still exited 1 on a single pg 57P01
    // "terminating connection due to administrator command".
    //
    // The race is inherent to tearing a server down under a live pool, so the fix
    // is to expect it rather than to try to order it away: swallow the shutdown
    // class on both surfaces (pool-errors.ts), and once `stop()` has been entered
    // swallow everything, since nothing a dying server says is a test result.
    // Anything else, at any other time, is still reported — loudly, but without
    // killing an otherwise green run.
    let stopping = false;
    swallowShutdownErrors(pool, { label: "embedded-pg", isTearingDown: () => stopping });

    return {
      db,
      url,
      stop: async () => {
        stopping = true;
        await pool.end().catch(() => {});
        // Not `pg.stop()`: a server that died on its own during the file — OOM,
        // a crashed backend — would otherwise hang this hook to its timeout and
        // report a passing file as failed.
        await stopSafely(pg as unknown as StoppableCluster);
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
