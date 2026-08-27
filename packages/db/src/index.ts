import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

type Database = NodePgDatabase<typeof schema>;

let database: Database | undefined;

function connect(): Database {
  if (database) return database;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  database = drizzle(new Pool({ connectionString: url }), { schema });
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

export { schema };
export type { Database };
