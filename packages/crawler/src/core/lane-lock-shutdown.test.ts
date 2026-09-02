import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { startTestPostgres } from "@cj/db/testing";
import { createDatabase, swallowShutdownErrors, vendors } from "@cj/db";
import { runFleet } from "./fleet.js";
import type { IngestResult } from "./ingest.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { cubanLous } from "../adapters/cuban-lous.js";

// WHAT A CNPG FAILOVER DOES TO A CRAWL IN FLIGHT.
//
// `withVendorLaneLock` holds a CHECKED-OUT client for the whole length of a
// vendor's run, and pg-pool removes its own error listener from a client on
// acquire — so when Postgres goes away, node-postgres raises the FATAL on the
// client itself, where a pool-level listener never sees it. Unlistened, that event
// kills the crawler outright: the `crawl_runs` row stays `running` until the #155
// sweep reclaims it the next night, and the remaining shops lose their night.
//
// The guard `cli.ts`'s `openDatabase` attaches is what makes the failover a RUN
// failure instead. This drives the real fleet walk against a server that really
// goes away mid-vendor, with the same pool wiring the CLI builds.

const succeeded = (): IngestResult => ({
  crawlRunId: null,
  status: "succeeded",
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

describe("a Postgres that goes away mid-crawl (embedded Postgres)", () => {
  it("fails the run and lets the fleet walk on, instead of killing the crawler", async () => {
    const pg = await startTestPostgres();
    // Exactly the wiring `cli.ts` builds for a `--all-enabled` run: one pool for
    // the lane locks and the queries, guarded once at the top.
    const { db, pool } = createDatabase(pg.url);
    swallowShutdownErrors(pool, { label: "crawl" });

    try {
      await pg.db.insert(vendors).values({ name: foxCigar.name, tier: 1, crawlEnabled: true });
      await pg.db.insert(vendors).values({ name: cubanLous.name, tier: 2, crawlEnabled: true });

      // 'acquire' observes without guarding — an 'error' listener of our own would
      // be a second guard and this test would pass with the fix reverted.
      const acquired: { listenerCount: (event: string) => number }[] = [];
      pool.on("acquire", (client) => acquired.push(client));

      const asked: string[] = [];
      let laneClientListeners = -1;

      const fleet = await runFleet(db, pool, {
        mode: "offers",
        runVendor: async (adapter) => {
          asked.push(adapter.slug);
          // The lane lock's client is checked out RIGHT NOW and pg-pool has taken
          // its listener off, so whatever is left is the production guard.
          laneClientListeners = acquired.at(-1)?.listenerCount("error") ?? -1;

          // The failover, in the middle of tier 1's run...
          await pg.stop();
          // ...and the next thing `runIngest` would have done.
          await db.execute(sql`SELECT 1`);
          return succeeded();
        },
      });

      expect(laneClientListeners).toBeGreaterThan(0);

      // Tier 2 never reaches its runner: the lane lock cannot even take a client
      // from a pool with no server behind it. It is still an OUTCOME, not a crash.
      expect(asked).toEqual(["fox-cigar"]);
      expect(fleet.outcomes.map((o) => [o.slug, o.status])).toEqual([
        ["fox-cigar", "failed"],
        ["cuban-lous", "failed"],
      ]);
      // Which is what the CLI turns into exit code 1 — the operator learns the
      // night was lost, which a killed process could not have told them.
      expect(fleet.failed).toBe(2);
      expect(fleet.outcomes[0]!.error).toBeTruthy();
      expect(fleet.outcomes[1]!.error).toBeTruthy();
    } finally {
      await pool.end().catch(() => {});
    }
  }, 60_000);
});
