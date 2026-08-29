import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";
import { users, cigars, purchases, smokes, smokeConsumptions } from "./index.js";

// The 0008 backfill (ADR-008) must run against pre-existing smokes/purchases, so
// this test migrates everything BEFORE 0008, seeds rows the retired heuristic
// would and would not have deducted, then applies 0008 alone and asserts the
// seeded consumption rows — flagged `heuristic-backfill`, one per qualifying
// smoke, none for pre-purchase or off-humidor smokes — and its idempotency.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Copy the numbered migrations into two temp dirs: everything before 0008, and
// 0008 by itself — so the runner applies the pre-0008 schema, we seed, then apply
// only the consumption migration and observe its backfill in isolation.
function splitMigrations(): { pre: string; only0008: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-"));
  const only0008 = mkdtempSync(join(tmpdir(), "cj-mig-0008-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    const dest = name.startsWith("0008") ? only0008 : name < "0008" ? pre : null;
    if (dest) copyFileSync(join(MIGRATIONS_DIR, name), join(dest, name));
  }
  return { pre, only0008 };
}

describe("0008 consumption backfill", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0008: string };
  const userId = "00000000-0000-0000-0000-0000000000a1";
  let cigarX: string;
  let cigarY: string;
  let cigarZ: string;
  let smokePre: string; // pre-purchase → excluded
  let smokePost: string; // post-purchase → included
  let smokeNull: string; // null-dated → included
  let smokeOff: string; // cigar never purchased → excluded

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();

    // 1. Everything up to (but not including) the consumption migration.
    await migrate(pg.url, { migrationsDir: dirs.pre });

    // 2. Seed the substrate the heuristic used to read.
    await pg.db.insert(users).values({ id: userId, email: "backfill@example.com" });
    [cigarX, cigarY, cigarZ] = await Promise.all([
      pg.db.insert(cigars).values({ canonicalName: "Backfill X" }).returning({ id: cigars.id }).then((r) => r[0]!.id),
      pg.db.insert(cigars).values({ canonicalName: "Backfill Y" }).returning({ id: cigars.id }).then((r) => r[0]!.id),
      pg.db.insert(cigars).values({ canonicalName: "Backfill Z" }).returning({ id: cigars.id }).then((r) => r[0]!.id),
    ]);

    // cigarX: bought 2026-03-01. cigarZ: bought but with no purchase date.
    // cigarY: never purchased (an off-humidor smoke).
    await pg.db.insert(purchases).values({ userId, cigarId: cigarX, purchasedAt: "2026-03-01", quantity: 3 });
    await pg.db.insert(purchases).values({ userId, cigarId: cigarZ, quantity: 2 });

    const mkSmoke = async (cigarId: string, smokedAt: Date | null): Promise<string> => {
      const [row] = await pg.db
        .insert(smokes)
        .values({ userId, cigarId, smokedAt, provenanceSource: "manual" })
        .returning({ id: smokes.id });
      return row!.id;
    };
    smokePre = await mkSmoke(cigarX, new Date("2026-02-01T00:00:00Z")); // before first purchase
    smokePost = await mkSmoke(cigarX, new Date("2026-04-01T00:00:00Z")); // after
    smokeNull = await mkSmoke(cigarX, null); // no time → counts
    smokeOff = await mkSmoke(cigarY, new Date("2026-01-01T00:00:00Z")); // never bought
    // cigarZ bought with a null purchase date → first_purchase IS NULL → include.
    await mkSmoke(cigarZ, new Date("2026-01-01T00:00:00Z"));

    // 3. Apply the consumption migration (table + backfill) on its own.
    await migrate(pg.url, { migrationsDir: dirs.only0008 });
  }, 90_000);

  afterAll(async () => {
    await pg?.stop();
    for (const d of Object.values(dirs ?? {})) rmSync(d, { recursive: true, force: true });
  });

  it("seeds one heuristic-backfill row per qualifying smoke, none for pre-purchase or off-humidor", async () => {
    const rows = await pg.db.select().from(smokeConsumptions);
    const seededSmokeIds = new Set(rows.map((r) => r.smokeId));

    // 3 qualifying smokes: post-purchase, null-dated, and the null-purchase-date lot.
    expect(rows).toHaveLength(3);
    expect(seededSmokeIds.has(smokePost)).toBe(true);
    expect(seededSmokeIds.has(smokeNull)).toBe(true);
    // Excluded: smoked before the first purchase, and a cigar never purchased.
    expect(seededSmokeIds.has(smokePre)).toBe(false);
    expect(seededSmokeIds.has(smokeOff)).toBe(false);

    // Every seeded row is flagged for curation and carries no lot attribution.
    for (const r of rows) {
      expect(r.source).toBe("heuristic-backfill");
      expect(r.purchaseId).toBeNull();
    }
  });

  it("is idempotent: re-running the migration and replaying the backfill INSERT add nothing", async () => {
    // Runner-level: 0008 is already recorded, so a re-run applies nothing.
    const rerun = await migrate(pg.url, { migrationsDir: dirs.only0008 });
    expect(rerun.applied).toEqual([]);

    // SQL-level: replaying the backfill INSERT itself is a no-op (ON CONFLICT).
    const content = readFileSync(join(dirs.only0008, "0008_smoke_consumptions.sql"), "utf8");
    // The backfill statement (its chunk may carry a leading -- comment block).
    const insert = content
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .find((s) => s.toUpperCase().includes("INSERT INTO SMOKE_CONSUMPTIONS"));
    expect(insert).toBeTruthy();
    await pg.db.execute(sql.raw(insert!));

    const rows = await pg.db.select().from(smokeConsumptions);
    expect(rows).toHaveLength(3);
  });
});
