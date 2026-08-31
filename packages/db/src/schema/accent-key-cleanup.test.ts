import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// 0029, the last of the Wave 3 accent residue (issue #196 close-out).
//
// Two repairs on one defect. `aliasKeysFor` used to derive the `brandSlug()`
// TRANSCRIPTION alongside the folded key, so every marca minted from an accented
// name after PR #220 wears a clean folded slug and a junk key beside it
// (`cavalier-gen-ve`), while `Padrón` — minted by 0026, before any of it folded —
// still wears the transcription as its ADDRESS.
//
// The distinction between those two is the whole design of this migration, and
// it is what the suite below exists to pin: a transcription that was never a slug
// is junk and goes, a transcription that WAS a slug is a live URL and stays as an
// ordinary alias after the row is renamed onto its folded key. Strip both and the
// old links break; strip neither and the junk stays.
//
// The read path that turns that retained key back into a working URL is proved
// on the other side, in packages/domain/src/catalog-hierarchy.test.ts.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Everything before 0029 into `pre`, 0029 alone into `only0029`. Same split the
// 0026 and 0027 suites use, and for the same reason: build the schema, seed the
// state the migration is meant to find, then apply the one file under test and
// watch only what it did.
function splitMigrations(): { pre: string; only0029: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-0029-"));
  const only0029 = mkdtempSync(join(tmpdir(), "cj-mig-0029-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    if (name.startsWith("0029")) copyFileSync(join(MIGRATIONS_DIR, name), join(only0029, name));
    else if (name < "0029") copyFileSync(join(MIGRATIONS_DIR, name), join(pre, name));
  }
  return { pre, only0029 };
}

// The migration's own SQL, for the re-runs. `migrate()` records what it applied
// in `schema_migrations` and skips it forever after, which is exactly right for a
// deploy and useless for proving the STATEMENTS are idempotent — so the repeat
// executions below go straight at the file.
const MIGRATION_SQL = readFileSync(
  join(MIGRATIONS_DIR, "0029_accent_key_cleanup.sql"),
  "utf8",
);

interface BrandRow {
  name: string;
  slug: string;
  aliases: string[];
}

describe("0029 accent key cleanup", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0029: string };

  // Production, as read from postgres16-1/cigar_journal while this was written:
  // three marcas minted after #220 carrying a stray transcription, and Padrón
  // wearing one as its slug. The two extra keys on Cavalier and Don Pepín are
  // curator alias-adds from the same Wave 3 batch — they are not name-derived and
  // must survive untouched, which is what makes `array_remove` of one specific
  // key the right operation rather than a recompute of the array.
  const seeded: BrandRow[] = [
    { name: "Cavalier Genève", slug: "cavalier-geneve", aliases: ["cavalier", "cavalier-gen-ve", "cavalier-geneve"] },
    { name: "Don Pepín García", slug: "don-pepin-garcia", aliases: ["don-pep-n-garc-a", "don-pepin", "don-pepin-garcia"] },
    { name: "Jaime García", slug: "jaime-garcia", aliases: ["jaime-garc-a", "jaime-garcia"] },
    { name: "Padrón", slug: "padr-n", aliases: ["padr-n", "padron"] },
    // The control. An ASCII name derives one key by both rules, so there is
    // nothing here to strip and the row must come out byte-identical.
    { name: "Drew Estate", slug: "drew-estate", aliases: ["drew-estate", "liga"] },
  ];

  async function brandsNow(): Promise<BrandRow[]> {
    const rows = await pg.db.execute(
      sql`SELECT name, slug, aliases FROM brands ORDER BY name`,
    );
    return rows.rows as unknown as BrandRow[];
  }

  async function bySlug(slug: string): Promise<BrandRow | undefined> {
    return (await brandsNow()).find((b) => b.slug === slug);
  }

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();
    await migrate(pg.url, { migrationsDir: dirs.pre });
  }, 90_000);

  afterAll(async () => {
    await pg?.stop();
    for (const d of Object.values(dirs ?? {})) rmSync(d, { recursive: true, force: true });
  });

  // FIRST, ON AN EMPTY REGISTRY — before anything is seeded. A migration that
  // only works on the one database it was written against is a migration that
  // fails on a fresh deploy, a restored backup, or a developer's local box, and
  // it fails at deploy time rather than in review.
  it("is a no-op on a database holding none of these rows", async () => {
    expect((await brandsNow())).toEqual([]);
    await expect(pg.db.execute(sql.raw(MIGRATION_SQL))).resolves.toBeDefined();
    expect((await brandsNow())).toEqual([]);
  });

  it("strips the stray transcription and renames Padrón, and nothing else", async () => {
    for (const row of seeded) {
      await pg.db.execute(sql`
        INSERT INTO brands (name, slug, aliases)
        VALUES (${row.name}, ${row.slug}, ${sql.param(row.aliases)}::text[])
      `);
    }

    // Through the real runner this time, so the file is proved to apply the way
    // a deploy applies it.
    await migrate(pg.url, { migrationsDir: dirs.only0029 });

    // (a) The three Wave 3 marcas lose exactly one key each — the transcription —
    // and keep their curator-added keys and their folded key.
    expect(await bySlug("cavalier-geneve")).toEqual({
      name: "Cavalier Genève",
      slug: "cavalier-geneve",
      aliases: ["cavalier", "cavalier-geneve"],
    });
    expect(await bySlug("don-pepin-garcia")).toEqual({
      name: "Don Pepín García",
      slug: "don-pepin-garcia",
      aliases: ["don-pepin", "don-pepin-garcia"],
    });
    expect(await bySlug("jaime-garcia")).toEqual({
      name: "Jaime García",
      slug: "jaime-garcia",
      aliases: ["jaime-garcia"],
    });

    // (b) Padrón is renamed onto its folded key AND KEEPS `padr-n`. Both halves
    // matter: the rename is the point, and the retained key is the only thing
    // that makes `/cigars/brands/padr-n` still resolve afterwards.
    const padron = await bySlug("padron");
    expect(padron).toEqual({ name: "Padrón", slug: "padron", aliases: ["padr-n", "padron"] });
    expect(await bySlug("padr-n")).toBeUndefined();

    // (c) The ASCII control is untouched — including the alias that is not
    // derived from its name at all.
    expect(await bySlug("drew-estate")).toEqual({
      name: "Drew Estate",
      slug: "drew-estate",
      aliases: ["drew-estate", "liga"],
    });
  });

  // THE ORDERING TRAP, and the reason part 1 carries an explicit retained-slug
  // list. Part 1 strips a transcription from any row that does not wear it as a
  // slug; the moment part 2 renames Padrón, `padr-n` fits that description
  // exactly. A second execution would tear off the key the first execution went
  // out of its way to preserve — silently, and only for the one row whose old URL
  // is the reason any of this was done.
  it("is idempotent — a re-run keeps Padrón's retained key", async () => {
    const before = await brandsNow();
    await pg.db.execute(sql.raw(MIGRATION_SQL));
    expect(await brandsNow()).toEqual(before);
    await pg.db.execute(sql.raw(MIGRATION_SQL));
    expect(await brandsNow()).toEqual(before);

    const padron = await bySlug("padron");
    expect(padron?.aliases).toContain("padr-n");
  });

  // `brands_slug_key` is UNIQUE, so a rename into an occupied slug does not
  // return an error to a curator — it aborts the migration and rolls the whole
  // deploy back. The guard turns that into a no-op, leaving the row for a human.
  it("refuses to rename onto a slug another brand already owns", async () => {
    await pg.db.execute(sql`
      INSERT INTO brands (name, slug, aliases)
      VALUES ('Padrón', 'padr-n', ARRAY['padr-n'])
    `);

    await expect(pg.db.execute(sql.raw(MIGRATION_SQL))).resolves.toBeDefined();

    // Still two rows, the newcomer still on the legacy slug, and its `padr-n`
    // key still present — part 1's retained list spares it too.
    const legacy = await bySlug("padr-n");
    expect(legacy).toEqual({ name: "Padrón", slug: "padr-n", aliases: ["padr-n"] });
    expect((await bySlug("padron"))?.name).toBe("Padrón");

    await pg.db.execute(sql`DELETE FROM brands WHERE slug = 'padr-n'`);
  });

  // The defect was in `aliasKeysFor`, which is one function serving all four
  // mints, so the repair is written for all four levels even though production
  // has no accented line, blend or blender today. Seeding one of each proves the
  // statements are more than dead text.
  it("applies the same rule to lines, blends and blenders", async () => {
    const brandId = (
      await pg.db.execute(sql`SELECT id FROM brands WHERE slug = 'padron'`)
    ).rows[0]!.id;

    await pg.db.execute(sql`
      INSERT INTO lines (brand_id, name, slug, aliases)
      VALUES (${brandId}, 'Añejo', 'anejo', ARRAY['a-ejo', 'anejo'])
    `);
    const lineId = (await pg.db.execute(sql`SELECT id FROM lines WHERE slug = 'anejo'`)).rows[0]!.id;
    await pg.db.execute(sql`
      INSERT INTO blends (line_id, name, slug, aliases)
      VALUES (${lineId}, 'Reserva Especial Ámbar', 'reserva-especial-ambar',
              ARRAY['reserva-especial-mbar', 'reserva-especial-ambar'])
    `);
    await pg.db.execute(sql`
      INSERT INTO blenders (name, slug, aliases)
      VALUES ('José Orlando Padrón', 'jose-orlando-padron',
              ARRAY['jos-orlando-padr-n', 'jose-orlando-padron'])
    `);

    await pg.db.execute(sql.raw(MIGRATION_SQL));

    const keys = async (table: "lines" | "blends" | "blenders"): Promise<string[]> =>
      (
        (await pg.db.execute(sql`SELECT aliases FROM ${sql.identifier(table)} ORDER BY name`))
          .rows[0] as unknown as { aliases: string[] }
      ).aliases;

    expect(await keys("lines")).toEqual(["anejo"]);
    expect(await keys("blends")).toEqual(["reserva-especial-ambar"]);
    expect(await keys("blenders")).toEqual(["jose-orlando-padron"]);
  });

  // The last-key guard, mirroring the alias editor's. A row stripped down to an
  // empty `aliases` array is a row no probe can ever return, so the statement
  // declines rather than producing one. Unreachable through the mint path — a row
  // whose only key is the transcription would have to have been minted with the
  // folded key too — which is exactly why it is exercised directly.
  it("never strips a row down to no matching keys at all", async () => {
    await pg.db.execute(sql`
      INSERT INTO brands (name, slug, aliases)
      VALUES ('Bolívar Solo', 'bolivar-solo', ARRAY['bol-var-solo'])
    `);

    await pg.db.execute(sql.raw(MIGRATION_SQL));

    expect((await bySlug("bolivar-solo"))?.aliases).toEqual(["bol-var-solo"]);
  });
});
