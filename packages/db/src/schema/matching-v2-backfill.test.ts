import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// 0027 re-runs the whole 0026 backfill (ADR-012, issue #196 Wave 2), and THAT is
// what this file is about — the two new `listing_matches` columns and the wider
// `unmatched_reason` set are pinned next to the other schema shapes in
// migrations.test.ts.
//
// The re-run exists because 0026 left the INSERT paths unwired: every cigar
// `add_cigar`, `record_purchase`, `save_smoke` or a crawl minted between the two
// migrations landed with a brand string and `brand_id` NULL. So this test
// reproduces that window exactly — seed a catalog, apply 0026, seed the rows
// that "arrived after 0026", then apply 0027 alone and watch it sweep.
//
// Three claims, and the third is the one that makes the other two safe:
//
//   1. The two UPDATEs 0026 promised do catch up the rows that arrived since.
//   2. The MINT is re-run too, which 0026 did not promise. A cigar created in
//      the gap can carry a brand string no `brands` row covers — `add_cigar`
//      takes free text — and for that row the UPDATE alone has nothing to link
//      to and it would stay unlinked forever.
//   3. Re-running changes nothing the second time. Not a nicety: a fresh mint
//      can CREATE an alias collision that did not exist at 0026 (a plain
//      `Padron` spelling arriving after `Padrón` was already minted), so the
//      collision pass has to converge on the re-run rather than merely replay.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Three dirs, because the window between two migrations is the subject. `pre`
// builds the schema up to but excluding the taxonomy registries; `only0026`
// mints the brands a real deploy would already have; `only0027` is the file
// under test, applied on its own so everything observed afterwards is its doing.
//
// Migrations ordered after 0027 are deliberately left out of all three: this
// test reproduces one historical window, and a later migration replayed inside
// it would be describing a database that never existed.
interface MigrationDirs {
  pre: string;
  only0026: string;
  only0027: string;
}

