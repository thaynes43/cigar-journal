import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { crawlRuns, enrichmentAttempts, enrichmentRequests, listingMatches, vendors } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { maybeQueueEnrichment } from "./enrichment.js";
import type { CigarType } from "./types.js";
import {
  ATTEMPTS_PER_VENDOR,
  ERROR_BUDGET,
  coversMarket,
  coversMarketSql,
  enrichVendorFleet,
  enrichmentCoverageForCigar,
  enrichmentCoverageForRequest,
  evidencedMarket,
  liveEnrichMarkets,
  mayWriteCatalogPhoto,
  recordEnrichmentAttempt,
  vendorNotRetiredSql,
  type VendorFocus,
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
  // Liveness is a per-request COMPARISON since #185 — a lane counts only if it has
  // already looked at the ask, or started a succeeded enrich run since the ask was
  // filed. So both instants are pinned rather than left to wall-clock defaults:
  // `makeVendor` seeds a lane that ran AFTER `makeRequest` files its ask, which is
  // the ordinary case the rest of these cases assume. The cases that are ABOUT the
  // ordering set it themselves.
  const REQUEST_AT = new Date("2026-08-26T00:00:00.000Z");
  const LANE_RAN_AT = new Date("2026-08-28T12:00:00.000Z");

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
      await h.deps.db
        .insert(crawlRuns)
        .values({ vendorId, kind: "enrich", status: "succeeded", startedAt: LANE_RAN_AT });
    }
    return vendorId;
  }

  async function makeRequest(type: "NC" | "CC" | null, name = "Coverage"): Promise<{ cigarId: string; requestId: string }> {
    const cigarId = await h.seedCigar({ canonicalName: `${name} ${newRequestId().slice(0, 8)}`, type });
    const rows = await h.deps.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "pending", createdAt: REQUEST_AT })
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

  // The MARKET side of the same complement (#170 §2c). The drain filters its open
  // set with coversMarketSql over the evidenced market; the rollup builds its
  // denominator with the same predicate over the same value. A vendor the drain
  // will never send must not appear in the fleet the rollup counts, or the request
  // hangs on a lane that is never coming.
  it("the fleet is the exact complement of the drain's market filter", async () => {
    await clearFleet();
    const nc = await makeVendor("Complement NC", "NC");
    const cc = await makeVendor("Complement CC", "CC");

    const ids = async (market: CigarType | null) =>
      (await enrichVendorFleet(h.deps.db, market)).map((v) => v.vendorId).sort();

    for (const [market, expected] of [
      ["NC", [nc]],
      ["CC", [cc]],
      [null, [nc, cc]],
    ] as [CigarType | null, string[]][]) {
      expect([market, await ids(market)]).toEqual([market, expected.sort()]);
      // ...and each vendor's membership is exactly what the SQL predicate says.
      for (const [vendorId, focus] of [
        [nc, "NC"],
        [cc, "CC"],
      ] as [string, VendorFocus][]) {
        const rows = await h.deps.db.execute(
          sql`SELECT ${coversMarketSql(sql`${focus}::text`, sql`${market}::text`)} AS ok`,
        );
        expect([focus, market, (rows.rows[0] as { ok: boolean }).ok]).toEqual([
          focus,
          market,
          expected.includes(vendorId),
        ]);
      }
    }
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
    expect((await enrichVendorFleet(h.deps.db, null)).some((v) => v.lastEnrichStartedAt != null)).toBe(false);
    expect([...(await liveEnrichMarkets(h.deps.db))]).toEqual([]);

    await h.deps.db
      .insert(crawlRuns)
      .values({ vendorId: nc, kind: "enrich", status: "succeeded", startedAt: LANE_RAN_AT });
    expect((await enrichVendorFleet(h.deps.db, "NC")).filter((v) => v.lastEnrichStartedAt != null).map((v) => v.vendorId)).toEqual([nc]);
    expect([...(await liveEnrichMarkets(h.deps.db))].sort()).toEqual(["NC"]);
    // A `seed` run is not an enrich lane — the prod shape this gate was written for.
    await h.deps.db
      .insert(crawlRuns)
      .values({ vendorId: cc, kind: "seed", status: "succeeded", startedAt: LANE_RAN_AT });
    expect((await enrichVendorFleet(h.deps.db, "CC")).filter((v) => v.lastEnrichStartedAt != null).map((v) => v.vendorId)).toEqual([]);
    expect([...(await liveEnrichMarkets(h.deps.db))].sort()).toEqual(["NC"]);

    // The one place a NULL focus is treated differently, and deliberately: it
    // cannot be used to CLAIM a market is covered (a positive claim), but it
    // cannot be ruled out of a cigar's fleet either (the negative filter).
    await h.deps.db
      .insert(crawlRuns)
      .values({ vendorId: unknownFocus, kind: "enrich", status: "succeeded", startedAt: LANE_RAN_AT });
    expect([...(await liveEnrichMarkets(h.deps.db))].sort()).toEqual(["NC"]);
    expect(
      (await enrichVendorFleet(h.deps.db, "CC")).filter((v) => v.lastEnrichStartedAt != null).map((v) => v.vendorId),
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
    await h.deps.db
      .insert(crawlRuns)
      .values({ vendorId: cubanLous, kind: "enrich", status: "succeeded", startedAt: LANE_RAN_AT });
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
    // It has no succeeded enrich run at all, so the ONLY thing counting it is the
    // look it recorded here — which is exactly what `live` reports since #185: the
    // lanes counted against THIS ask, not the lanes that have ever run.
    expect(coverage.live.map((v) => v.vendorId)).toEqual([running]);
    // ...and it still owes a second look, so it is also awaited.
    expect(coverage.awaiting.map((v) => v.vendorId)).toEqual([running]);
    expect(coverage.exhausted).toBe(false);
    expect(coverage.openRequests).toBe(1);

    await spend(requestId, running, 1);
    coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(true);
    expect(coverage.awaiting).toHaveLength(0);
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

  // ONLY A PAGE WE OPENED BURNS BUDGET (#240). `attempts` running out is the whole
  // licence for `exhausted`, whose meaning is "we read this catalogue and the
  // cigar is not in it" — so the two outcomes that read nothing must leave the
  // counter alone, and `no_candidate` is the one prod proved this on: 58 of 58
  // ledger rows reading `miss`, most of them written without a page being fetched,
  // clearing the queue by exhaustion under a sentence that was never true.
  //
  // The row is still written. "Which lane came up empty-handed, and when" is worth
  // having — and the drain's open set reads `attempts`, so a zero-attempt row keeps
  // the ask selectable rather than parking it.
  it("no_candidate and photo_refused record the lane without spending its budget", async () => {
    await clearFleet();
    const vendorId = await makeVendor("Named Nothing", "NC");
    const { requestId } = await makeRequest("NC");

    for (let i = 0; i < ATTEMPTS_PER_VENDOR + 1; i += 1) {
      await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "no_candidate", at });
    }
    let row = await ledger(requestId, vendorId);
    expect(row!.attempts).toBe(0);
    expect(row!.errors).toBe(0);
    expect(row!.lastOutcome).toBe("no_candidate");

    // However many nights it repeats, it can never retire the ask: the lane is
    // counted (it has a row here) and it still owes a look.
    let coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(false);
    expect(coverage.blocked).toBe(false);
    expect(coverage.awaiting.map((v) => v.vendorId)).toEqual([vendorId]);

    // A refusal behaves the same way on the counter, and has since #209 — asserted
    // beside it so the shared invariant is one test rather than two conventions.
    await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "photo_refused", at });
    expect((await ledger(requestId, vendorId))!.attempts).toBe(0);

    // And the moment the lane actually reads a page, the budget moves again.
    for (let i = 0; i < ATTEMPTS_PER_VENDOR; i += 1) {
      await recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "miss", at });
    }
    row = await ledger(requestId, vendorId);
    expect(row!.attempts).toBe(ATTEMPTS_PER_VENDOR);
    coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(true);
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

  // --- the evidenced market (#170) ------------------------------------------

  // A vendor's listing, as a market claim about the cigar it links to.
  async function stock(vendorId: string, cigarId: string | null): Promise<void> {
    await h.deps.db.insert(listingMatches).values({
      vendorId,
      listingKey: `/p/${newRequestId()}`,
      cigarId,
      status: cigarId ? "auto" : "unmatched",
    });
  }

  async function vendorName(vendorId: string): Promise<string> {
    const rows = await h.deps.db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, vendorId));
    return rows[0]!.name;
  }

  // The whole of #170 rests on this read being right, because on prod 884 of 971
  // active cigars are untyped and `coversMarketSql` admits an unknown market by
  // design — so on the raw column the market predicate is inert for 91% of the
  // catalogue and a CC lane may select almost all of it.
  it("the evidenced market: cigars.type wins, one single-market source resolves, conflicting sources do not", async () => {
    await clearFleet();
    const nc = await makeVendor("Evidence NC", "NC", { enrichRun: false });
    const cc = await makeVendor("Evidence CC", "CC", { enrichRun: false });
    const both = await makeVendor("Evidence Both", "both", { enrichRun: false });

    // No type and nobody stocks it: unknown, and the guards stay liberal.
    const bare = await h.seedCigar({ canonicalName: `Bare Row ${newRequestId()}`, type: null });
    expect(await evidencedMarket(h.deps.db, bare)).toBeNull();

    // ONE single-market vendor stocking it resolves the market. This is ADR-006's
    // own negative filter run backwards: a CC-only vendor will not carry an NC
    // cigar, so an NC-only vendor carrying this one means it is not CC.
    const foxOnly = await h.seedCigar({ canonicalName: `Fox Only Row ${newRequestId()}`, type: null });
    await stock(nc, foxOnly);
    expect(await evidencedMarket(h.deps.db, foxOnly)).toBe("NC");

    // Two disagreeing sources resolve to UNKNOWN, not to a winner. Conservative on
    // purpose: one of the two links is wrong and nothing here can say which.
    await stock(cc, foxOnly);
    expect(await evidencedMarket(h.deps.db, foxOnly)).toBeNull();

    // `cigars.type` OVERRIDES linkage evidence outright, so a curator always has
    // the last word — the live `Petit Royales Romeo y Julieta` shape: a CC cigar
    // wrongly auto-linked by an NC vendor stays CC.
    const typed = await h.seedCigar({ canonicalName: `Typed Row ${newRequestId()}`, type: "CC" });
    await stock(nc, typed);
    expect(await evidencedMarket(h.deps.db, typed)).toBe("CC");

    // A both-market vendor stocking a cigar says nothing about its market.
    const bothOnly = await h.seedCigar({ canonicalName: `Both Only Row ${newRequestId()}`, type: null });
    await stock(both, bothOnly);
    expect(await evidencedMarket(h.deps.db, bothOnly)).toBeNull();

    // An UNMATCHED listing (cigar_id NULL) is evidence about no cigar at all...
    const triaged = await h.seedCigar({ canonicalName: `Triaged Row ${newRequestId()}`, type: null });
    await stock(cc, null);
    expect(await evidencedMarket(h.deps.db, triaged)).toBeNull();
    // ...and it does not disturb the answer for a cigar that does have evidence.
    await stock(nc, triaged);
    expect(await evidencedMarket(h.deps.db, triaged)).toBe("NC");
  });

  // The TS mirrors exist so the write sites do not round-trip to Postgres to
  // evaluate a three-term boolean. Nothing but this case stops them drifting from
  // the SQL the drain and the rollup actually filter with.
  it("coversMarket mirrors coversMarketSql over the whole truth table, and the photo guard is strictly stricter", async () => {
    const focuses: (VendorFocus | null)[] = [null, "both", "NC", "CC"];
    const markets: (CigarType | null)[] = [null, "NC", "CC"];
    for (const focus of focuses) {
      for (const market of markets) {
        const rows = await h.deps.db.execute(
          sql`SELECT ${coversMarketSql(sql`${focus}::text`, sql`${market}::text`)} AS ok`,
        );
        const inSql = (rows.rows[0] as { ok: boolean }).ok;
        expect([focus, market, inSql]).toEqual([focus, market, coversMarket(focus, market)]);
        // Write authority can never permit what the link filter already refuses.
        // Checked against BOTH stockist readings, so neither can be the reason.
        if (!coversMarket(focus, market)) {
          expect(mayWriteCatalogPhoto(focus, { market, focusedStockist: false })).toBe(false);
          expect(mayWriteCatalogPhoto(focus, { market, focusedStockist: true })).toBe(false);
        }
      }
    }

    // And it is STRICTLY stricter, which is the reversibility split: a single-market
    // vendor may LINK a cigar whose market is unknown (revisable, per-vendor, named)
    // but may not fill its one permanent catalogue-photo slot.
    expect(coversMarket("NC", null)).toBe(true);
    expect(mayWriteCatalogPhoto("NC", { market: null, focusedStockist: false })).toBe(false);

    // A vendor with no single market is gated on PRE-EMPTION instead, because its
    // focus cannot rule anything out: it may take an empty slot nobody focused
    // competes for, and may not take one from a vendor whose focus covers the row.
    // The market is deliberately not what decides it — note both readings below
    // hold at market=null, which covers "no evidence" AND "conflicting evidence".
    for (const focus of ["both", null] as const) {
      expect(mayWriteCatalogPhoto(focus, { market: null, focusedStockist: false })).toBe(true);
      expect(mayWriteCatalogPhoto(focus, { market: null, focusedStockist: true })).toBe(false);
      expect(mayWriteCatalogPhoto(focus, { market: "NC", focusedStockist: true })).toBe(false);
      // Typed by a curator, stocked by nobody focused: still the only source there is.
      expect(mayWriteCatalogPhoto(focus, { market: "CC", focusedStockist: false })).toBe(true);
    }
  });

  // --- per-request liveness (#185) -------------------------------------------

  async function laneRan(vendorId: string, startedAt: Date, finishedAt?: Date): Promise<void> {
    await h.deps.db
      .insert(crawlRuns)
      .values({ vendorId, kind: "enrich", status: "succeeded", startedAt, finishedAt: finishedAt ?? startedAt });
  }

  async function askedAt(createdAt: Date, type: CigarType | null = "NC"): Promise<{ cigarId: string; requestId: string }> {
    const cigarId = await h.seedCigar({ canonicalName: `Timed Ask ${newRequestId()}`, type });
    const rows = await h.deps.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "pending", createdAt })
      .returning({ id: enrichmentRequests.id });
    return { cigarId, requestId: rows[0]!.id };
  }

  // THE #185 DEFECT. "Has this lane ever run?" is MONOTONE: once true it is true
  // forever, so a lane that runs once and stops counts against every request filed
  // afterwards, and those requests can never reach `exhausted` — nor, therefore,
  // `retryExhausted`. The per-request question fixes the inflow.
  it("a lane that stopped running does not count against a request filed after it stopped", async () => {
    await clearFleet();
    const stopped = await makeVendor("Aaa Stopped Lane", "NC", { enrichRun: false });
    const nightly = await makeVendor("Bbb Nightly Lane", "NC", { enrichRun: false });
    await laneRan(stopped, new Date("2026-08-01T06:00:00.000Z"));
    await laneRan(nightly, new Date("2026-08-29T06:00:00.000Z"));

    const { requestId } = await askedAt(new Date("2026-08-15T00:00:00.000Z"));

    // Both are ELIGIBLE — the negative filter rules out neither — but only the lane
    // that has run since the ask was filed counts against it.
    const before = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(before.eligible.map((v) => v.vendorId).sort()).toEqual([stopped, nightly].sort());
    expect(before.live.map((v) => v.vendorId)).toEqual([nightly]);
    expect(before.awaiting.map((v) => v.vendorId)).toEqual([nightly]);

    // ...so the ask retires on the remaining lane alone instead of hanging forever.
    await spend(requestId, nightly);
    const after = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(after.exhausted).toBe(true);
    expect(after.blocked).toBe(false);
    expect(after.awaiting).toHaveLength(0);
  });

  // The #181 clause has to survive the change, or a lane's own first night reads as
  // a lag: while it drains, its crawl_run row is still `running`, so nothing but
  // the look it just recorded can count it.
  it("a lane that has already looked counts even with no succeeded run since the ask", async () => {
    await clearFleet();
    const draining = await makeVendor("Draining Now", "NC", { enrichRun: false });
    await laneRan(draining, new Date("2026-08-01T06:00:00.000Z"));
    const { requestId } = await askedAt(new Date("2026-08-15T00:00:00.000Z"));

    // No run since the ask, so liveness alone would not count it...
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).live).toHaveLength(0);
    // ...but a recorded look is the same demonstration, one run earlier.
    await spend(requestId, draining, 1);
    const coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.live.map((v) => v.vendorId)).toEqual([draining]);
    expect(coverage.awaiting.map((v) => v.vendorId)).toEqual([draining]);
    expect(coverage.exhausted).toBe(false);
  });

  // `started_at`, not `finished_at`. The drain's open-set SELECT happens near the
  // START of a run, so a run that began before the ask existed never saw the row
  // however late it finished. Reading finished_at would count it and hang the ask.
  it("a run that started before the ask but finished after it does not count", async () => {
    await clearFleet();
    const straddling = await makeVendor("Straddling Lane", "NC", { enrichRun: false });
    await laneRan(
      straddling,
      new Date("2026-08-10T04:00:00.000Z"),
      new Date("2026-08-20T06:30:00.000Z"),
    );
    const { requestId } = await askedAt(new Date("2026-08-15T00:00:00.000Z"));

    const coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.live).toHaveLength(0);
    // Zero counted lanes is OPEN, never exhausted and never blocked (#158).
    expect(coverage.exhausted).toBe(false);
    expect(coverage.blocked).toBe(false);
    expect(coverage.openRequests).toBe(1);
  });

  // The obvious way to get #185 wrong: a brand-new ask has no ledger rows and no
  // lane with a run since its creation, so `counted` is empty. Empty must read as
  // "open, self-healing", never as "we asked everyone and nobody had it".
  it("a brand-new ask is open, never exhausted and never blocked, on day zero", async () => {
    await clearFleet();
    await makeVendor("Ran Yesterday", "NC", { enrichRun: false }).then((id) =>
      laneRan(id, new Date("2026-08-28T06:00:00.000Z")),
    );
    const { requestId } = await askedAt(new Date("2026-08-30T09:00:00.000Z"));

    const coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.openRequests).toBe(1);
    expect(coverage.exhausted).toBe(false);
    expect(coverage.blocked).toBe(false);
    expect(coverage.live).toHaveLength(0);
    expect(coverage.awaiting).toHaveLength(0);
  });

  // THE RESIDUAL, asserted rather than papered over. #185's rule fixes the inflow
  // and NOT the standing backlog: an ask filed before a lane's last run, which that
  // lane never reached, still counts that lane forever. At ENRICH_DEFAULT_LIMIT = 50
  // a lane reaches fifty asks a night, which covers prod's standing queue today —
  // but one backlog press files hundreds and puts the residual straight back.
  // What this lane ships instead of a better proxy: the row NAMES who it is waiting
  // on, and the operator's existing lever clears it in one statement.
  it("the residual is real and named, and crawl_enabled=false clears it", async () => {
    await clearFleet();
    const stalled = await makeVendor("Aaa Stalled Lane", "CC", { enrichRun: false });
    const nightly = await makeVendor("Bbb Nightly Lane", "NC", { enrichRun: false });
    await laneRan(stalled, new Date("2026-08-20T06:00:00.000Z"));
    await laneRan(nightly, new Date("2026-08-29T06:00:00.000Z"));
    // Untyped and unlinked, so both markets are eligible — prod's dominant shape.
    const { requestId } = await askedAt(new Date("2026-08-10T00:00:00.000Z"), null);

    await spend(requestId, nightly);
    const held = await enrichmentCoverageForRequest(h.deps.db, requestId, null);
    expect(held.exhausted).toBe(false);
    expect(held.openRequests).toBe(1);
    // Both ran AFTER the ask was filed, so both count — and the stalled one, which
    // will never look again, is the one still owed. Naming it is the whole fix.
    expect(held.awaiting.map((v) => v.vendorId)).toEqual([stalled]);
    expect(held.awaiting.map((v) => v.name)).toEqual([await vendorName(stalled)]);

    // The lever that already exists: ADR-006 rules `crawl_enabled` a pure negative
    // filter, so flipping it off drops the lane from the fleet and frees the ask —
    // today, with no migration and no reopen job. #156 is still the real fix.
    await h.deps.db.update(vendors).set({ crawlEnabled: false }).where(eq(vendors.id, stalled));
    const freed = await enrichmentCoverageForRequest(h.deps.db, requestId, null);
    expect(freed.exhausted).toBe(true);
    expect(freed.awaiting).toHaveLength(0);
  });

  // The queue gate stays MONOTONE, deliberately, and the asymmetry is the point:
  // it is evaluated at ENQUEUE time, when the request does not exist, so "has a
  // lane run since now?" is never true and a per-request rule here would refuse
  // every ask forever. A stale `true` only permits filing an ask; a stale `true`
  // in the denominator blocks retirement forever.
  it("liveEnrichMarkets is deliberately unchanged: a lane that ran once still reports its market reachable", async () => {
    await clearFleet();
    const once = await makeVendor("Ran Once", "CC", { enrichRun: false });
    await laneRan(once, new Date("2026-01-01T06:00:00.000Z"));

    expect([...(await liveEnrichMarkets(h.deps.db))]).toEqual(["CC"]);

    // ...even though the very same lane counts against nothing filed since.
    const { requestId } = await askedAt(new Date("2026-08-10T00:00:00.000Z"), "CC");
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "CC")).live).toHaveLength(0);
  });
});
