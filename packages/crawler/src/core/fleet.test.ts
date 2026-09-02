import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { createDatabase, swallowShutdownErrors, vendors, crawlRuns, type Pool } from "@cj/db";
import { runFleet, selectEnabledFleet } from "./fleet.js";
import type { IngestResult } from "./ingest.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import { smallBatchCigar } from "../adapters/small-batch-cigar.js";
import type { VendorAdapter } from "../adapters/types.js";

// `--all-enabled` (ADR-015, closes #156). What is asserted here is ORDER and
// ISOLATION — the two properties the fleet walk exists to provide — so the crawl
// itself is injected: `runVendor` records who was asked and answers with a canned
// result. The real wiring (polite fetcher, storage, runIngest) is exercised
// vendor-by-vendor in ingest.test.ts, and duplicating it here would test the
// fetcher again instead of testing the loop.

describe("fleet walk (embedded Postgres)", () => {
  let pg: TestPostgres;
  let pool: Pool;

  beforeAll(async () => {
    pg = await startTestPostgres();
    // The lane lock is taken on a POOL connection (pg_try_advisory_lock is
    // session-scoped), so the fleet needs a real pool rather than the harness db.
    pool = createDatabase(pg.url).pool;
    // A pool of our own is a pool the harness does not guard. `createDatabase`
    // attaches no error listener — production pools outlive their server — and an
    // 'error' event with no listener is an UNHANDLED error that exits vitest 1 on
    // a green run. This file is the one that holds a CHECKED-OUT client (the lane
    // lock, and the `holder` below), which is the half `pool.on('error')` alone
    // never sees. Same discipline as the harness, from the same helper.
    swallowShutdownErrors(pool, { label: "fleet.test" });
  }, 60_000);

  afterAll(async () => {
    // Order matters as much as the swallow: the pool goes away BEFORE the server
    // it is connected to. `.catch` so a pool that will not end still cannot strand
    // an embedded Postgres.
    await pool?.end().catch(() => {});
    await pg?.stop();
  });

  const result = (status: "succeeded" | "failed"): IngestResult => ({
    crawlRunId: null,
    status,
    stats: {
      pagesFetched: 0,
      listingsParsed: 0,
      skippedNonCigar: 0,
      matchesAuto: 0,
      cigarsCreated: 0,
      offersWritten: 0,
      photosCaptured: 0,
      errors: 0,
    },
    report: [],
  });

  // A registry row for a real adapter, since the fleet joins registry to adapter
  // BY NAME — the same key `resolveVendor` looks a row up with.
  async function register(
    adapter: VendorAdapter,
    values: { tier: number; crawlEnabled?: boolean },
  ): Promise<string> {
    const rows = await pg.db
      .insert(vendors)
      .values({
        name: adapter.name,
        focus: adapter.focus ?? null,
        tier: values.tier,
        crawlEnabled: values.crawlEnabled ?? true,
      })
      .returning({ id: vendors.id });
    return rows[0]!.id;
  }

  async function clearRegistry(): Promise<void> {
    await pg.db.delete(crawlRuns);
    await pg.db.delete(vendors);
  }

  it("selects only enabled vendors, in tier order and then by name", async () => {
    await clearRegistry();
    await register(cubanLous, { tier: 2 });
    await register(smallBatchCigar, { tier: 1 });
    await register(foxCigar, { tier: 1 });
    // Enabled is the ONLY gate, and a disabled row is out however good its tier.
    await pg.db.insert(vendors).values({ name: "Dormant Shop", tier: 1, crawlEnabled: false });

    const fleet = await selectEnabledFleet(pg.db);
    // Tier first; inside tier 1, "2 Guys" would precede "Fox" — here it is Fox
    // before Small Batch, which is the name tiebreak doing its job.
    expect(fleet.map((v) => [v.tier, v.name])).toEqual([
      [1, "Fox Cigar"],
      [1, "Small Batch Cigar"],
      [2, "Cuban Lou's"],
    ]);
  });

  it("runs the fleet serially in tier order, one lane lock per vendor", async () => {
    await clearRegistry();
    const foxId = await register(foxCigar, { tier: 1 });
    const lousId = await register(cubanLous, { tier: 2 });

    const asked: string[] = [];
    const fleet = await runFleet(pg.db, pool, {
      mode: "enrich",
      runVendor: async (adapter, vendorId) => {
        asked.push(`${adapter.slug}:${vendorId}`);
        return result("succeeded");
      },
    });

    // TIER ORDER IS THE WHOLE POINT: tier 1's misses have to be in the ledger
    // before tier 2's open set is selected, or the fallback clause holds the ask
    // for another night.
    expect(asked).toEqual([`fox-cigar:${foxId}`, `cuban-lous:${lousId}`]);
    expect(fleet.outcomes.map((o) => [o.slug, o.status])).toEqual([
      ["fox-cigar", "succeeded"],
      ["cuban-lous", "succeeded"],
    ]);
    expect(fleet.failed).toBe(0);
  });

  // ISOLATION. The fleet's job is to reach every shop; one broken adapter must not
  // cost the rest their night, and the operator must still learn the run was bad.
  it("a vendor that fails does not stop the next, and the fleet reports the failure", async () => {
    await clearRegistry();
    await register(foxCigar, { tier: 1 });
    await register(smallBatchCigar, { tier: 1 });
    await register(cubanLous, { tier: 2 });

    const asked: string[] = [];
    const fleet = await runFleet(pg.db, pool, {
      mode: "offers",
      runVendor: async (adapter) => {
        asked.push(adapter.slug);
        // A run that CLOSED itself as failed (runIngest catches its own errors and
        // writes the crawl_runs row) …
        if (adapter.slug === "fox-cigar") return { ...result("failed"), error: "robots.txt disallows /" };
        // … and one that threw before there was a run row to close.
        if (adapter.slug === "small-batch-cigar") throw new Error("adapter exploded");
        return result("succeeded");
      },
    });

    expect(asked).toEqual(["fox-cigar", "small-batch-cigar", "cuban-lous"]);
    expect(fleet.outcomes.map((o) => [o.slug, o.status])).toEqual([
      ["fox-cigar", "failed"],
      ["small-batch-cigar", "failed"],
      ["cuban-lous", "succeeded"],
    ]);
    // Both failure shapes carry their reason to the summary an operator reads.
    expect(fleet.outcomes[0]!.error).toMatch(/robots\.txt/);
    expect(fleet.outcomes[1]!.error).toMatch(/adapter exploded/);
    // Which is what the CLI turns into exit code 1.
    expect(fleet.failed).toBe(2);
  });

  // An enabled row nothing can crawl is a registry/deploy mismatch. It is NAMED
  // and skipped, never silently dropped and never a failure — nothing went wrong,
  // there is simply no code for that shop.
  it("names an enabled vendor with no adapter and crawls on", async () => {
    await clearRegistry();
    await pg.db.insert(vendors).values({ name: "Unbuilt Cigar Co", tier: 1, crawlEnabled: true });
    await register(foxCigar, { tier: 2 });

    const seen: string[] = [];
    const fleet = await runFleet(pg.db, pool, {
      mode: "offers",
      runVendor: async () => result("succeeded"),
      onUnregistered: (name) => seen.push(name),
    });

    expect(seen).toEqual(["Unbuilt Cigar Co"]);
    expect(fleet.unregistered).toEqual(["Unbuilt Cigar Co"]);
    expect(fleet.outcomes.map((o) => o.slug)).toEqual(["fox-cigar"]);
    expect(fleet.failed).toBe(0);
  });

  // EACH VENDOR TAKES ITS OWN LANE LOCK, exactly as a `--vendor` run does (#157).
  // A held lock skips that vendor — no crawl_runs row, not a failure — and the
  // walk continues to the next, whose lane is its own.
  it("skips a vendor whose (vendor, mode) lane is already held, and keeps going", async () => {
    await clearRegistry();
    const foxId = await register(foxCigar, { tier: 1 });
    await register(cubanLous, { tier: 2 });

    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [`cj:crawl:${foxId}:offers`]);

      const asked: string[] = [];
      const fleet = await runFleet(pg.db, pool, {
        mode: "offers",
        runVendor: async (adapter) => {
          asked.push(adapter.slug);
          return result("succeeded");
        },
      });

      expect(asked).toEqual(["cuban-lous"]);
      expect(fleet.outcomes.map((o) => [o.slug, o.status])).toEqual([
        ["fox-cigar", "skipped"],
        ["cuban-lous", "succeeded"],
      ]);
      // A skip is the lock working, not an incident: it must not set the exit code.
      expect(fleet.failed).toBe(0);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  });

  // Reported, never applied: `--all-enabled` inherits the insert-if-absent rule, so
  // a row that disagrees with its adapter is named and left exactly as it stands.
  it("carries each vendor's posture drift without writing over the row", async () => {
    await clearRegistry();
    // Fox ships tier 1; this row says 4.
    const foxId = await register(foxCigar, { tier: 4 });

    const fleet = await runFleet(pg.db, pool, { mode: "offers", runVendor: async () => result("succeeded") });

    expect(fleet.outcomes[0]!.drift.map((d) => d.field)).toContain("tier");
    const row = await pg.db.select({ tier: vendors.tier }).from(vendors).where(eq(vendors.id, foxId));
    expect(row[0]!.tier).toBe(4);
  });
});
