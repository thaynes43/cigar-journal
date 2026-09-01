import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

type Database = NodePgDatabase<typeof schema>;

let database: Database | undefined;

function connect(): Database {
  if (database) return database;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url });

  // A server that goes away terminates the clients this pool still holds, and
  // node-postgres surfaces that as an 'error' event on the POOL — which, with no
  // listener attached, is an UNHANDLED error that takes the whole process down.
  // The embedded-pg harness guards its own pool this way; the ambient singleton
  // needs it too, because five test files point DATABASE_URL at that embedded
  // server and then rely on teardown *ordering* ($client.end() before pg.stop())
  // to keep the FATAL from ever arriving. Losing that race is the residual half
  // of the standing CI flake (#174): a run reported 1831/1831 passed and still
  // exited 1 on a pg 57P01 "terminating connection due to administrator command".
  //
  // The race is inherent to a pool outliving its server, so expect it rather than
  // order it away: swallow the shutdown class, and report anything else — loudly,
  // but without killing a process whose work was otherwise fine.
  pool.on("error", (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    if (code === "57P01" || code === "ECONNRESET" || code === "EPIPE") return;
    console.error("[db] unexpected pool error", error);
  });

  database = drizzle(pool, { schema });
  return database;
}

// Lazy client (ADR-003 / house pattern): importing this module never opens a
// connection. The pool is created — and DATABASE_URL read — on first property
// access, so build-time imports and tests stay connection-free.
export const db: Database = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(connect(), property, receiver) as unknown;
  },
});

// Explicit client over a given connection string, with its own pool. Used by
// the migrate runner and tests, where the ambient DATABASE_URL singleton is the
// wrong lifecycle. Callers own `pool.end()`.
export function createDatabase(connectionString: string): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}

export { schema, Pool };
export type { Database };

// Re-export the tables and their row/value types so consumers have one import
// surface (`@cj/db`) for both the client and the schema.
export * from "./schema/index.js";
