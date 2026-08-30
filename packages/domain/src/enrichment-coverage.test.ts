import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { crawlRuns, enrichmentAttempts, enrichmentRequests, vendors } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { maybeQueueEnrichment } from "./enrichment.js";
import {
  ATTEMPTS_PER_VENDOR,
  ERROR_BUDGET,
  coversMarketSql,
  enrichVendorFleet,
  enrichmentCoverageForCigar,
  enrichmentCoverageForRequest,
  liveEnrichMarkets,
  recordEnrichmentAttempt,
  vendorNotRetiredSql,
} from "./enrichment-coverage.js";

// The vendor dimension (#158, migration 0023). Every assertion here exists because
// a vendor's catalogue is PARTIAL: "no match at Fox" is evidence about Fox, and a
// budget that does not name a vendor retires a request after one look from each.
//
// Each case gets its OWN vendors — eligibility is a fleet-wide fact, so a leaked
// vendor from a neighbouring case would silently change another's denominator.
// They are disabled at the end of the case that made them for exactly that reason.

describe("enrichment coverage", () => {
  let h: DomainHarness;
  const at = new Date("2026-08-30T12:00:00.000Z");

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // Vendors are fleet-wide. Every case opens with a clean slate so its denominator
  // is exactly the vendors it created.
  async function clearFleet(): Promise<void> {
    await h.deps.db.update(vendors).set({ crawlEnabled: false });
  }

  // `enrichRun` defaults to TRUE because the exhaustion denominator is LIVENESS,
  // not `crawl_enabled` — a vendor whose lane has never run counts against
  // nothing. Cases that want the prod Cuban Lou's shape pass `enrichRun: false`
  // explicitly, and they are the interesting ones.
  async function makeVendor(
    name: string,
    focus: "NC" | "CC" | "both" | null,
    opts: { crawlEnabled?: boolean; enrichRun?: boolean } = {},
  ): Promise<string> {
    const rows = await h.deps.db
      .insert(vendors)
      .values({
        name: `${name} ${newRequestId().slice(0, 8)}`,
        focus,
        crawlEnabled: opts.crawlEnabled ?? true,
      })
      .returning({ id: vendors.id });
    const vendorId = rows[0]!.id;
    if (opts.enrichRun ?? true) {
      await h.deps.db.insert(crawlRuns).values({ vendorId, kind: "enrich", status: "succeeded" });
    }
    return vendorId;
  }

  async function makeRequest(type: "NC" | "CC" | null, name = "Coverage"): Promise<{ cigarId: string; requestId: string }> {
    const cigarId = await h.seedCigar({ canonicalName: `${name} ${newRequestId().slice(0, 8)}`, type });
    const rows = await h.deps.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "pending" })
      .returning({ id: enrichmentRequests.id });
    return { cigarId, requestId: rows[0]!.id };
  }

  async function spend(requestId: string, vendorId: string, looks = ATTEMPTS_PER_VENDOR): Promise<void> {
    for (let i = 0; i < looks; i += 1) {
      await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "miss", at });
    }
  }

  async function ledger(requestId: string, vendorId: string) {
    const rows = await h.deps.db
      .select()
      .from(enrichmentAttempts)
      .where(sql`${enrichmentAttempts.requestId} = ${requestId} AND ${enrichmentAttempts.vendorId} = ${vendorId}`);
    return rows[0];
  }

  // --- the one shared predicate ------------------------------------------

  // A NEGATIVE filter only: it excludes when both sides are known and disagree,
  // and never claims a vendor DOES carry something. Unknown on either side means
  // the vendor must still be asked — guessing is how a CC row gets retired by an
  // NC-only fleet.
  //
  // Asserted through the SQL builder rather than a TypeScript twin, because the
  // SQL is what actually runs: the rollup and the crawler's drain both call
  // coversMarketSql, with the operands on opposite sides, and a TS copy that no
  // production caller uses can be "tightened" green while neither changes
  // behaviour (#158 review).
  it("coversMarketSql excludes only a known mismatch, whichever side is bound", async () => {
    const cases: [string | null, string | null, boolean][] = [
      ["NC", "NC", true],
      ["NC", "CC", false],
      ["CC", "NC", false],
      ["both", "CC", true],
      ["both", "NC", true],
      // Unknown cigar market: every vendor might carry it, so every vendor is asked.
      ["NC", null, true],
      ["CC", null, true],
      // Unknown vendor focus: same reasoning from the other side.
      [null, "CC", true],
      [null, null, true],
    ];
    for (const [focus, type, expected] of cases) {
      const rows = await h.deps.db.execute(
        sql`SELECT ${coversMarketSql(sql`${focus}::text`, sql`${type}::text`)} AS covers`,
      );
      expect([focus, type, (rows.rows[0] as { covers: boolean }).covers]).toEqual([focus, type, expected]);
    }
  });

  // The drain's "which requests has this vendor NOT spent?" has to be the exact
  // complement of the rollup's retirement test. Two hand-written copies is how a
  // drain ends up re-fetching every night a request the rollup wrote off, so both
  // come from vendorNotRetiredSql and this walks the boundary.
  it("vendorNotRetiredSql is the exact complement of the rollup's retirement", async () => {
    const cases: [number, number, boolean][] = [
      [0, 0, true],
      [ATTEMPTS_PER_VENDOR - 1, 0, true],
      [ATTEMPTS_PER_VENDOR, 0, false],
      [0, ERROR_BUDGET - 1, true],
      [0, ERROR_BUDGET, false],
      [ATTEMPTS_PER_VENDOR - 1, ERROR_BUDGET, false],
    ];
    for (const [attempts, errors, selectable] of cases) {
      const rows = await h.deps.db.execute(
        sql`SELECT ${vendorNotRetiredSql(sql`${attempts}::int`, sql`${errors}::int`)} AS open`,
      );
      expect([attempts, errors, (rows.rows[0] as { open: boolean }).open]).toEqual([attempts, errors, selectable]);
    }

    // ...and the rollup agrees, end to end: a vendor at the attempt boundary
    // retires the request, one short of it does not.
    await clearFleet();
    const only = await makeVendor("Boundary", "NC");
    const { requestId } = await makeRequest("NC");
    await spend(requestId, only, ATTEMPTS_PER_VENDOR - 1);
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(false);
    await spend(requestId, only, 1);
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(true);
  });

  // --- eligibility vs liveness ---------------------------------------------

  it("the fleet is crawl_enabled x focus; `live` additionally needs a succeeded enrich run", async () => {
    await clearFleet();
    const nc = await makeVendor("Elig NC", "NC", { enrichRun: false });
    const cc = await makeVendor("Elig CC", "CC", { enrichRun: false });
    const both = await makeVendor("Elig Both", "both", { enrichRun: false });
    const unknownFocus = await makeVendor("Elig Unknown", null, { enrichRun: false });
    const disabled = await makeVendor("Elig Off", "NC", { crawlEnabled: false });

    const ids = async (type: "NC" | "CC" | null) =>
      (await enrichVendorFleet(h.deps.db, type)).map((v) => v.vendorId).sort();

    expect(await ids("NC")).toEqual([nc, both, unknownFocus].sort());
    expect(await ids("CC")).toEqual([cc, both, unknownFocus].sort());
    // An untyped cigar could be either market, so EVERY enabled vendor is in the
    // fleet — the negative filter cannot rule any of them out.
    expect(await ids(null)).toEqual([nc, cc, both, unknownFocus].sort());
    expect(await ids("NC")).not.toContain(disabled);

    // None of them has run an enrich pass, so none is live and no market is
    // enriched. Nothing here counts toward exhaustion.
    expect((await enrichVendorFleet(h.deps.db, null)).some((v) => v.live)).toBe(false);
    expect([...(await liveEnrichMarkets(h.deps.db))]).toEqual([]);

    await h.deps.db.insert(crawlRuns).values({ vendorId: nc, kind: "enrich", status: "succeeded" });
    expect((await enrichVendorFleet(h.deps.db, "NC")).filter((v) => v.live).map((v) => v.vendorId)).toEqual([nc]);
    expect([...(await liveEnrichMarkets(h.deps.db))].sort()).toEqual(["NC"]);
    // A `seed` run is not an enrich lane — the prod shape this gate was written for.
    await h.deps.db.insert(crawlRuns).values({ vendorId: cc, kind: "seed", status: "succeeded" });
    expect((await enrichVendorFleet(h.deps.db, "CC")).filter((v) => v.live).map((v) => v.vendorId)).toEqual([]);
    expect([...(await liveEnrichMarkets(h.deps.db))].sort()).toEqual(["NC"]);

    // The one place a NULL focus is treated differently, and deliberately: it
    // cannot be used to CLAIM a market is covered (a positive claim), but it
    // cannot be ruled out of a cigar's fleet either (the negative filter).
    await h.deps.db.insert(crawlRuns).values({ vendorId: unknownFocus, kind: "enrich", status: "succeeded" });
    expect([...(await liveEnrichMarkets(h.deps.db))].sort()).toEqual(["NC"]);
    expect(
      (await enrichVendorFleet(h.deps.db, "CC")).filter((v) => v.live).map((v) => v.vendorId),
    ).toEqual([unknownFocus]);
  });

  // THE BLOCKER THIS ROUND FIXED (#158 review, verified against prod). The
  // denominator cannot be `crawl_enabled`: nothing in the crawler reads that flag
  // (#156) — the CronJob list is the real crawl gate — so an enabled vendor with a
  // suspended lane can never fill it. Prod is exactly this shape: Fox Cigar (NC)
  // runs nightly, Cuban Lou's (CC) is crawl_enabled with a suspended enrich
  // CronJob and only a `seed` run to its name, and 890 of 977 catalog rows are
  // untyped — so they need BOTH markets and Cuban Lou's sat in every one of their
  // denominators forever. Untouchable by `retryExhausted` too: never `exhausted`
  // means `already_queued` for good.
  it("a vendor whose enrich lane has never run holds nothing open", async () => {
    await clearFleet();
    const fox = await makeVendor("Fox Cigar", "NC");
    const cubanLous = await makeVendor("Cuban Lou's", "CC", { enrichRun: false });
    const { requestId } = await makeRequest(null, "Untyped Prod Shape");

    // Both are in the untyped cigar's fleet — the negative filter rules out
    // neither — but only the lane that runs counts against it.
    const coverage0 = await enrichmentCoverageForRequest(h.deps.db, requestId, null);
    expect(coverage0.eligible.map((v) => v.vendorId).sort()).toEqual([fox, cubanLous].sort());
    expect(coverage0.live.map((v) => v.vendorId)).toEqual([fox]);

    await spend(requestId, fox);
    const coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, null);
    expect(coverage.exhausted).toBe(true);
    expect(coverage.blocked).toBe(false);
    expect(coverage.openRequests).toBe(0);
    expect(coverage.tried.map((v) => v.vendorId)).toEqual([fox]);

    // ...and the consequence that makes it safe: the moment Cuban Lou's lane
    // completes a run it joins the denominator, and the request it has not looked
    // at reopens on its own. No reopen job, no backfill.
    await h.deps.db.insert(crawlRuns).values({ vendorId: cubanLous, kind: "enrich", status: "succeeded" });
    const reopened = await enrichmentCoverageForRequest(h.deps.db, requestId, null);
    expect(reopened.exhausted).toBe(false);
    expect(reopened.openRequests).toBe(1);
    expect(reopened.live.map((v) => v.vendorId).sort()).toEqual([fox, cubanLous].sort());
  });

  // A lane's own first night must not read as a lag. During that run its crawl_run
  // is still `running`, so the succeeded-run test alone would leave it out of its
  // own denominator for one pass; a look it has ALREADY recorded on this request is
  // the same demonstration, one run earlier.
  it("a lane counts on a request it has already looked at, run row or not", async () => {
    await clearFleet();
    const running = await makeVendor("First Night", "NC", { enrichRun: false });
    const { requestId } = await makeRequest("NC");

    await spend(requestId, running, 1);
    let coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.live).toHaveLength(0);
    expect(coverage.exhausted).toBe(false);
    expect(coverage.openRequests).toBe(1);

    await spend(requestId, running, 1);
    coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(true);
  });

  // --- the atomic upsert ----------------------------------------------------

  // #157 defect 1 degraded. The pre-0023 drain read `attempts` and wrote back
  // `attempts + 1`, so two overlapping runs both read 0 and both wrote 1 — one real
  // look silently lost.
  //
  // The property that fixes it is that the increment is RELATIVE to the stored
  // value, so it names an existing row's counter and can never carry a stale one.
  // Asserting `attempts === 2` after two calls does not show that (#158 review):
  // two sequential calls produce the same 2, and a read-modify-write would too.
  // Seeding a value the caller never saw is what distinguishes them.
  it("recordEnrichmentAttempt increments the STORED counter, never a value it computed", async () => {
    await clearFleet();
    const vendorId = await makeVendor("Upsert", "NC");
    const { requestId } = await makeRequest("NC");

    // A count this process never read. A read-modify-write that had cached the
    // row's previous state would write 1 here; the SQL increment writes 8.
    await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "miss", at });
    await h.deps.db
      .update(enrichmentAttempts)
      .set({ attempts: 7 })
      .where(sql`${enrichmentAttempts.requestId} = ${requestId} AND ${enrichmentAttempts.vendorId} = ${vendorId}`);
    await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "miss", at });
    expect((await ledger(requestId, vendorId))!.attempts).toBe(8);

    // And two overlapping looks both land, which is the shape the drain produces.
    const second = await makeRequest("NC");
    await Promise.all([
      recordEnrichmentAttempt(h.deps.db, { requestId: second.requestId, vendorId, outcome: "miss", at }),
      recordEnrichmentAttempt(h.deps.db, { requestId: second.requestId, vendorId, outcome: "miss", at }),
    ]);
    const row = await ledger(second.requestId, vendorId);
    expect(row!.attempts).toBe(2);
    expect(row!.errors).toBe(0);
    expect(row!.lastOutcome).toBe("miss");
  });

  // A failed look is not evidence about a catalogue, so it never burns `attempts` —
  // but it is bounded, and a completed look clears the streak because the budget is
  // for CONSECUTIVE failures.
  it("errors accrue separately, retire the vendor at ERROR_BUDGET, and reset on a completed look", async () => {
    await clearFleet();
    const vendorId = await makeVendor("Errors", "NC");
    const { requestId } = await makeRequest("NC");

    for (let i = 0; i < ERROR_BUDGET - 1; i += 1) {
      await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "error", at });
    }
    let row = await ledger(requestId, vendorId);
    expect(row!.attempts).toBe(0);
    expect(row!.errors).toBe(ERROR_BUDGET - 1);
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(false);

    await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "miss", at });
    row = await ledger(requestId, vendorId);
    expect(row!.errors).toBe(0);
    expect(row!.attempts).toBe(1);

    for (let i = 0; i < ERROR_BUDGET; i += 1) {
      await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "error", at });
    }
    // Retired, and NOT exhausted: it never finished its second look, so nothing
    // here is evidence about a catalogue. See the case below.
    const errored = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(errored.exhausted).toBe(false);
    expect(errored.blocked).toBe(true);
  });

  // THE SECOND FINDING THIS ROUND FIXED (#158 review). Burning ERROR_BUDGET is not
  // a spent attempt budget: a request retired that way has ZERO completed looks,
  // and reporting it `exhausted` launders "nobody could look" into "we looked and
  // found nothing" — the one distinction this module exists to preserve, per the
  // header above and the ADR amendment.
  it("a vendor that only ever errored blocks the request, it does not exhaust it", async () => {
    await clearFleet();
    const only = await makeVendor("Sitemap 404", "NC");
    const { cigarId, requestId } = await makeRequest("NC");

    for (let i = 0; i < ERROR_BUDGET; i += 1) {
      await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId: only, outcome: "error", at });
    }

    const coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(false);
    expect(coverage.blocked).toBe(true);
    // Retired all the same — the drain will not select it again — so it is not
    // left counting as open work either.
    expect(coverage.openRequests).toBe(0);
    expect(coverage.tried[0]!.attempts).toBe(0);
    expect(coverage.tried[0]!.errors).toBe(ERROR_BUDGET);
    expect((await enrichmentCoverageForCigar(h.deps.db, cigarId, "NC")).blocked).toBe(true);
  });

  // The mixed fleet: one lane looked and does not carry it, another could not be
  // reached. Not exhaustion — the fleet did not finish — even though the request is
  // retired everywhere.
  it("one unreachable lane blocks a request the others exhausted", async () => {
    await clearFleet();
    const looked = await makeVendor("Answered", "NC");
    const broken = await makeVendor("Unreachable", "NC");
    const { requestId } = await makeRequest("NC");

    await spend(requestId, looked);
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(false);

    for (let i = 0; i < ERROR_BUDGET; i += 1) {
      await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId: broken, outcome: "error", at });
    }
    const coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(false);
    expect(coverage.blocked).toBe(true);

    // A completed look clears the streak, and then the fleet really has finished.
    await spend(requestId, broken);
    const finished = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(finished.exhausted).toBe(true);
    expect(finished.blocked).toBe(false);
  });

  // --- the rollup -----------------------------------------------------------

  // THE #158 REGRESSION at the rollup level: one lane spending its whole budget
  // retires nothing while another lane that runs has never been asked.
  it("exhausted requires EVERY lane that runs to be spent", async () => {
    await clearFleet();
    const a = await makeVendor("Roll A", "NC");
    const b = await makeVendor("Roll B", "NC");
    const { cigarId, requestId } = await makeRequest("NC");

    await spend(requestId, a);
    let coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(false);
    expect(coverage.openRequests).toBe(1);
    expect(coverage.live.map((v) => v.vendorId).sort()).toEqual([a, b].sort());
    expect(coverage.tried).toHaveLength(1);
    expect(coverage.tried[0]!.attempts).toBe(ATTEMPTS_PER_VENDOR);

    await spend(requestId, b);
    coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(true);
    expect(coverage.openRequests).toBe(0);
    expect(coverage.tried.map((v) => v.vendorId).sort()).toEqual([a, b].sort());

    // Cigar-level agrees with request-level for a single-request cigar.
    expect((await enrichmentCoverageForCigar(h.deps.db, cigarId, "NC")).exhausted).toBe(true);
  });

  // A CC-only vendor is not in an NC cigar's denominator at all, so it can neither
  // retire the request nor keep it open.
  it("focus is a negative filter: an out-of-market vendor is not in the denominator", async () => {
    await clearFleet();
    const nc = await makeVendor("Focus NC", "NC");
    await makeVendor("Focus CC", "CC");
    const { requestId } = await makeRequest("NC");

    await spend(requestId, nc);
    const coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.eligible.map((v) => v.vendorId)).toEqual([nc]);
    expect(coverage.live.map((v) => v.vendorId)).toEqual([nc]);
    expect(coverage.exhausted).toBe(true);
  });

  // "Nobody could look" is not "we looked and found nothing", and laundering one
  // into the other is what the ADR amendment forbids.
  it("zero counted lanes is NOT exhausted, and re-enabling restores the old ledger", async () => {
    await clearFleet();
    const only = await makeVendor("Solo", "NC");
    const { requestId } = await makeRequest("NC");
    await spend(requestId, only);
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(true);

    await h.deps.db.update(vendors).set({ crawlEnabled: false }).where(eq(vendors.id, only));
    const dark = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(dark.eligible).toHaveLength(0);
    expect(dark.live).toHaveLength(0);
    expect(dark.exhausted).toBe(false);
    expect(dark.blocked).toBe(false);
    expect(dark.openRequests).toBe(1);
    // The verdict is KEPT, not deleted: "Solo did not carry this" stays true and is
    // worth having when Solo comes back.
    expect(dark.tried.map((v) => v.vendorId)).toEqual([only]);

    await h.deps.db.update(vendors).set({ crawlEnabled: true }).where(eq(vendors.id, only));
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(true);
  });

  // Eligibility is evaluated at ROLLUP time, never at write time. A look by a vendor
  // that has since been disabled counts in neither numerator nor denominator — and
  // the same machinery covers a manual `--vendor X --mode enrich` against a
  // crawl_enabled=false vendor: its look is recorded, but it cannot RETIRE the ask.
  it("a disabled vendor's attempt counts in neither numerator nor denominator", async () => {
    await clearFleet();
    const live = await makeVendor("Mid A", "NC");
    const goingDark = await makeVendor("Mid B", "NC");
    const { requestId } = await makeRequest("NC");

    await spend(requestId, goingDark);
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(false);

    await h.deps.db.update(vendors).set({ crawlEnabled: false }).where(eq(vendors.id, goingDark));
    // Disabling the vendor that HAD looked does not retire the request — the one
    // vendor still eligible has never been asked.
    let coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.eligible.map((v) => v.vendorId)).toEqual([live]);
    expect(coverage.live.map((v) => v.vendorId)).toEqual([live]);
    expect(coverage.exhausted).toBe(false);

    // ...and the request that was open only because the now-dark vendor had not
    // finished becomes exhausted-in-truth the moment the remaining vendor spends.
    await spend(requestId, live);
    coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(true);
    expect(coverage.tried).toHaveLength(2);
  });

  // The append-once dedupe runs on the same authority as the reporting paths. A
  // row whose cached status reads `exhausted` while a live vendor has not looked
  // at it is STILL open — the drain admits `exhausted` rows — so a status-column
  // dedupe would file a duplicate ask for it. A row retired at every counted lane
  // still re-queues, which is the long-standing behaviour.
  it("maybeQueueEnrichment does not duplicate a cached-exhausted request that is still open", async () => {
    await clearFleet();
    const vendorId = await makeVendor("Dedupe", "NC");
    const owner = await h.createUser(`dedupe-${newRequestId()}@example.com`);
    const { cigarId, requestId } = await makeRequest("NC");

    // Cache says retired; the ledger is empty, so nobody actually looked.
    await h.deps.db
      .update(enrichmentRequests)
      .set({ status: "exhausted" })
      .where(eq(enrichmentRequests.id, requestId));

    const duplicated = await h.deps.db.transaction((tx) => maybeQueueEnrichment(tx, cigarId, owner.userId));
    expect(duplicated).toBe(false);
    const rows = await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId));
    expect(rows).toHaveLength(1);

    // Once the vendor really has spent its budget, a fresh ask is a fresh reason
    // to look and DOES queue.
    await spend(requestId, vendorId);
    const requeued = await h.deps.db.transaction((tx) => maybeQueueEnrichment(tx, cigarId, owner.userId));
    expect(requeued).toBe(true);
    expect(
      await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId)),
    ).toHaveLength(2);
  });

  // A fulfilled ask is answered — one catalogue photo per cigar — so its ledger
  // never rolls into a "retired" verdict for the cigar.
  it("a fulfilled request is excluded from the cigar-level rollup", async () => {
    await clearFleet();
    const vendorId = await makeVendor("Fulfilled", "NC");
    const { cigarId, requestId } = await makeRequest("NC");
    await spend(requestId, vendorId);
    expect((await enrichmentCoverageForCigar(h.deps.db, cigarId, "NC")).exhausted).toBe(true);

    await h.deps.db
      .update(enrichmentRequests)
      .set({ status: "fulfilled" })
      .where(eq(enrichmentRequests.id, requestId));
    const coverage = await enrichmentCoverageForCigar(h.deps.db, cigarId, "NC");
    expect(coverage.exhausted).toBe(false);
    expect(coverage.openRequests).toBe(0);
  });
});
