import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// 0032, the revert of one Fox offers run.
//
// `chooseLeaf` could bind a listing to a sibling under the same brand/line
// anchor without ever comparing the listing's vitola tokens to the leaf's — the
// freeform arm never called `identityTokensCompatible`, and the structural arm
// took a line's ONLY leaf with no name comparison at all. Crawl run
// 5eb6586b-83e5-4e23-9585-e9ee155dce74 wrote 1,067 auto-links under that defect;
// a 60-link audit put the marca right 60/60 and the whole link right only 40/60.
// The migration hands the entire batch back as `unmatched`.
//
// The batch is identified by NOTHING BUT `updated_at` inside the run's own
// bounds, which makes both ends of that window the whole risk surface. So this
// file spends most of its length on rows that must NOT move: earlier crawler
// links, a link written exactly ON the starting instant, links written after the
// run finished (the fixed matcher's own output, which a lower-bound-only revert
// would swallow), and every agent/curator verdict sitting inside the window.
//
// The provenance lookup is exercised for real: the fixture seeds the actual
// production `crawl_runs` row — id, vendor, kind, both timestamps — so the
// migration's join is the one that runs on prod, and the file's first two tests
// prove what happens on a database where that row does not exist.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Everything before 0032 into `pre`, 0032 alone into `only0032`. The same split
// the 0026/0027/0029/0030/0031 suites use, and for the same reason: build the
// schema, seed the state the migration is meant to find, then apply the one file
// under test.
function splitMigrations(): { pre: string; only0032: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-0032-"));
  const only0032 = mkdtempSync(join(tmpdir(), "cj-mig-0032-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    if (name.startsWith("0032")) copyFileSync(join(MIGRATIONS_DIR, name), join(only0032, name));
    else if (name < "0032") copyFileSync(join(MIGRATIONS_DIR, name), join(pre, name));
  }
  return { pre, only0032 };
}

// The file's own SQL, for the runs `migrate()` will not do twice. It records what
// it applied and skips it forever after — right for a deploy, useless for
// proving the STATEMENT is idempotent, and useless for observing the statement
// against a database whose `crawl_runs` row has not been seeded yet.
const MIGRATION_SQL = readFileSync(
  join(MIGRATIONS_DIR, "0032_revert_offers_vitola_misbinds.sql"),
  "utf8",
);

// The run, exactly as prod holds it (2026-09-01).
const RUN_ID = "5eb6586b-83e5-4e23-9585-e9ee155dce74";
const FOX_VENDOR_ID = "57cad36b-d25b-490f-a332-bf7f2d14b18c";
const RUN_STARTED = "2026-09-01 15:32:06.893-04";
const RUN_FINISHED = "2026-09-01 17:04:14.866-04";
// The batch's real extremes, both inside the bounds above.
const FIRST_WRITE = "2026-09-01 15:32:37.571-04";
const LAST_WRITE = "2026-09-01 17:04:09.191-04";

interface MatchRow {
  key: string;
  status: string;
  decided_by: string;
  reason: string | null;
  linked: boolean;
  updated_utc: string;
  suggested_parse: unknown;
  category_path: string[] | null;
}

describe("0032 revert offers vitola misbinds", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0032: string };
  let cigarId: string;
  let giftCardId: string;

  // A `text[]` as a literal rather than as a bound array: drizzle spreads a JS
  // array into a placeholder LIST, which Postgres reads as a record and refuses
  // to cast.
  const pgArray = (values?: string[]): string | null =>
    values == null
      ? null
      : `{${values.map((v) => `"${v.replaceAll(/(["\\])/g, "\\$1")}"`).join(",")}}`;

  // One listing row in whatever shape the case under test needs. `listing_key`
  // doubles as the row's name in every assertion below, and `updatedAt` is the
  // only thing the migration's window can see.
  const listing = async (
    key: string,
    opts: {
      status: string;
      decidedBy: string;
      updatedAt: string;
      reason?: string | null;
      linked?: boolean;
      cigar?: string;
      suggestedParse?: unknown;
      categoryPath?: string[];
    },
  ): Promise<void> => {
    await pg.db.execute(sql`
      INSERT INTO listing_matches
        (vendor_id, listing_key, cigar_id, status, decided_by, unmatched_reason,
         suggested_parse, category_path, created_at, updated_at)
      VALUES (
        ${FOX_VENDOR_ID},
        ${key},
        ${opts.linked === false ? null : (opts.cigar ?? (opts.linked ? cigarId : null))},
        ${opts.status},
        ${opts.decidedBy},
        ${opts.reason ?? null},
        ${opts.suggestedParse == null ? null : JSON.stringify(opts.suggestedParse)}::jsonb,
        ${pgArray(opts.categoryPath)}::text[],
        ${opts.updatedAt}::timestamptz,
        ${opts.updatedAt}::timestamptz
      )
    `);
  };

  // `updated_at` rendered in UTC rather than returned as a Date, so a snapshot
  // comparison cannot depend on the session time zone — and so that a migration
  // which quietly bumped the column would fail here rather than pass.
  const matchesNow = async (): Promise<MatchRow[]> =>
    (
      await pg.db.execute(sql`
        SELECT listing_key AS key, status, decided_by, unmatched_reason AS reason,
               (cigar_id IS NOT NULL) AS linked,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_utc,
               suggested_parse, category_path
          FROM listing_matches
         ORDER BY listing_key
      `)
    ).rows as unknown as MatchRow[];

  const one = async (key: string): Promise<MatchRow | undefined> =>
    (await matchesNow()).find((r) => r.key === key);

  const seedRun = async (): Promise<void> => {
    await pg.db.execute(sql`
      INSERT INTO crawl_runs (id, vendor_id, kind, status, started_at, finished_at)
      VALUES (
        ${RUN_ID}::uuid,
        ${FOX_VENDOR_ID}::uuid,
        'offers',
        'succeeded',
        ${RUN_STARTED}::timestamptz,
        ${RUN_FINISHED}::timestamptz
      )
    `);
  };

  // THE BATCH: crawler `auto` links written inside the run's bounds. Named for
  // the four proven misbinds plus the two edges of the window.
  const IN_WINDOW = [
    "/shop/cigars/cao-flavours-bella-vanilla-corona/",
    "/shop/cigars/tatuaje-skinny-monsters-frank/",
    "/shop/cigars/rocky-patel-dark-star-toro/",
    "/shop/cigars/davidoff-grand-cru-no-2/",
    "/shop/cigars/fox-gift-card-25/",
    "/shop/cigars/last-write-on-the-final-instant/",
  ];

  const seedListings = async (): Promise<void> => {
    // ---- inside the window, crawler `auto`: everything the migration is for.
    //
    // 'CAO Flavours Bella Vanilla Corona' bound to 'CAO Flavours Moontrance
    // Corona' while the correct row existed. Carries the parse and the vendor
    // breadcrumbs, which are evidence about the listing and must survive: they
    // are not what went wrong.
    await listing(IN_WINDOW[0]!, {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: FIRST_WRITE,
      suggestedParse: { brandName: "CAO", lineName: "Flavours", vitolaName: "Corona" },
      categoryPath: ["Cigars", "Flavored"],
    });
    // The structural arm: the line's only leaf, taken with no name comparison.
    await listing(IN_WINDOW[1]!, {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: "2026-09-01 16:00:00-04",
    });
    await listing(IN_WINDOW[2]!, {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: "2026-09-01 16:30:00-04",
    });
    // One of the nine 'Davidoff Grand Cru *' SKUs that all collapsed onto the
    // single 'Davidoff Grand Cru' row. Written at the batch's last observed
    // instant on prod.
    await listing(IN_WINDOW[3]!, {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: LAST_WRITE,
    });
    // One of the 20 links pointing at a `catalog_status='excluded'` row — a Fox
    // gift card. Invisible on every catalogue surface, which is the hazard in
    // miniature.
    await listing(IN_WINDOW[4]!, {
      status: "auto",
      decidedBy: "crawler",
      cigar: giftCardId,
      updatedAt: "2026-09-01 16:45:00-04",
    });
    // ON the closing instant. The upper bound is `<=`, so this moves — and if it
    // were `<` a real row would be stranded auto-linked under the defect.
    await listing(IN_WINDOW[5]!, {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: RUN_FINISHED,
    });

    // ---- crawler `auto` OUTSIDE the window. The 68 rows on prod whose
    // `updated_at` is at or before the run's start, and everything the FIXED
    // matcher writes afterwards.
    await listing("/shop/cigars/earlier-walk-link/", {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: "2026-08-31 03:12:00-04",
    });
    // Exactly ON `started_at`. The lower bound is strict, and this row is why:
    // the run's own first write is 30 seconds later, so an inclusive bound would
    // reach backwards into another walk's output for nothing.
    await listing("/shop/cigars/at-the-starting-gun/", {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: RUN_STARTED,
    });
    // THE END GUARD, and the reason it is not optional. Drop the `<=
    // finished_at` clause and this row — a link the fixed matcher wrote after the
    // deploy — is reverted along with the bad batch, turning a repair into a
    // second outage that repeats nightly.
    await listing("/shop/cigars/fixed-matcher-link/", {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: "2026-09-01 17:10:00-04",
    });
    // One millisecond after the run finished: the tightest form of the same
    // guard, so an off-by-a-hair bound cannot pass.
    await listing("/shop/cigars/one-ms-after-the-finish/", {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: "2026-09-01 17:04:14.867-04",
    });

    // ---- other verdicts, ALL of them written inside the window, so the only
    // thing keeping each one out of the UPDATE is the clause named beside it.
    // A count would pass here for the wrong reasons; these rows will not.
    await listing("/shop/cigars/agent-confirmed/", {
      status: "confirmed",
      decidedBy: "agent",
      linked: true,
      updatedAt: "2026-09-01 16:10:00-04",
    });
    await listing("/shop/cigars/curator-confirmed/", {
      status: "confirmed",
      decidedBy: "curator",
      linked: true,
      updatedAt: "2026-09-01 16:11:00-04",
    });
    // `auto` and inside the window: `decided_by` is the ONLY clause excluding
    // these two, so a dropped provenance test shows up here first.
    await listing("/shop/cigars/curator-auto/", {
      status: "auto",
      decidedBy: "curator",
      linked: true,
      updatedAt: "2026-09-01 16:12:00-04",
    });
    await listing("/shop/cigars/agent-auto/", {
      status: "auto",
      decidedBy: "agent",
      linked: true,
      updatedAt: "2026-09-01 16:13:00-04",
    });
    await listing("/shop/cigars/agent-unmatched/", {
      status: "unmatched",
      decidedBy: "agent",
      reason: "no_match",
      updatedAt: "2026-09-01 16:14:00-04",
    });
    await listing("/shop/cigars/curator-unmatched/", {
      status: "unmatched",
      decidedBy: "curator",
      updatedAt: "2026-09-01 16:15:00-04",
    });
    // A crawler row already unmatched WITH a reason, inside the window. It keeps
    // its reason: the migration nulls `unmatched_reason` only on the rows it is
    // actually reverting, and a reason somebody's resolver recorded is a
    // judgement about the listing.
    await listing("/shop/cigars/crawler-unmatched-reasoned/", {
      status: "unmatched",
      decidedBy: "crawler",
      reason: "ambiguous",
      updatedAt: "2026-09-01 16:16:00-04",
    });
  };

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();
    await migrate(pg.url, { migrationsDir: dirs.pre });
    // The vendor carries Fox's production id, because the migration's join names
    // it: an id that turns up on some other lane's row is not this run.
    await pg.db.execute(sql`
      INSERT INTO vendors (id, name, focus, crawl_enabled)
      VALUES (${FOX_VENDOR_ID}::uuid, 'Fox Cigar', 'NC', true)
    `);
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('CAO Flavours Moontrance Corona') RETURNING id`,
    );
    cigarId = (cigar.rows[0] as { id: string }).id;
    const giftCard = await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, catalog_status)
      VALUES ('Fox Cigar Gift Card', 'excluded') RETURNING id
    `);
    giftCardId = (giftCard.rows[0] as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    await pg?.stop();
    for (const d of Object.values(dirs ?? {})) rmSync(d, { recursive: true, force: true });
  });

  // FIRST, ON AN EMPTY TABLE. A migration that only works on the one database it
  // was written against fails on a fresh deploy, a restored backup or a
  // developer's box — and it fails at deploy time rather than in review.
  it("is a no-op on a database holding no listing matches at all", async () => {
    expect(await matchesNow()).toEqual([]);
    await expect(pg.db.execute(sql.raw(MIGRATION_SQL))).resolves.toBeDefined();
    expect(await matchesNow()).toEqual([]);
  });

  // THE PROVENANCE LOOKUP, ASSERTED BY ITS ABSENCE. The bounds are read off the
  // `crawl_runs` row rather than transcribed as literals, so on any database
  // that never held the run — every database but prod — the join produces no
  // rows and the statement touches nothing. Run here with the FULL fixture in
  // place, which is far stronger than an empty table: every row the window would
  // match is present, and none of them moves.
  it("updates nothing when the crawl run it names is not in this database", async () => {
    await seedListings();
    const runs = await pg.db.execute(sql`SELECT count(*)::int AS n FROM crawl_runs`);
    expect((runs.rows[0] as { n: number }).n).toBe(0);

    const before = await matchesNow();
    expect(before.filter((r) => r.status === "auto" && r.decided_by === "crawler")).toHaveLength(
      10,
    );

    await pg.db.execute(sql.raw(MIGRATION_SQL));
    expect(await matchesNow()).toEqual(before);
  });

  it("reverts exactly the run's own crawler auto-links and leaves every other row alone", async () => {
    await seedRun();

    // Through the real runner this time, so the file is proved to apply the way
    // a deploy applies it.
    await migrate(pg.url, { migrationsDir: dirs.only0032 });

    // THE BATCH MOVED, and moved to an honest absence: `unmatched`, no cigar, no
    // reason — the crawler writes the real reason when it re-decides the listing
    // — while `decided_by` STAYS 'crawler', because the crawler is still the
    // lane that owns these rows and the only one that can re-decide them.
    // `updated_at` and the parse evidence are untouched: the timestamp is the
    // only surviving mark of which run wrote the row.
    for (const key of IN_WINDOW) {
      const row = await one(key);
      expect(row, key).toMatchObject({
        key,
        status: "unmatched",
        decided_by: "crawler",
        reason: null,
        linked: false,
      });
    }
    // The parse and the breadcrumbs survive the revert intact.
    expect(await one(IN_WINDOW[0]!)).toEqual({
      key: IN_WINDOW[0]!,
      status: "unmatched",
      decided_by: "crawler",
      reason: null,
      linked: false,
      updated_utc: "2026-09-01 19:32:37.571",
      suggested_parse: { brandName: "CAO", lineName: "Flavours", vitolaName: "Corona" },
      category_path: ["Cigars", "Flavored"],
    });

    // EVERY OTHER ROW, ASSERTED ONE AT A TIME.
    //
    // Outside the window on the early side — the 68 rows prod holds from earlier
    // walks, and the row sitting exactly on the starting instant.
    expect(await one("/shop/cigars/earlier-walk-link/")).toMatchObject({
      status: "auto",
      decided_by: "crawler",
      linked: true,
    });
    expect(await one("/shop/cigars/at-the-starting-gun/")).toMatchObject({
      status: "auto",
      decided_by: "crawler",
      linked: true,
    });
    // Outside on the late side — THE END GUARD. Both of these are links the
    // fixed matcher would write after the deploy, and a revert with no upper
    // bound destroys them nightly.
    expect(await one("/shop/cigars/fixed-matcher-link/")).toMatchObject({
      status: "auto",
      decided_by: "crawler",
      linked: true,
    });
    expect(await one("/shop/cigars/one-ms-after-the-finish/")).toMatchObject({
      status: "auto",
      decided_by: "crawler",
      linked: true,
    });

    // Inside the window, decided by somebody else. A confirmed verdict is a
    // human or an agent saying "yes, this listing is that cigar"; a curator or
    // agent `auto` is held out by `decided_by` alone.
    expect(await one("/shop/cigars/agent-confirmed/")).toMatchObject({
      status: "confirmed",
      decided_by: "agent",
      linked: true,
    });
    expect(await one("/shop/cigars/curator-confirmed/")).toMatchObject({
      status: "confirmed",
      decided_by: "curator",
      linked: true,
    });
    expect(await one("/shop/cigars/curator-auto/")).toMatchObject({
      status: "auto",
      decided_by: "curator",
      linked: true,
    });
    expect(await one("/shop/cigars/agent-auto/")).toMatchObject({
      status: "auto",
      decided_by: "agent",
      linked: true,
    });
    expect(await one("/shop/cigars/agent-unmatched/")).toMatchObject({
      status: "unmatched",
      decided_by: "agent",
      reason: "no_match",
      linked: false,
    });
    expect(await one("/shop/cigars/curator-unmatched/")).toMatchObject({
      status: "unmatched",
      decided_by: "curator",
      reason: null,
      linked: false,
    });
    // Already unmatched, and its reason is a judgement the resolver recorded —
    // the null-out reaches only the rows actually being reverted.
    expect(await one("/shop/cigars/crawler-unmatched-reasoned/")).toMatchObject({
      status: "unmatched",
      decided_by: "crawler",
      reason: "ambiguous",
      linked: false,
    });

    // COUNT VALIDATION. Six rows sat inside the window as crawler `auto`; six
    // moved, and the four crawler links outside it are still linked. Stated as
    // counts as well as row by row, so a clause that widened the window would
    // have to defeat both.
    const rows = await matchesNow();
    expect(rows.filter((r) => r.status === "auto" && r.decided_by === "crawler")).toHaveLength(4);
    expect(
      rows.filter(
        (r) =>
          r.status === "unmatched" && r.decided_by === "crawler" && r.reason === null && !r.linked,
      ),
    ).toHaveLength(IN_WINDOW.length);
    // Nothing else in the table changed shape: 17 rows in, 17 rows out.
    expect(rows).toHaveLength(17);
  });

  // Re-runnable, which is what lets the suite replay the file and observe that a
  // second application changes nothing: the first execution moved every row the
  // `status='auto'` predicate can still find inside the window.
  it("changes nothing on a second application", async () => {
    const before = await matchesNow();
    await pg.db.execute(sql.raw(MIGRATION_SQL));
    expect(await matchesNow()).toEqual(before);
  });

  // The upper bound guards a moving target, so it is asserted a second time
  // against a row written AFTER the migration has already run — the ordinary
  // steady state from the deploy onwards. A revert that could still reach
  // forwards would show up as a repair that keeps un-repairing itself.
  it("leaves a link the fixed matcher writes after the deploy alone on any later replay", async () => {
    await listing("/shop/cigars/post-deploy-link/", {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: "2026-09-02 06:14:00-04",
    });
    await pg.db.execute(sql.raw(MIGRATION_SQL));
    expect(await one("/shop/cigars/post-deploy-link/")).toMatchObject({
      status: "auto",
      decided_by: "crawler",
      linked: true,
    });
  });

  // A `crawl_runs` row with no `finished_at` has no upper bound to offer, and a
  // NULL comparison would quietly match nothing while looking like it matched
  // everything. Asserted on a SECOND run's window so the guard is observed on
  // its own terms rather than through the already-reverted batch.
  //
  // Both timestamps sit in the PAST, deliberately: the tempting "fix" for a
  // missing bound is `coalesce(finished_at, now())`, which would sweep an
  // unfinished run's whole open window. A future-dated fixture would let that
  // mutation pass by accident, because the clock, not the guard, would be doing
  // the excluding.
  it("declines a run that has not finished rather than reverting on a null bound", async () => {
    await pg.db.execute(sql`
      INSERT INTO crawl_runs (id, vendor_id, kind, status, started_at, finished_at)
      VALUES (
        '9c1f0f2e-8d55-4a1a-9d4e-1f0a2b3c4d5e'::uuid,
        ${FOX_VENDOR_ID}::uuid, 'offers', 'running',
        '2026-08-25 09:00:00-04'::timestamptz, NULL
      )
    `);
    await listing("/shop/cigars/link-from-a-running-walk/", {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
      updatedAt: "2026-08-25 09:30:00-04",
    });

    // The same statement, aimed at the unfinished run: `finished_at IS NOT NULL`
    // is what stops it. Replaced globally — the id appears in the header as well
    // as in the join, and a first-occurrence swap would rewrite only the prose.
    await pg.db.execute(
      sql.raw(MIGRATION_SQL.replaceAll(RUN_ID, "9c1f0f2e-8d55-4a1a-9d4e-1f0a2b3c4d5e")),
    );
    expect(await one("/shop/cigars/link-from-a-running-walk/")).toMatchObject({
      status: "auto",
      decided_by: "crawler",
      linked: true,
    });
  });
});
