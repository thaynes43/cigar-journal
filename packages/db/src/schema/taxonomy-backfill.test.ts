import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// The 0026 brand backfill (ADR-012, issue #196 Wave 1) has to run against
// pre-existing cigars, so this migrates everything BEFORE 0026, seeds the brand
// spellings production actually contains — accented, duplicate-cased, untrimmed,
// blank — then applies 0026 alone and observes what it minted.
//
// What it asserts is the whole contract of a MECHANICAL backfill: one brands row
// per addressable slug, slugs that agree with brandSlug() so existing URLs and
// `brand_images.brand_slug` still resolve, the accent-folded spelling parked in
// `aliases`, every matching cigar linked — and nothing else touched. No lines,
// no blends, no renames, no attachment of unbranded rows: that is Wave 3.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Everything except 0026 into `pre`, 0026 alone into `only0026` — so the runner
// builds the whole pre-taxonomy schema, we seed, then apply the one migration
// under test. 0026 is currently the highest-numbered migration, so nothing
// ordered after it needs to join `pre`.
function splitMigrations(): { pre: string; only0026: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-"));
  const only0026 = mkdtempSync(join(tmpdir(), "cj-mig-0026-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    const dest = name.startsWith("0026") ? only0026 : pre;
    copyFileSync(join(MIGRATIONS_DIR, name), join(dest, name));
  }
  return { pre, only0026 };
}

// brandSlug() from @cj/domain, mirrored: @cj/domain depends on @cj/db, so this
// package cannot import it without a cycle. The values below are asserted
// literally instead, and the domain side pins the same pairs against the real
// function (packages/domain/src/brand-slug-agreement.test.ts). If either side
// ever drifts, one of the two suites fails.
interface SeededCigar {
  name: string;
  brand: string | null;
}

describe("0026 taxonomy backfill", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0026: string };

  const seeded: SeededCigar[] = [
    // Accented: slugs to `padr-n` (brandSlug does not fold), folded spelling
    // becomes the alias.
    { name: "Backfill Padron 1964", brand: "Padrón" },
    { name: "Backfill Padron 1926", brand: "Padrón" },
    // Duplicate-cased: three + one collapse onto one slug, so the majority
    // spelling wins the name and the minority becomes an alias.
    { name: "Backfill Davidoff Signature", brand: "Davidoff" },
    { name: "Backfill Davidoff Millennium", brand: "Davidoff" },
    { name: "Backfill Davidoff Aniversario", brand: "Davidoff" },
    { name: "Backfill Davidoff Lowercase", brand: "davidoff" },
    // Untrimmed and punctuation-variant spellings of one brand — the collision
    // class the crawler's brand-image job already documents ("H. Upmann" vs
    // "H Upmann"). All three slug to `h-upmann`.
    { name: "Backfill Upmann Connie", brand: "  H Upmann  " },
    { name: "Backfill Upmann Mag 46", brand: "H. Upmann" },
    { name: "Backfill Upmann Half Corona", brand: "H Upmann" },
    // Never linked, never minted: unknown stays unknown.
    { name: "Backfill Unbranded", brand: null },
    { name: "Backfill Blank Brand", brand: "   " },
    // Slugs to the empty string — not addressable, so not a brand.
    { name: "Backfill Punctuation Brand", brand: "!!!" },
  ];

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();

    // 1. The whole schema up to, but not including, the taxonomy migration.
    await migrate(pg.url, { migrationsDir: dirs.pre });

    // 2. Seed with raw SQL, not the Drizzle schema: this DB is migrated only to
    // pre-0026, while the schema now carries brand_id/line_id/blend_id and
    // name_source. A Drizzle insert emits every column and would reference the
    // ones 0026 has not added yet.
    for (const row of seeded) {
      await pg.db.execute(
        sql`INSERT INTO cigars (canonical_name, brand) VALUES (${row.name}, ${row.brand})`,
      );
    }

    // A brand image whose slug will match a minted brand, and one that will not.
    await pg.db.execute(sql`
      INSERT INTO brand_images (brand_slug, brand_name, status)
      VALUES ('padr-n', 'Padrón', 'resolved'), ('no-such-brand', 'No Such Brand', 'no_match')
    `);

    // 3. Apply the taxonomy migration on its own and watch what it does.
    await migrate(pg.url, { migrationsDir: dirs.only0026 });
  }, 90_000);

  afterAll(async () => {
    await pg?.stop();
    for (const d of Object.values(dirs ?? {})) rmSync(d, { recursive: true, force: true });
  });

  it("mints exactly one brand per addressable slug", async () => {
    const rows = await pg.db.execute(sql`SELECT name, slug, aliases FROM brands ORDER BY slug`);
    expect(rows.rows).toEqual([
      // Majority spelling wins; the odd-cased one is kept as an alias, not lost.
      { name: "Davidoff", slug: "davidoff", aliases: ["davidoff"] },
      // Three spellings, one brand. "H. Upmann" survives as an alias; the
      // untrimmed "  H Upmann  " trims to the winning name and adds nothing.
      { name: "H Upmann", slug: "h-upmann", aliases: ["H. Upmann"] },
      // brandSlug() does not fold accents, so the slug keeps the shape the URL
      // contract and brand_images.brand_slug already use.
      { name: "Padrón", slug: "padr-n", aliases: ["Padron"] },
    ]);
  });

  it("links every cigar whose brand text resolves, and only those", async () => {
    const rows = await pg.db.execute(sql`
      SELECT c.canonical_name AS name, b.slug
      FROM cigars c LEFT JOIN brands b ON b.id = c.brand_id
      ORDER BY c.canonical_name
    `);
    const bySlug = new Map(rows.rows.map((r) => [r.name as string, r.slug as string | null]));

    // Case, surrounding whitespace and punctuation all fold into the slug, so
    // every spelling of a brand lands on the one row.
    expect(bySlug.get("Backfill Padron 1964")).toBe("padr-n");
    expect(bySlug.get("Backfill Davidoff Lowercase")).toBe("davidoff");
    expect(bySlug.get("Backfill Upmann Connie")).toBe("h-upmann");
    expect(bySlug.get("Backfill Upmann Mag 46")).toBe("h-upmann");

    // Unknown stays unknown — nothing is invented to satisfy the taxonomy.
    expect(bySlug.get("Backfill Unbranded")).toBeNull();
    expect(bySlug.get("Backfill Blank Brand")).toBeNull();
    expect(bySlug.get("Backfill Punctuation Brand")).toBeNull();

    const linked = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM cigars WHERE brand_id IS NOT NULL`,
    );
    expect((linked.rows[0] as { n: number }).n).toBe(9);
  });

  it("mints nothing above brand — lines, blends and blenders are Wave 3", async () => {
    for (const table of ["lines", "blends", "blenders", "blend_blenders"]) {
      const count = await pg.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      expect((count.rows[0] as { n: number }).n).toBe(0);
    }
    // And no cigar was given a line or blend it did not have.
    const above = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM cigars WHERE line_id IS NOT NULL OR blend_id IS NOT NULL`,
    );
    expect((above.rows[0] as { n: number }).n).toBe(0);
  });

  it("leaves the free-text columns and every name untouched", async () => {
    // The free-text brand column stays authoritative until Wave 5 — the backfill
    // reads it, it never rewrites it (the untrimmed spelling is still untrimmed).
    const raw = await pg.db.execute(
      sql`SELECT brand FROM cigars WHERE canonical_name = 'Backfill Upmann Connie'`,
    );
    expect((raw.rows[0] as { brand: string }).brand).toBe("  H Upmann  ");

    // Every row is still freeform: nothing composes a name in Wave 1.
    const composed = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM cigars WHERE name_source <> 'freeform'`,
    );
    expect((composed.rows[0] as { n: number }).n).toBe(0);
  });

  it("folds brand_images onto the registry without disturbing brand_slug", async () => {
    const rows = await pg.db.execute(sql`
      SELECT bi.brand_slug, b.slug AS linked
      FROM brand_images bi LEFT JOIN brands b ON b.id = bi.brand_id
      ORDER BY bi.brand_slug
    `);
    expect(rows.rows).toEqual([
      // No catalog cigar behind it, so it stays unlinked — and still works.
      { brand_slug: "no-such-brand", linked: null },
      // The slug agreement is the whole point: a direct equality join.
      { brand_slug: "padr-n", linked: "padr-n" },
    ]);
  });

  it("is idempotent — re-running mints no duplicates and relinks nothing", async () => {
    const rerun = await migrate(pg.url, { migrationsDir: dirs.only0026 });
    expect(rerun.applied).toEqual([]);

    // The runner records the file, so also replay the backfill body itself: the
    // ON CONFLICT and IS NULL guards are what make a re-run safe.
    await pg.db.execute(sql`
      INSERT INTO brands (name, slug, aliases) VALUES ('Padrón', 'padr-n', '{Padron}')
      ON CONFLICT (slug) DO NOTHING
    `);
    const brands = await pg.db.execute(sql`SELECT count(*)::int AS n FROM brands`);
    expect((brands.rows[0] as { n: number }).n).toBe(3);
  });
});
