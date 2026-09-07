import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// 0040: a drop holds a bounded SET of valid token hashes, not one (ADR-014
// amendment 2026-09-07, issue #316).
//
// The whole risk in this migration is the deploy moment. Every live drop already
// has a link in a user's hand, and that link is only a hash in a column that is
// about to be dropped — so the backfill is the one thing between an existing page
// and a 410. This suite builds the schema up to 0039, seeds the drops a deploy
// would find, applies 0040 alone through the real runner, and then asks the only
// question that matters: does every hash that resolved before still resolve, and
// does it still resolve to the SAME drop?

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Everything before 0040 into `pre`, 0040 alone into `only0040` — the split the
// 0026/0027/0029 suites use: build the schema, seed the state the migration is
// meant to find, then apply the one file under test and watch only what it did.
function splitMigrations(): { pre: string; only0040: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-0040-"));
  const only0040 = mkdtempSync(join(tmpdir(), "cj-mig-0040-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    if (name.startsWith("0040")) copyFileSync(join(MIGRATIONS_DIR, name), join(only0040, name));
    else if (name < "0040") copyFileSync(join(MIGRATIONS_DIR, name), join(pre, name));
  }
  return { pre, only0040 };
}

interface TokenRow {
  photo_drop_id: string;
  token_hash: string;
  // `execute` returns the driver's raw rows, so a timestamptz arrives as text.
  issued_at: string;
}

describe("0040 photo drop tokens", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0040: string };
  let userId: string;
  const dropIds: Record<string, string> = {};

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();
    await migrate(pg.url, { migrationsDir: dirs.pre });

    const user = await pg.db.execute(sql`
      INSERT INTO users (email, display_name) VALUES ('drop-backfill@example.com', 'Drop Backfill')
      RETURNING id
    `);
    userId = (user.rows[0] as { id: string }).id;

    // The three shapes a deploy finds: a drop opened and never re-opened (both
    // stamps equal), one re-opened later (last_opened_at is when its live link was
    // minted, and the one the backfill must carry), and one already claimed by a
    // save — whose link still works until it expires, so it needs its row too.
    for (const [label, hash, created, lastOpened, claimed] of [
      ["fresh", "hash-fresh", "2026-09-06T20:00:00Z", "2026-09-06T20:00:00Z", null],
      ["reopened", "hash-reopened", "2026-09-06T20:00:00Z", "2026-09-06T23:30:00Z", null],
      ["claimed", "hash-claimed", "2026-09-05T20:00:00Z", "2026-09-05T21:00:00Z", "2026-09-05T22:00:00Z"],
    ] as const) {
      const row = await pg.db.execute(sql`
        INSERT INTO photo_drops (user_id, token_hash, expires_at, session_started_at, last_opened_at, created_at, claimed_at)
        VALUES (
          ${userId}, ${hash}, ${"2026-09-08T20:00:00Z"},
          ${created}, ${lastOpened}, ${created}, ${claimed}
        )
        RETURNING id
      `);
      dropIds[label] = (row.rows[0] as { id: string }).id;
    }
  }, 90_000);

  afterAll(async () => {
    await pg?.stop();
    for (const d of Object.values(dirs ?? {})) rmSync(d, { recursive: true, force: true });
  });

  async function tokens(): Promise<TokenRow[]> {
    const rows = await pg.db.execute(sql`
      SELECT photo_drop_id, token_hash, issued_at FROM photo_drop_tokens ORDER BY token_hash
    `);
    return rows.rows as unknown as TokenRow[];
  }

  it("carries every live hash onto its own drop, stamped when that link was minted", async () => {
    await migrate(pg.url, { migrationsDir: dirs.only0040 });

    const rows = await tokens();
    expect(rows.map((r) => r.token_hash)).toEqual(["hash-claimed", "hash-fresh", "hash-reopened"]);
    expect(Object.fromEntries(rows.map((r) => [r.token_hash, r.photo_drop_id]))).toEqual({
      "hash-fresh": dropIds.fresh,
      "hash-reopened": dropIds.reopened,
      "hash-claimed": dropIds.claimed,
    });
    // `last_opened_at`, not `created_at`: the stamp is when the link was minted,
    // which is what the prune orders on from here.
    const stamps = Object.fromEntries(
      rows.map((r) => [r.token_hash, new Date(r.issued_at).getTime()]),
    );
    expect(stamps["hash-fresh"]).toBe(Date.parse("2026-09-06T20:00:00Z"));
    expect(stamps["hash-reopened"]).toBe(Date.parse("2026-09-06T23:30:00Z"));
    expect(stamps["hash-claimed"]).toBe(Date.parse("2026-09-05T21:00:00Z"));
  });

  it("drops the column the hash used to live in, so there is one place to read", async () => {
    const cols = await pg.db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'photo_drops'
    `);
    expect(cols.rows.map((r) => r.column_name)).not.toContain("token_hash");
  });

  it("keeps a hash resolving to exactly one drop, and takes the rows with the drop", async () => {
    // The UNIQUE is what makes a token an identity rather than a hint.
    await expect(
      pg.db.execute(sql`
        INSERT INTO photo_drop_tokens (photo_drop_id, token_hash) VALUES (${dropIds.fresh}, 'hash-claimed')
      `),
    ).rejects.toThrow();

    // Cascade: expiry, deletion and the retention sweep all delete the drop, and
    // no link of it may outlive that.
    await pg.db.execute(sql`DELETE FROM photo_drops WHERE id = ${dropIds.claimed}`);
    expect((await tokens()).map((r) => r.token_hash)).toEqual(["hash-fresh", "hash-reopened"]);
  });
});
