import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// 0031, the bulk half of issue 245.
//
// A curation sweep once wrote `status='unmatched'` across the Fox catalogue with
// no reason and no cigar — a bulk pass, not a per-listing judgement — and
// `decided_by='agent'` froze all 881 of those rows against the only lanes that
// could re-decide them. The migration hands exactly that population back to the
// crawler and touches nothing else.
//
// "Nothing else" is the entire risk surface, so this file spends most of its
// length on the four kinds of row that must survive untouched: a reasoned agent
// unmatch, a curator verdict, an agent row holding a link, and a confirmed row.
// Each is asserted individually rather than by a single count, because a count
// that happens to come out right can still be right for the wrong rows.
//
// The predicate itself is shared with the crawler's per-listing claim
// (`claimAgentUnmatched` in packages/crawler/src/core/match.ts); its behaviour at
// the write site is pinned in that package's own suite. This file is only about
// the data repair.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Everything before 0031 into `pre`, 0031 alone into `only0031`. The same split
// the 0026/0027/0029/0030 suites use, and for the same reason: build the schema,
// seed the state the migration is meant to find, then apply the one file under
// test.
function splitMigrations(): { pre: string; only0031: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-0031-"));
  const only0031 = mkdtempSync(join(tmpdir(), "cj-mig-0031-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    if (name.startsWith("0031")) copyFileSync(join(MIGRATIONS_DIR, name), join(only0031, name));
    else if (name < "0031") copyFileSync(join(MIGRATIONS_DIR, name), join(pre, name));
  }
  return { pre, only0031 };
}

// The file's own SQL, for the re-runs. `migrate()` records what it applied and
// skips it forever after — right for a deploy, useless for proving the STATEMENT
// is idempotent.
const MIGRATION_SQL = readFileSync(
  join(MIGRATIONS_DIR, "0031_requeue_bulk_agent_unmatched.sql"),
  "utf8",
);

interface MatchRow {
  key: string;
  status: string;
  decided_by: string;
  reason: string | null;
  linked: boolean;
}

describe("0031 requeue bulk agent unmatched", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0031: string };
  let vendorId: string;
  let cigarId: string;

  // One listing row, in whatever shape the case under test needs. `listing_key`
  // doubles as the row's name in every assertion below.
  const listing = async (
    key: string,
    opts: {
      status: string;
      decidedBy: string;
      reason?: string | null;
      linked?: boolean;
    },
  ): Promise<void> => {
    await pg.db.execute(sql`
      INSERT INTO listing_matches (vendor_id, listing_key, cigar_id, status, decided_by, unmatched_reason)
      VALUES (
        ${vendorId},
        ${key},
        ${opts.linked ? cigarId : null},
        ${opts.status},
        ${opts.decidedBy},
        ${opts.reason ?? null}
      )
    `);
  };

  const matchesNow = async (): Promise<MatchRow[]> =>
    (
      await pg.db.execute(sql`
        SELECT listing_key AS key, status, decided_by, unmatched_reason AS reason,
               (cigar_id IS NOT NULL) AS linked
          FROM listing_matches
         ORDER BY listing_key
      `)
    ).rows as unknown as MatchRow[];

  const one = async (key: string): Promise<MatchRow | undefined> =>
    (await matchesNow()).find((r) => r.key === key);

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();
    await migrate(pg.url, { migrationsDir: dirs.pre });
    const vendor = await pg.db.execute(
      sql`INSERT INTO vendors (name, focus, crawl_enabled) VALUES ('Sweep Lane', 'NC', true) RETURNING id`,
    );
    vendorId = (vendor.rows[0] as { id: string }).id;
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Drew Estate Undercrown 10') RETURNING id`,
    );
    cigarId = (cigar.rows[0] as { id: string }).id;
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

  it("returns the reasonless bulk verdicts to the crawler and leaves every other row alone", async () => {
    // Prod's shape on 2026-09-01, in miniature — one row of each kind the
    // catalogue actually holds.

    // The population. Reasonless, linkless, `agent`: the bulk sweep's output,
    // and the only thing this migration is for.
    await listing("/shop/cigars/liga-privada-no-9-corona-doble-2/", {
      status: "unmatched",
      decidedBy: "agent",
    });
    await listing("/shop/cigars/tatuaje-skinny-monsters-frank-2/", {
      status: "unmatched",
      decidedBy: "agent",
    });

    // A REASONED agent unmatch. The reason IS the per-listing judgement whose
    // absence defines the population above, so this row was decided and stays
    // decided.
    await listing("/shop/cigars/reasoned-no-match/", {
      status: "unmatched",
      decidedBy: "agent",
      reason: "no_match",
    });
    await listing("/shop/cigars/reasoned-ambiguous/", {
      status: "unmatched",
      decidedBy: "agent",
      reason: "ambiguous",
    });

    // A CURATOR verdict — the owner's own, never in scope under any reading.
    // Given the reasonless shape deliberately: `decided_by` is the only thing
    // keeping it out, so if that clause were dropped this row would move.
    await listing("/shop/cigars/curator-swept/", {
      status: "unmatched",
      decidedBy: "curator",
    });

    // An agent row HOLDING A LINK. A link is a judgement whatever the status
    // beside it says; `cigar_id IS NULL` is what excludes it.
    await listing("/shop/cigars/agent-linked-unmatched/", {
      status: "unmatched",
      decidedBy: "agent",
      linked: true,
    });

    // CONFIRMED, by the agent — "yes, this listing is that cigar". Untouchable,
    // and the crawler guards it first and separately at the write site.
    await listing("/shop/cigars/god-of-fire-serie-b-robusto-tubo-2/", {
      status: "confirmed",
      decidedBy: "agent",
      linked: true,
    });

    // An already-crawler-owned link, to prove the statement is not rewriting
    // rows that merely satisfy some of its clauses.
    await listing("/shop/cigars/crawler-auto/", {
      status: "auto",
      decidedBy: "crawler",
      linked: true,
    });

    // Through the real runner this time, so the file is proved to apply the way a
    // deploy applies it.
    await migrate(pg.url, { migrationsDir: dirs.only0031 });

    // THE POPULATION MOVED — and moved ONLY in `decided_by`. `status` stays
    // `unmatched` and `cigar_id` stays null, because the migration re-opens the
    // question rather than answering it; the seed and offers walks answer it.
    for (const key of [
      "/shop/cigars/liga-privada-no-9-corona-doble-2/",
      "/shop/cigars/tatuaje-skinny-monsters-frank-2/",
    ]) {
      expect(await one(key)).toEqual({
        key,
        status: "unmatched",
        decided_by: "crawler",
        reason: null,
        linked: false,
      });
    }

    // EVERY OTHER ROW, ASSERTED ONE AT A TIME. A count would pass here for the
    // wrong reasons; these will not.
    expect(await one("/shop/cigars/reasoned-no-match/")).toEqual({
      key: "/shop/cigars/reasoned-no-match/",
      status: "unmatched",
      decided_by: "agent",
      reason: "no_match",
      linked: false,
    });
    expect(await one("/shop/cigars/reasoned-ambiguous/")).toEqual({
      key: "/shop/cigars/reasoned-ambiguous/",
      status: "unmatched",
      decided_by: "agent",
      reason: "ambiguous",
      linked: false,
    });
    expect(await one("/shop/cigars/curator-swept/")).toEqual({
      key: "/shop/cigars/curator-swept/",
      status: "unmatched",
      decided_by: "curator",
      reason: null,
      linked: false,
    });
    expect(await one("/shop/cigars/agent-linked-unmatched/")).toEqual({
      key: "/shop/cigars/agent-linked-unmatched/",
      status: "unmatched",
      decided_by: "agent",
      reason: null,
      linked: true,
    });
    expect(await one("/shop/cigars/god-of-fire-serie-b-robusto-tubo-2/")).toEqual({
      key: "/shop/cigars/god-of-fire-serie-b-robusto-tubo-2/",
      status: "confirmed",
      decided_by: "agent",
      reason: null,
      linked: true,
    });
    expect(await one("/shop/cigars/crawler-auto/")).toEqual({
      key: "/shop/cigars/crawler-auto/",
      status: "auto",
      decided_by: "crawler",
      reason: null,
      linked: true,
    });

    // No agent row is left in the swept shape — the positive statement of the
    // same fact, so a future clause that narrowed the UPDATE too far would fail
    // here rather than pass quietly.
    const stragglers = (await matchesNow()).filter(
      (r) => r.decided_by === "agent" && r.status === "unmatched" && r.reason === null && !r.linked,
    );
    expect(stragglers).toEqual([]);
  });

  // Re-runnable, which is what lets the suite replay the file and observe that a
  // second application changes nothing: the first execution is what removed every
  // row the WHERE clause can still find.
  it("changes nothing on a second application", async () => {
    const before = await matchesNow();
    await pg.db.execute(sql.raw(MIGRATION_SQL));
    expect(await matchesNow()).toEqual(before);
  });
});
