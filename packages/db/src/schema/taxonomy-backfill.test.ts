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
// `brand_images.brand_slug` still resolve, the accent-folded MATCHING KEY parked
// in `aliases`, every matching cigar linked — and nothing else touched. No
// lines, no blends, no renames, no attachment of unbranded rows: that is Wave 3.
//
// `aliases` holds matching keys, never display text: each entry is fold() then
// brandSlug(), the same normalization matching v2 will run over an incoming
// vendor string, so the GIN exact-match probe can actually hit. A key that two
// brands would otherwise claim is resolved to the one that owns it as its slug.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Everything ordered BEFORE 0026 into `pre`, 0026 alone into `only0026` — so the
// runner builds the whole pre-taxonomy schema, we seed, then apply the one
// migration under test.
//
// Migrations ordered AFTER 0026 go into NEITHER dir. They used to join `pre`
// (0026 was the highest number when this was written) and that stopped working
// the moment 0027 landed: 0027 both reads `brands` — so applying it ahead of
// 0026 aborts the run outright — and RE-RUNS the very backfill observed below,
// which would silently confound every assertion here. 0027's own re-run is
// proved separately, in matching-v2-backfill.test.ts.
function splitMigrations(): { pre: string; only0026: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-"));
  const only0026 = mkdtempSync(join(tmpdir(), "cj-mig-0026-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    if (name.startsWith("0026")) copyFileSync(join(MIGRATIONS_DIR, name), join(only0026, name));
    else if (name < "0026") copyFileSync(join(MIGRATIONS_DIR, name), join(pre, name));
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

// A brand string long enough to overflow the btree behind `brands_slug_key`
// (~2704 bytes). It has to be HIGH-ENTROPY: index tuples are PGLZ-compressed, so
// three thousand repeats of one character compress to nothing and slip under the
// limit, proving the opposite of what this seed is for. Deterministic LCG rather
// than a random source so a failure is always reproducible.
function incompressibleBrand(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let seed = 0x2f6e2b1;
  let out = "";
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[(seed >>> 8) % alphabet.length];
  }
  return out;
}

describe("0026 taxonomy backfill", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0026: string };

  const seeded: SeededCigar[] = [
    // Accented: slugs to `padr-n` (brandSlug does not fold), and the folded
    // matching key `padron` becomes an alias.
    { name: "Backfill Padron 1964", brand: "Padrón" },
    { name: "Backfill Padron 1926", brand: "Padrón" },
    // ...and the unaccented spelling exists in the catalog as its own brand,
    // whose SLUG is `padron`. Two brands now claim that one matching key, which
    // is exactly the collision the alias cleanup has to resolve.
    { name: "Backfill Padron Serie 1926", brand: "Padron" },
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
    // Slugs to something no btree can index. Before the length guard this single
    // row did not produce a bad brand, it ABORTED THE MIGRATION on the
    // `brands_slug_key` index insert and rolled the deploy back.
    { name: "Backfill Oversized Brand", brand: incompressibleBrand(3000) },
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
      // Majority spelling wins the display name. Both spellings normalize to the
      // one matching key, which is also this brand's slug — stored, so a single
      // probe resolves the brand without a second lookup.
      { name: "Davidoff", slug: "davidoff", aliases: ["davidoff"] },
      // Three spellings, one brand, one matching key: "H. Upmann" is kept as
      // `h-upmann`, not as its display text, which is what makes an exact-match
      // probe find it.
      { name: "H Upmann", slug: "h-upmann", aliases: ["h-upmann"] },
      // brandSlug() does not fold accents, so the slug keeps the shape the URL
      // contract and brand_images.brand_slug already use. The folded key
      // `padron` would also have landed here — the cleanup moved it to the brand
      // that owns it as a slug.
      { name: "Padrón", slug: "padr-n", aliases: ["padr-n"] },
      { name: "Padron", slug: "padron", aliases: ["padron"] },
    ]);
  });

  // An alias that resolves to two brands is worse than no alias: the anchor step
  // would confidently pick a marca at random. `Padrón` folds onto `Padron`'s
  // slug, so exactly one of them may keep that key — the one whose identity it
  // is.
  it("leaves a contested matching key with exactly one brand", async () => {
    const rows = await pg.db.execute(sql`
      SELECT slug FROM brands WHERE aliases @> ARRAY['padron'] ORDER BY slug
    `);
    expect(rows.rows).toEqual([{ slug: "padron" }]);
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
    // Linked by its own slug, not by the alias it contests — two spellings that
    // both mint a brand stay two brands until a curator merges them (Wave 3).
    expect(bySlug.get("Backfill Padron Serie 1926")).toBe("padron");
    expect(bySlug.get("Backfill Davidoff Lowercase")).toBe("davidoff");
    expect(bySlug.get("Backfill Upmann Connie")).toBe("h-upmann");
    expect(bySlug.get("Backfill Upmann Mag 46")).toBe("h-upmann");

    // Unknown stays unknown — nothing is invented to satisfy the taxonomy.
    expect(bySlug.get("Backfill Unbranded")).toBeNull();
    expect(bySlug.get("Backfill Blank Brand")).toBeNull();
    expect(bySlug.get("Backfill Punctuation Brand")).toBeNull();
    // Skipped for the same reason as punctuation: unaddressable. That this
    // suite reached an assertion at all is the real result — the migration
    // applied instead of aborting.
    expect(bySlug.get("Backfill Oversized Brand")).toBeNull();

    const linked = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM cigars WHERE brand_id IS NOT NULL`,
    );
    expect((linked.rows[0] as { n: number }).n).toBe(10);
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
      INSERT INTO brands (name, slug, aliases) VALUES ('Padrón', 'padr-n', '{padr-n,padron}')
      ON CONFLICT (slug) DO NOTHING
    `);
    const brands = await pg.db.execute(sql`SELECT count(*)::int AS n FROM brands`);
    expect((brands.rows[0] as { n: number }).n).toBe(4);

    // The alias cleanup is the one statement without a guard clause, so its
    // re-runnability rests on reading the pre-statement snapshot. Replay it and
    // nothing may move — in particular `padron` must not now be stripped from
    // the brand that legitimately owns it.
    await pg.db.execute(sql`
      UPDATE brands b
      SET aliases = COALESCE((
        SELECT array_agg(t.a ORDER BY t.a)
        FROM unnest(b.aliases) AS t(a)
        WHERE NOT EXISTS (SELECT 1 FROM brands o WHERE o.id <> b.id AND o.slug = t.a)
          AND NOT EXISTS (
            SELECT 1 FROM brands o
            WHERE o.id <> b.id
              AND t.a = ANY (o.aliases)
              AND NOT EXISTS (SELECT 1 FROM brands k WHERE k.slug = t.a)
          )
      ), '{}')
      WHERE EXISTS (
        SELECT 1
        FROM unnest(b.aliases) AS t(a)
        JOIN brands o ON o.id <> b.id AND (o.slug = t.a OR t.a = ANY (o.aliases))
      )
    `);
    const after = await pg.db.execute(sql`SELECT slug, aliases FROM brands ORDER BY slug`);
    expect(after.rows).toEqual([
      { slug: "davidoff", aliases: ["davidoff"] },
      { slug: "h-upmann", aliases: ["h-upmann"] },
      { slug: "padr-n", aliases: ["padr-n"] },
      { slug: "padron", aliases: ["padron"] },
    ]);
  });
});