function splitMigrations(): MigrationDirs {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-"));
  const only0026 = mkdtempSync(join(tmpdir(), "cj-mig-0026-"));
  const only0027 = mkdtempSync(join(tmpdir(), "cj-mig-0027-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    const dest = name.startsWith("0026")
      ? only0026
      : name.startsWith("0027")
        ? only0027
        : name < "0026"
          ? pre
          : null;
    if (dest) copyFileSync(join(MIGRATIONS_DIR, name), join(dest, name));
  }
  return { pre, only0026, only0027 };
}

const MIGRATION_0027 = "0027_matching_v2.sql";

// Every slug and alias below is written as a LITERAL rather than derived:
// brandSlug() lives in @cj/domain, which depends on @cj/db, so this package
// cannot import it without a cycle. The domain side pins the same pairs against
// the real function (packages/domain/src/brand-slug-agreement.test.ts), so if
// either side ever drifts one of the two suites fails.
//
// The rule does NOT strip accents — `Padrón` slugs to `padr-n`, `Bolívar` to
// `bol-var` — while `aliases` carries the FOLDED matching key (`padron`,
// `bolivar`), which is what matching v2 probes for.

interface BrandSnapshot {
  slug: string;
  name: string;
  aliases: string[];
}

describe("0027 re-run of the 0026 brand backfill", () => {
  let pg: TestPostgres;
  let dirs: MigrationDirs;

  // The brand a curator moved a cigar onto by hand, and the link they moved.
  let nubBrandId: string;
  // `updated_at` for the rows 0027 links, captured before it runs: a structural
  // link is not an edit to the cigar's content, and bumping it would churn
  // recency ordering across the whole catalog.
  let updatedAtBefore = new Map<string, string>();

  const brandRows = async (): Promise<BrandSnapshot[]> =>
    (await pg.db.execute(sql`SELECT slug, name, aliases FROM brands ORDER BY slug`))
      .rows as unknown as BrandSnapshot[];

  const linkBySlug = async (): Promise<Map<string, string | null>> => {
    const rows = await pg.db.execute(sql`
      SELECT c.canonical_name AS name, b.slug
      FROM cigars c LEFT JOIN brands b ON b.id = c.brand_id
      ORDER BY c.canonical_name
    `);
    return new Map(rows.rows.map((r) => [r.name as string, r.slug as string | null]));
  };

  const imageLinks = async () =>
    (
      await pg.db.execute(sql`
        SELECT bi.brand_slug, b.slug AS linked
        FROM brand_images bi LEFT JOIN brands b ON b.id = bi.brand_id
        ORDER BY bi.brand_slug
      `)
    ).rows;

  const seedCigar = async (name: string, brand: string | null) => {
    // Raw SQL, not the Drizzle schema: this DB is migrated to a point in the
    // past, and a Drizzle insert emits every column the schema declares today.
    const row = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name, brand) VALUES (${name}, ${brand}) RETURNING id`,
    );
    return (row.rows[0] as { id: string }).id;
  };

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();

    // 1. The schema up to, but not including, the taxonomy registries.
    await migrate(pg.url, { migrationsDir: dirs.pre });

    // 2. The catalog as it stood when 0026 shipped.
    await seedCigar("W2 Padron 1964", "Padrón");
    await seedCigar("W2 Padron 1926", "Padrón");
    await seedCigar("W2 Davidoff Signature", "Davidoff");
    await seedCigar("W2 Curated Correction", "Davidoff");
    await seedCigar("W2 Nub Habano", "Nub");

    // 3. 0026 alone: mints `padr-n`, `davidoff`, `nub` and links those five.
    await migrate(pg.url, { migrationsDir: dirs.only0026 });

    const nub = await pg.db.execute(sql`SELECT id FROM brands WHERE slug = 'nub'`);
    nubBrandId = (nub.rows[0] as { id: string }).id;

    // 4. THE GAP. Everything below arrives between the two migrations, which is
    // to say it arrives with `brand_id` NULL because Wave 1 wired no write path.
    //
    // (a) A brand string 0026 already covers — the case 0026 foresaw, and the
    //     only one its two promised UPDATEs can handle on their own. The second
    //     spelling is untrimmed and lowercased to show the slug rule still does
    //     the folding on the re-run.
    await seedCigar("W2 Late Davidoff Millennium", "Davidoff");
    await seedCigar("W2 Late Davidoff Aniversario", "  davidoff ");
    // (b) A brand string NO `brands` row covers. This is the row that proves the
    //     MINT has to run again: with only the UPDATEs it has nothing to match
    //     and stays unlinked forever.
    await seedCigar("W2 Late Charter Oak", "Foundation Cigar Co.");
    // (c) An accented brand nobody has minted yet — a fresh mint must still park
    //     the folded matching key `bolivar` in `aliases` beside the slug, or
    //     matching v2's anchor probe never finds it.
    await seedCigar("W2 Late Bolivar Belicosos", "Bolívar");
    // (d) THE COLLISION, and it does not exist until 0027 creates it. 0026 minted
    //     `padr-n` holding BOTH `padr-n` and the folded `padron`, uncontested at
    //     the time. This plain spelling now mints a brand whose SLUG is `padron`,
    //     so two brands claim that one matching key and the collision pass has to
    //     resolve it on the re-run — it is not replaying settled work.
    await seedCigar("W2 Late Padron Serie 1926", "Padron");
    // (e) Unknown stays unknown. A re-run mints brands; it never invents identity.
    await seedCigar("W2 Late Unbranded", null);
    await seedCigar("W2 Late Punctuation", "!!!");

    // (f) The curator correction. 0026 linked this cigar to `davidoff` by the
    //     mechanical rule; a curator has since moved it to `nub` — deliberately
    //     disagreeing with the free text, which is what a correction IS. The
    //     re-run must not undo it, and the `brand_id IS NULL` guard is the entire
    //     reason it cannot.
    await pg.db.execute(sql`
      UPDATE cigars SET brand_id = ${nubBrandId} WHERE canonical_name = 'W2 Curated Correction'
    `);

    // (g) Brand images written by the image job in the same window: one for a
    //     brand 0026 minted, one for a brand only the RE-RUN's mint will create
    //     (so it also pins the ordering — mint before link), one for nothing.
    await pg.db.execute(sql`
      INSERT INTO brand_images (brand_slug, brand_name, status) VALUES
        ('davidoff', 'Davidoff', 'resolved'),
        ('foundation-cigar-co', 'Foundation Cigar Co.', 'resolved'),
        ('no-such-brand', 'No Such Brand', 'no_match')
    `);

    const stamps = await pg.db.execute(
      sql`SELECT canonical_name AS name, updated_at FROM cigars ORDER BY canonical_name`,
    );
    updatedAtBefore = new Map(
      stamps.rows.map((r) => [r.name as string, String((r as { updated_at: unknown }).updated_at)]),
    );

    // 5. 0027 alone. Everything asserted below is its doing.
    await migrate(pg.url, { migrationsDir: dirs.only0027 });
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
    for (const d of Object.values(dirs ?? {})) rmSync(d, { recursive: true, force: true });
  });

  // The half 0026 promised: rows carrying an already-known brand string.
  it("links the cigars that arrived after 0026 carrying a known brand string", async () => {
    const links = await linkBySlug();
    expect(links.get("W2 Late Davidoff Millennium")).toBe("davidoff");
    // Case and surrounding whitespace fold into the slug, so the untrimmed
    // spelling lands on the same brand rather than minting a rival.
    expect(links.get("W2 Late Davidoff Aniversario")).toBe("davidoff");
  });

  // The half 0026 did NOT promise, and the reason 0027 re-runs the mint rather
  // than only the two UPDATEs. Without the INSERT this row has no brand to be
  // linked to and no later migration would ever come back for it.
  it("mints the brand no 0026 row covered, and links the cigar to it", async () => {
    const brands = await brandRows();
    expect(brands).toContainEqual({
      name: "Foundation Cigar Co.",
      slug: "foundation-cigar-co",
      aliases: ["foundation-cigar-co"],
    });
    expect((await linkBySlug()).get("W2 Late Charter Oak")).toBe("foundation-cigar-co");
  });

  // A brand minted by the RE-RUN gets the same treatment as one minted by 0026:
  // the unfolded slug the URL contract needs, and the folded key matching reads.
  it("gives a freshly minted brand its folded matching key", async () => {
    expect(await brandRows()).toContainEqual({
      name: "Bolívar",
      slug: "bol-var",
      aliases: ["bol-var", "bolivar"],
    });
    expect((await linkBySlug()).get("W2 Late Bolivar Belicosos")).toBe("bol-var");
  });

  // THE CURATOR GUARD. `brand_id IS NULL` means a re-run only ever ADDS links,
  // so a correction that deliberately contradicts the free-text brand survives —
  // which is what makes this migration safe to run after curation has started.
  it("never overwrites a link a curator has already corrected", async () => {
    const row = await pg.db.execute(sql`
      SELECT b.slug, c.brand
      FROM cigars c JOIN brands b ON b.id = c.brand_id
      WHERE c.canonical_name = 'W2 Curated Correction'
    `);
    // Free text still says Davidoff and the link still says Nub. The mechanical
    // rule would pick `davidoff`; it never got the chance, and that is the point.
    expect(row.rows[0]).toMatchObject({ slug: "nub", brand: "Davidoff" });
  });

  // The collision the re-run CREATED. An alias resolving to two brands is worse
  // than no alias — the anchor probe would pick a marca confidently and at
  // random — so identity wins: the brand owning `padron` as its slug keeps it,
  // and the accented brand that merely folds onto it gives it up.
  it("resolves the alias collision its own mint introduced", async () => {
    const claimants = await pg.db.execute(sql`
      SELECT slug FROM brands WHERE aliases @> ARRAY['padron'] ORDER BY slug
    `);
    expect(claimants.rows).toEqual([{ slug: "padron" }]);

    const brands = await brandRows();
    // 0026 left `padron` on this brand; nothing contested it until now.
    expect(brands).toContainEqual({ name: "Padrón", slug: "padr-n", aliases: ["padr-n"] });
    expect(brands).toContainEqual({ name: "Padron", slug: "padron", aliases: ["padron"] });

    // Two spellings stay two brands: merging them is Wave 3 curation, on
    // evidence and with an audit trail. Each cigar is linked by its own slug.
    const links = await linkBySlug();
    expect(links.get("W2 Padron 1964")).toBe("padr-n");
    expect(links.get("W2 Late Padron Serie 1926")).toBe("padron");
  });

  it("invents no identity for a brand string that is not addressable", async () => {
    const links = await linkBySlug();
    expect(links.get("W2 Late Unbranded")).toBeNull();
    // Slugs to the empty string, so it is not a brand and not a URL either.
    expect(links.get("W2 Late Punctuation")).toBeNull();

    // And still nothing above brand: lines, blends and blenders are Wave 3.
    for (const table of ["lines", "blends", "blenders", "blend_blenders"]) {
      const count = await pg.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      expect((count.rows[0] as { n: number }).n).toBe(0);
    }
  });

  it("links the brand images written in the gap, including one only the re-run's mint made linkable", async () => {
    expect(await imageLinks()).toEqual([
      // Its brand existed since 0026.
      { brand_slug: "davidoff", linked: "davidoff" },
      // Its brand did not exist until the INSERT above ran, three statements
      // earlier in the same migration.
      { brand_slug: "foundation-cigar-co", linked: "foundation-cigar-co" },
      // No catalog cigar behind it, so it stays unlinked — and still works.
      { brand_slug: "no-such-brand", linked: null },
    ]);
  });

  it("links without touching updated_at", async () => {
    const after = await pg.db.execute(
      sql`SELECT canonical_name AS name, updated_at FROM cigars ORDER BY canonical_name`,
    );
    for (const row of after.rows) {
      const name = row.name as string;
      expect(String((row as { updated_at: unknown }).updated_at)).toBe(updatedAtBefore.get(name));
    }
  });

  // THE CENTRAL CLAIM. Every statement 0027 re-runs was written to be replayed —
  // ON CONFLICT DO NOTHING on the mint, `IS NULL` guards on both link UPDATEs,
  // and a collision pass whose every subquery reads the pre-statement snapshot —
  // and the DDL above it carries IF NOT EXISTS / IF EXISTS so the file as a whole
  // can be applied twice. This asserts the whole file is a fixed point: apply it
  // again and NOTHING moves.
  it("is idempotent — a second application of the whole file changes nothing", async () => {
    // The runner alone will not replay it: the file is recorded as applied.
    expect((await migrate(pg.url, { migrationsDir: dirs.only0027 })).applied).toEqual([]);

    const before = {
      brands: await brandRows(),
      links: [...(await linkBySlug())],
      images: await imageLinks(),
    };

    // So forget it was applied and make the runner execute the real file a
    // second time, DDL and all — not a hand-copied excerpt of it, which would
    // only prove that the copy is idempotent.
    await pg.db.execute(sql`DELETE FROM schema_migrations WHERE id = ${MIGRATION_0027}`);
    const replay = await migrate(pg.url, { migrationsDir: dirs.only0027 });
    expect(replay.applied).toEqual([MIGRATION_0027]);

    expect({
      brands: await brandRows(),
      links: [...(await linkBySlug())],
      images: await imageLinks(),
    }).toEqual(before);

    // Named separately because it is the failure the mint's ON CONFLICT exists to
    // prevent, and a duplicate would be invisible in a `toContainEqual` above.
    const count = await pg.db.execute(sql`SELECT count(*)::int AS n FROM brands`);
    expect((count.rows[0] as { n: number }).n).toBe(before.brands.length);

    // And in particular the collision pass has converged rather than eroding: a
    // second run must not now strip `padron` from the brand that owns it.
    const claimants = await pg.db.execute(sql`
      SELECT slug FROM brands WHERE aliases @> ARRAY['padron'] ORDER BY slug
    `);
    expect(claimants.rows).toEqual([{ slug: "padron" }]);
  });
});
