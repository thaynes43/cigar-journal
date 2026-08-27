import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

// Advisory-locked migration runner (ADR-003). Applies pending numbered SQL
// files in order on a single session, records them in schema_migrations, and is
// idempotent. Intended as the `migrate` init-container entrypoint (via tsx);
// tests import `migrate()` directly against an embedded Postgres.

// Fixed key for pg_advisory_lock — one migrator runs at a time cluster-wide.
const ADVISORY_LOCK_KEY = 4927710238n;

const DEFAULT_MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

export interface MigrateResult {
  applied: string[];
}

export async function migrate(
  connectionString: string,
  options: { migrationsDir?: string | URL } = {},
): Promise<MigrateResult> {
  const dir = options.migrationsDir
    ? typeof options.migrationsDir === "string"
      ? pathToFileURL(options.migrationsDir + "/")
      : options.migrationsDir
    : DEFAULT_MIGRATIONS_DIR;

  const files = (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    // Session-level lock — held until released or the connection closes.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY.toString()]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id),
    );

    for (const id of files) {
      if (done.has(id)) continue;
      const sql = await readFile(new URL(id, dir), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(id);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY.toString()]).catch(() => {});
    await client.end();
  }
  return { applied };
}

// Direct invocation: `tsx src/scripts/migrate.ts` (reads DATABASE_URL).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(url)
    .then(({ applied }) => {
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "no pending migrations");
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
