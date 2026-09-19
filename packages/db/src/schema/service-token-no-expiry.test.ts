import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// 0041: `oauth_access_token.expires_at` becomes nullable, where NULL means "no
// expiry — valid until revoked" (ADR-011 amendment, owner ruling 2026-09-19).
//
// The risk is the deploy moment, and it is a DDL risk rather than a data one:
// the table already holds live credentials, and a CHECK added over them fails
// the whole migration — and therefore the migrate init container, and therefore
// the rollout — if a single existing row violates it. This suite builds the
// schema to 0040, seeds the three shapes a deploy finds (a flow-issued token in
// a refresh family, an operator-minted one with no family, an already-expired
// one), applies 0041 alone through the real runner, and asks what the column now
// admits and what it still refuses.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

function splitMigrations(): { pre: string; only0041: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-0041-"));
  const only0041 = mkdtempSync(join(tmpdir(), "cj-mig-0041-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    if (name.startsWith("0041")) copyFileSync(join(MIGRATIONS_DIR, name), join(only0041, name));
    else if (name < "0041") copyFileSync(join(MIGRATIONS_DIR, name), join(pre, name));
  }
  return { pre, only0041 };
}

const RESOURCE = "https://cigars.example.com/mcp";
const FAMILY = "11111111-1111-4111-8111-111111111111";

describe("0041 service tokens with no expiry", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0041: string };
  let userId: string;
  const tokenIds: Record<string, string> = {};

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();
    await migrate(pg.url, { migrationsDir: dirs.pre });

    const user = await pg.db.execute(sql`
      INSERT INTO users (email, display_name) VALUES ('no-expiry@example.com', 'No Expiry')
      RETURNING id
    `);
    userId = (user.rows[0] as { id: string }).id;
    await pg.db.execute(sql`
      INSERT INTO oauth_client (client_id, client_name, redirect_uris, grant_types, response_types)
      VALUES ('client-0041', 'pre-existing', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
    `);

    // Every row a deploy finds has a date — the column was NOT NULL until now —
    // so the CHECK must pass over all three regardless of their family.
    for (const [label, hash, family, expires] of [
      ["flow", "hash-flow", FAMILY, "2026-12-01T00:00:00Z"],
      ["minted", "hash-minted", null, "2027-09-19T00:00:00Z"],
      ["expired", "hash-expired", null, "2026-01-01T00:00:00Z"],
    ] as const) {
      const row = await pg.db.execute(sql`
        INSERT INTO oauth_access_token (token_hash, family_id, client_id, user_id, scopes, resource, expires_at)
        VALUES (${hash}, ${family}, 'client-0041', ${userId}, '["journal:read"]'::jsonb, ${RESOURCE}, ${expires})
        RETURNING id
      `);
      tokenIds[label] = (row.rows[0] as { id: string }).id;
    }
  }, 90_000);

  afterAll(async () => {
    await pg?.stop();
    for (const d of Object.values(dirs ?? {})) rmSync(d, { recursive: true, force: true });
  });

  it("applies over a table that already holds live tokens, changing none of them", async () => {
    await migrate(pg.url, { migrationsDir: dirs.only0041 });

    const rows = await pg.db.execute(sql`
      SELECT token_hash, expires_at FROM oauth_access_token ORDER BY token_hash
    `);
    expect(rows.rows.map((r) => r.token_hash)).toEqual([
      "hash-expired",
      "hash-flow",
      "hash-minted",
    ]);
    // No backfill and no default: a dated token keeps its date, and the expired
    // one stays expired rather than being quietly promoted to immortal.
    expect(rows.rows.every((r) => r.expires_at !== null)).toBe(true);

    const column = await pg.db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'oauth_access_token' AND column_name = 'expires_at'
    `);
    expect(column.rows[0]!.is_nullable).toBe("YES");
  });

  it("admits a no-expiry row only when it belongs to no refresh family", async () => {
    await pg.db.execute(sql`
      INSERT INTO oauth_access_token (token_hash, family_id, client_id, user_id, scopes, resource, expires_at)
      VALUES ('hash-immortal', NULL, 'client-0041', ${userId}, '["journal:write"]'::jsonb, ${RESOURCE}, NULL)
    `);
    const row = await pg.db.execute(
      sql`SELECT expires_at FROM oauth_access_token WHERE token_hash = 'hash-immortal'`,
    );
    expect(row.rows[0]!.expires_at).toBeNull();

    // The future mistake the CHECK forecloses: a refresh rotation that dropped
    // the expiry would mint an immortal token from inside a grant, which is the
    // one credential this system does not issue. Both directions are refused —
    // inserting such a row, and turning an existing family row into one.
    // (Drizzle wraps the driver error; the constraint name rides on the cause.)
    const refused = async (query: Promise<unknown>): Promise<string | undefined> => {
      const error = await query.catch((e: unknown) => e);
      return (error as { cause?: { constraint?: string } }).cause?.constraint;
    };

    expect(
      await refused(
        pg.db.execute(sql`
          INSERT INTO oauth_access_token (token_hash, family_id, client_id, user_id, scopes, resource, expires_at)
          VALUES ('hash-bad', ${FAMILY}, 'client-0041', ${userId}, '["journal:read"]'::jsonb, ${RESOURCE}, NULL)
        `),
      ),
    ).toBe("oauth_access_token_no_expiry_shape");
    expect(
      await refused(
        pg.db.execute(
          sql`UPDATE oauth_access_token SET expires_at = NULL WHERE id = ${tokenIds.flow}`,
        ),
      ),
    ).toBe("oauth_access_token_no_expiry_shape");
  });

  it("leaves the other token tables requiring an expiry", async () => {
    // Authorization codes, refresh tokens and authorization transactions are each
    // a step in a flow that must time out; none is ever operator-minted.
    const rows = await pg.db.execute(sql`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE column_name = 'expires_at'
        AND table_name IN ('oauth_authorization', 'oauth_authorization_code', 'oauth_refresh_token')
      ORDER BY table_name
    `);
    expect(rows.rows.map((r) => r.is_nullable)).toEqual(["NO", "NO", "NO"]);
  });
});
