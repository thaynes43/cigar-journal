import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { startRawTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// 0030, the ledger half of #240.
//
// The drain's slug prefilter was its own private matcher, and it scored zero on
// asks the vendors demonstrably stock. Every one of those zeroes was written to
// `enrichment_attempts` as `miss` — a claim that a shop's catalogue was read and
// the cigar was not in it — for a look that opened no page. Four nights, 58 of 58
// rows `miss`, no cigar enriched, and the queue clearing by exhaustion.
//
// So the migration does two things, and each is asserted here against the state
// prod actually held: it gives the outcome a look that read nothing may record,
// and it clears the verdicts the defect wrote off the still-open asks.
//
// The `no_candidate` outcome's own accounting — that it burns neither counter and
// can never retire an ask — is pinned in packages/domain/src/enrichment-coverage.test.ts;
// this file is only about the constraint and the data repair.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Everything before 0030 into `pre`, 0030 alone into `only0030`. The same split
// the 0026/0027/0029 suites use, and for the same reason: build the schema, seed
// the state the migration is meant to find, then apply the one file under test.
function splitMigrations(): { pre: string; only0030: string } {
  const pre = mkdtempSync(join(tmpdir(), "cj-mig-pre-0030-"));
  const only0030 = mkdtempSync(join(tmpdir(), "cj-mig-0030-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql")) continue;
    if (name.startsWith("0030")) copyFileSync(join(MIGRATIONS_DIR, name), join(only0030, name));
    else if (name < "0030") copyFileSync(join(MIGRATIONS_DIR, name), join(pre, name));
  }
  return { pre, only0030 };
}

// The file's own SQL, for the re-runs. `migrate()` records what it applied and
// skips it forever after — right for a deploy, useless for proving the STATEMENTS
// are idempotent.
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, "0030_enrich_no_candidate.sql"), "utf8");

interface AttemptRow {
  name: string;
  attempts: number;
  errors: number;
  last_outcome: string;
}

interface RequestRow {
  name: string;
  status: string;
  attempts: number;
  resolved: boolean;
}

