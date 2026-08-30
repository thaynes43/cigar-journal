import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { crawlRuns, enrichmentAttempts, enrichmentRequests, vendors } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { maybeQueueEnrichment } from "./enrichment.js";
import {
  ATTEMPTS_PER_VENDOR,
  ERROR_BUDGET,
  eligibleEnrichVendors,
  enrichmentCoverageForCigar,
  enrichmentCoverageForRequest,
  liveEnrichMarkets,
  recordEnrichmentAttempt,
  vendorCoversType,
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
    if (opts.enrichRun) {
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

  // --- the pure predicate ---------------------------------------------------

  // A NEGATIVE filter only: it excludes when both sides are known and disagree,
  // and never claims a vendor DOES carry something. Unknown on either side means
  // the vendor must still be asked — guessing is how a CC row gets retired by an
  // NC-only fleet.
  it("vendorCoversType excludes only a known mismatch", () => {
    expect(vendorCoversType("NC", "NC")).toBe(true);
    expect(vendorCoversType("NC", "CC")).toBe(false);
    expect(vendorCoversType("CC", "NC")).toBe(false);
    expect(vendorCoversType("both", "CC")).toBe(true);
    expect(vendorCoversType("both", "NC")).toBe(true);
    // Unknown cigar market: every vendor might carry it, so every vendor is asked.
    expect(vendorCoversType("NC", null)).toBe(true);
    expect(vendorCoversType("CC", null)).toBe(true);
    // Unknown vendor focus: same reasoning from the other side.
    expect(vendorCoversType(null, "CC")).toBe(true);
    expect(vendorCoversType(null, null)).toBe(true);
  });

  // --- eligibility vs liveness ---------------------------------------------

  it("eligibility is crawl_enabled x focus; liveness additionally needs a succeeded enrich run", async () => {
    await clearFleet();
    const nc = await makeVendor("Elig NC", "NC");
    const cc = await makeVendor("Elig CC", "CC");
    const both = await makeVendor("Elig Both", "both");
    const unknownFocus = await makeVendor("Elig Unknown", null);
    const disabled = await makeVendor("Elig Off", "NC", { crawlEnabled: false });

    const ids = async (type: "NC" | "CC" | null) =>
      (await eligibleEnrichVendors(h.deps.db, type)).map((v) => v.vendorId).sort();

    expect(await ids("NC")).toEqual([nc, both, unknownFocus].sort());
    expect(await ids("CC")).toEqual([cc, both, unknownFocus].sort());
    // An untyped cigar could be either market, so EVERY enabled vendor is in the
    // denominator — it only retires once all of them have looked.
    expect(await ids(null)).toEqual([nc, cc, both, unknownFocus].sort());
    expect(await ids("NC")).not.toContain(disabled);

    // THE CASE THAT DECIDES THE DESIGN. None of these has run an enrich pass, so
    // no market is live — yet they are all eligible and all count toward
    // exhaustion. Using liveness as the denominator would be circular: a brand-new
    // lane has never run, so it could never take a request and never become live.
    expect([...(await liveEnrichMarkets(h.deps.db))]).toEqual([]);

    await h.deps.db.insert(crawlRuns).values({ vendorId: nc, kind: "enrich", status: "succeeded" });
    expect([...(await liveEnrichMarkets(h.deps.db))].sort()).toEqual(["NC"]);
    // A `seed` run is not an enrich lane — the prod shape this gate was written for.
    await h.deps.db.insert(crawlRuns).values({ vendorId: cc, kind: "seed", status: "succeeded" });
    expect([...(await liveEnrichMarkets(h.deps.db))].sort()).toEqual(["NC"]);
  });

  // --- the atomic upsert ----------------------------------------------------

  // #157 defect 1 degraded. The pre-0023 drain read `attempts` and wrote back
  // `attempts + 1`, so two overlapping runs both read 0 and both wrote 1 — one real
  // look silently lost. ON CONFLICT makes the worst case a HONEST count of two.
  it("recordEnrichmentAttempt is an atomic upsert — concurrent increments cannot lose one", async () => {
    await clearFleet();
    const vendorId = await makeVendor("Upsert", "NC");
    const { requestId } = await makeRequest("NC");

    await Promise.all([
      recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "miss", at }),
      recordEnrichmentAttempt(h.deps.db, { requestId, vendorId, outcome: "miss", at }),
    ]);

    const row = await ledger(requestId, vendorId);
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
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(true);
  });

  // --- the rollup -----------------------------------------------------------

  // THE #158 REGRESSION at the rollup level: one vendor spending its whole budget
  // retires nothing while another vendor has never been asked.
  it("exhausted requires EVERY eligible vendor to be spent", async () => {
    await clearFleet();
    const a = await makeVendor("Roll A", "NC");
    const b = await makeVendor("Roll B", "NC");
    const { cigarId, requestId } = await makeRequest("NC");

    await spend(requestId, a);
    let coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(false);
    expect(coverage.openRequests).toBe(1);
    expect(coverage.eligible.map((v) => v.vendorId).sort()).toEqual([a, b].sort());
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
    expect(coverage.exhausted).toBe(true);
  });

  // "Nobody could look" is not "we looked and found nothing", and laundering one
  // into the other is what the ADR amendment forbids.
  it("zero eligible vendors is NOT exhausted, and re-enabling restores the old ledger", async () => {
    await clearFleet();
    const only = await makeVendor("Solo", "NC");
    const { requestId } = await makeRequest("NC");
    await spend(requestId, only);
    expect((await enrichmentCoverageForRequest(h.deps.db, requestId, "NC")).exhausted).toBe(true);

    await h.deps.db.update(vendors).set({ crawlEnabled: false }).where(eq(vendors.id, only));
    const dark = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(dark.eligible).toHaveLength(0);
    expect(dark.exhausted).toBe(false);
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
    expect(coverage.exhausted).toBe(false);

    // ...and the request that was open only because the now-dark vendor had not
    // finished becomes exhausted-in-truth the moment the remaining vendor spends.
    await spend(requestId, live);
    coverage = await enrichmentCoverageForRequest(h.deps.db, requestId, "NC");
    expect(coverage.exhausted).toBe(true);
    expect(coverage.tried).toHaveLength(2);
  });

  // The append-once dedupe runs on the same authority as the reporting paths. A
  // row whose cached status reads `exhausted` while an eligible vendor has not
  // looked at it is STILL open — the drain admits `exhausted` rows — so a
  // status-column dedupe would file a duplicate ask for it. A row retired at every
  // eligible vendor still re-queues, which is the long-standing behaviour.
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