describe("0030 enrich no_candidate", () => {
  let pg: TestPostgres;
  let dirs: { pre: string; only0030: string };
  let vendorId: string;

  const request = async (name: string, status: string, attempts: number): Promise<string> => {
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES (${name}) RETURNING id`,
    );
    const cigarId = (cigar.rows[0] as { id: string }).id;
    const rows = await pg.db.execute(sql`
      INSERT INTO enrichment_requests (cigar_id, status, attempts, resolved_at)
      VALUES (${cigarId}, ${status}, ${attempts},
              ${status === "fulfilled" || status === "exhausted" ? sql`now()` : sql`NULL`})
      RETURNING id
    `);
    return (rows.rows[0] as { id: string }).id;
  };

  const attempt = async (
    requestId: string,
    outcome: string,
    attempts: number,
    errors = 0,
  ): Promise<void> => {
    await pg.db.execute(sql`
      INSERT INTO enrichment_attempts (request_id, vendor_id, attempts, errors, last_outcome)
      VALUES (${requestId}, ${vendorId}, ${attempts}, ${errors}, ${outcome})
    `);
  };

  const attemptsNow = async (): Promise<AttemptRow[]> =>
    (
      await pg.db.execute(sql`
        SELECT c.canonical_name AS name, a.attempts, a.errors, a.last_outcome
          FROM enrichment_attempts a
          JOIN enrichment_requests r ON r.id = a.request_id
          JOIN cigars c ON c.id = r.cigar_id
         ORDER BY c.canonical_name
      `)
    ).rows as unknown as AttemptRow[];

  const requestsNow = async (): Promise<RequestRow[]> =>
    (
      await pg.db.execute(sql`
        SELECT c.canonical_name AS name, r.status, r.attempts, (r.resolved_at IS NOT NULL) AS resolved
          FROM enrichment_requests r
          JOIN cigars c ON c.id = r.cigar_id
         ORDER BY c.canonical_name
      `)
    ).rows as unknown as RequestRow[];

  beforeAll(async () => {
    pg = await startRawTestPostgres();
    dirs = splitMigrations();
    await migrate(pg.url, { migrationsDir: dirs.pre });
    const rows = await pg.db.execute(
      sql`INSERT INTO vendors (name, focus, crawl_enabled) VALUES ('Ledger Lane', 'NC', true) RETURNING id`,
    );
    vendorId = (rows.rows[0] as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    await pg?.stop();
    for (const d of Object.values(dirs ?? {})) rmSync(d, { recursive: true, force: true });
  });

  // FIRST, ON AN EMPTY LEDGER. A migration that only works on the one database it
  // was written against fails on a fresh deploy, a restored backup or a
  // developer's box — and it fails at deploy time rather than in review.
  it("is a no-op on a database holding no attempts at all", async () => {
    expect(await attemptsNow()).toEqual([]);
    await expect(pg.db.execute(sql.raw(MIGRATION_SQL))).resolves.toBeDefined();
    expect(await attemptsNow()).toEqual([]);
  });

  it("clears the miss ledger off the open asks and puts the exhausted ones back", async () => {
    // Prod's shape on 2026-09-01, in miniature. The two open rows carry the
    // verdicts the broken prefilter wrote; the fulfilled row is history.
    const pending = await request("Trinidad Media Luna", "pending", 1);
    await attempt(pending, "miss", 1);
    const exhausted = await request("Red Anchor Captain", "exhausted", 2);
    await attempt(exhausted, "miss", 2);
    const fulfilled = await request("Oliva Serie V Melanio Torpedo", "fulfilled", 1);
    await attempt(fulfilled, "match", 1);

    // Through the real runner this time, so the file is proved to apply the way a
    // deploy applies it.
    await migrate(pg.url, { migrationsDir: dirs.only0030 });

    // The open asks lose their ledger entirely — every row on them was a `miss`.
    // The fulfilled ask keeps its `match`: that is the trail behind a real link,
    // and rewriting it would be inventing history rather than clearing a defect.
    expect(await attemptsNow()).toEqual([
      { name: "Oliva Serie V Melanio Torpedo", attempts: 1, errors: 0, last_outcome: "match" },
    ]);

    // ...and the requests follow the ledger. `exhausted` was a rollup over rows
    // that no longer exist, so the ask goes back to `pending` with `resolved_at`
    // cleared and its reporting total re-derived from what survives.
    expect(await requestsNow()).toEqual([
      { name: "Oliva Serie V Melanio Torpedo", status: "fulfilled", attempts: 1, resolved: true },
      { name: "Red Anchor Captain", status: "pending", attempts: 0, resolved: false },
      { name: "Trinidad Media Luna", status: "pending", attempts: 0, resolved: false },
    ]);
  });

  // The two narrowings that keep this from being a blunt DELETE. Neither row
  // exists on prod today; the predicates are here so one written between review
  // and deploy is not swept up by accident.
  it("keeps a photo refusal, and re-derives attempts from whatever survives", async () => {
    const refused = await request("Padron 1926 No 6", "pending", 3);
    // #209: the lane found the cigar, linked it, and was refused the one photo
    // slot. It burns no budget, so it holds nothing open — and it is the only
    // honest answer to "why will this ask never clear?".
    await attempt(refused, "photo_refused", 0);
    // Two lanes on one ask: one wrote the defective `miss`, the other a real
    // `match`. Only the first is cleared, and the request's total follows.
    const mixed = await request("Cohiba Siglo VI", "exhausted", 9);
    await attempt(mixed, "miss", 2);
    const secondLane = await pg.db.execute(
      sql`INSERT INTO vendors (name, focus, crawl_enabled) VALUES ('Second Lane', 'NC', true) RETURNING id`,
    );
    await pg.db.execute(sql`
      INSERT INTO enrichment_attempts (request_id, vendor_id, attempts, errors, last_outcome)
      VALUES (${mixed}, ${(secondLane.rows[0] as { id: string }).id}, 1, 0, 'match')
    `);

    await pg.db.execute(sql.raw(MIGRATION_SQL));

    const rows = await attemptsNow();
    expect(rows.filter((r) => r.name === "Padron 1926 No 6")).toEqual([
      { name: "Padron 1926 No 6", attempts: 0, errors: 0, last_outcome: "photo_refused" },
    ]);
    // The `miss` went, the `match` stayed, and the request's reporting total is
    // recomputed from the survivor rather than zeroed — the two numbers mean the
    // same thing and must never disagree.
    expect(rows.filter((r) => r.name === "Cohiba Siglo VI")).toEqual([
      { name: "Cohiba Siglo VI", attempts: 1, errors: 0, last_outcome: "match" },
    ]);
    const requests = await requestsNow();
    expect(requests.find((r) => r.name === "Cohiba Siglo VI")).toEqual({
      name: "Cohiba Siglo VI",
      status: "pending",
      attempts: 1,
      resolved: false,
    });
    expect(requests.find((r) => r.name === "Padron 1926 No 6")).toEqual({
      name: "Padron 1926 No 6",
      status: "pending",
      attempts: 0,
      resolved: false,
    });
  });

  // Re-runnable, which is what lets the suite replay the file and observe that a
  // second application changes nothing.
  it("changes nothing on a second application", async () => {
    const before = { attempts: await attemptsNow(), requests: await requestsNow() };
    await pg.db.execute(sql.raw(MIGRATION_SQL));
    expect({ attempts: await attemptsNow(), requests: await requestsNow() }).toEqual(before);
  });

  it("admits no_candidate as an attempt outcome and still refuses an unknown one", async () => {
    const check = await pg.db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'enrichment_attempts'::regclass
         AND conname = 'enrichment_attempts_last_outcome_check'
    `);
    const def = (check.rows as { def: string }[])[0]?.def ?? "";
    // The four that were already there keep their meanings — a widened CHECK that
    // dropped one would deploy green and fail on the next drain.
    for (const outcome of ["miss", "match", "error", "photo_refused", "no_candidate"]) {
      expect(def).toMatch(new RegExp(outcome));
    }

    const open = await request("Vegas Robaina Famosos", "pending", 0);
    await expect(attempt(open, "no_candidate", 0)).resolves.toBeUndefined();
    const invented = await request("Quai d'Orsay No 54", "pending", 0);
    await expect(attempt(invented, "nearly", 0)).rejects.toThrow();
  });
});
