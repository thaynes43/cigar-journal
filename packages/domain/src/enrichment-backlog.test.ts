import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, cigars, crawlRuns, enrichmentRequests, productPhotos, purchases, vendors } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { queueEnrichmentBacklog, cigarsMissingPhotos, agentRunRows, ENRICHMENT_BACKLOG_MAX } from "./curation.js";
import {
  ATTEMPTS_PER_VENDOR,
  ERROR_BUDGET,
  enrichVendorFleet,
  recordEnrichmentAttempt,
} from "./enrichment-coverage.js";
import { IdempotencyConflictError, UnauthorizedError } from "./errors.js";
import type { Principal } from "./deps.js";

// queueEnrichmentBacklog (#154): one press turns the "Missing photos" worklist into
// enrichment_requests rows. The worklist is principal-scoped, so every case gets its
// OWN admin — that is the isolation, and it doubles as the scoping proof.
//
// Vendor coverage is NOT principal-scoped: it is one fleet-wide fact. The fixture
// mirrors prod's shape deliberately — one crawl-enabled NC vendor that has run an
// enrich pass — so the CC and untyped cases below exercise the real gap rather than
// an invented one.

describe("queueEnrichmentBacklog", () => {
  let h: DomainHarness;

  async function seedVendor(focus: "NC" | "CC" | "both", runKind: "seed" | "enrich" | null) {
    const rows = await h.deps.db
      .insert(vendors)
      .values({ name: `Vendor ${focus} ${newRequestId()}`, focus, crawlEnabled: true })
      .returning({ id: vendors.id });
    const vendorId = rows[0]!.id;
    if (runKind) {
      await h.deps.db.insert(crawlRuns).values({ vendorId, kind: runKind, status: "succeeded" });
    }
    return vendorId;
  }

  beforeAll(async () => {
    h = await createHarness();
    await seedVendor("NC", "enrich");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  let seq = 0;
  async function curator(): Promise<Principal> {
    seq += 1;
    return h.createUser(`backlog-${seq}-${newRequestId()}@example.com`, "admin");
  }

  // A held cigar with no photo and no dimensions — the shape of every one of the
  // owner's real photoless holdings. NC and verified by default, i.e. a row that
  // passes both preconditions; the gate cases override one field each.
  async function seedHeld(
    owner: Principal,
    name: string,
    quantity = 1,
    overrides: { type?: "NC" | "CC" | null; verification?: "verified" | "unverified" } = {},
  ): Promise<string> {
    const cigarId = await h.seedCigar({
      canonicalName: `${name} ${newRequestId()}`,
      type: overrides.type === undefined ? "NC" : overrides.type,
      ...(overrides.verification ? { verification: overrides.verification } : {}),
    });
    await h.deps.db.insert(purchases).values({ userId: owner.userId, cigarId, quantity });
    return cigarId;
  }

  // Since migration 0023 `exhausted` is DERIVED from the per-vendor ledger, not read
  // off enrichment_requests.status — so a test that wants a retired row has to
  // retire it the way the crawler does: every LANE THAT RUNS spends its own budget.
  // Writing `status: 'exhausted'` alone no longer makes a row dead, which is the
  // point (see the cache-vs-authority case below). Vendors that are crawl-enabled
  // but have never completed an enrich run are not in the denominator and are not
  // spent here — that is the #158-review fix, and the untyped case below is where
  // it shows.
  async function retireEverywhere(
    requestId: string,
    type: "NC" | "CC" | null = "NC",
    outcome: "miss" | "error" = "miss",
  ) {
    // "Has ever run an enrich pass" — the fleet-level reading of liveness, which
    // since #185 is a timestamp rather than a flag. Retiring by spending the ledger
    // works whatever the per-request denominator says, because a recorded look
    // counts a lane unconditionally.
    const live = (await enrichVendorFleet(h.deps.db, type)).filter((v) => v.lastEnrichStartedAt != null);
    expect(live.length).toBeGreaterThan(0);
    const budget = outcome === "miss" ? ATTEMPTS_PER_VENDOR : ERROR_BUDGET;
    for (const vendor of live) {
      for (let i = 0; i < budget; i += 1) {
        await recordEnrichmentAttempt(h.deps.db, {
          requestId,
          vendorId: vendor.vendorId,
          outcome,
          at: new Date("2026-08-30T12:00:00.000Z"),
        });
      }
    }
    return live.map((v) => v.name);
  }

  async function requestRows(cigarId: string) {
    return h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId));
  }

  async function enrichmentAudits(cigarId: string) {
    const rows = await h.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "cigar.enrichment_request"));
    return rows.filter((r) => (r.after as { cigarId?: string } | null)?.cigarId === cigarId);
  }

  async function seedPhoto(cigarId: string, rights: "approved" | "suppressed") {
    await h.deps.db.insert(productPhotos).values({
      cigarId,
      objectKey: `product/${cigarId}/a.jpg`,
      thumbKey: `product/${cigarId}/a.thumb.jpg`,
      contentType: "image/jpeg",
      width: 600,
      height: 800,
      bytes: 10,
      rights,
    });
  }

  it("queues every held photoless cigar, one request row each, and the counts add up", async () => {
    const admin = await curator();
    const a = await seedHeld(admin, "Backlog A", 3);
    const b = await seedHeld(admin, "Backlog B", 1);

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });

    expect(result).toMatchObject({ eligible: 2, considered: 2, queued: 2, skipped: 0, replayed: false });
    expect(result.entries.map((e) => e.status)).toEqual(["queued", "queued"]);
    expect(result.entries.map((e) => e.cigarId)).toEqual([a, b]); // remaining DESC
    expect((await requestRows(a))).toHaveLength(1);
    expect((await requestRows(b))).toHaveLength(1);
  });

  it("is idempotent by nature — a second press with a NEW request id queues nothing", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Twice");

    await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    const second = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });

    expect(second).toMatchObject({ eligible: 1, considered: 1, queued: 0, skipped: 1 });
    expect(second.entries[0]).toMatchObject({ cigarId, status: "already_queued" });
    expect(await requestRows(cigarId)).toHaveLength(1);
    expect(await enrichmentAudits(cigarId)).toHaveLength(1);
  });

  it("replays the identical result on the SAME request id and writes nothing (ADR-003)", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Replay");
    const clientRequestId = newRequestId();

    const first = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId });
    const replay = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(await requestRows(cigarId)).toHaveLength(1);
    expect(await enrichmentAudits(cigarId)).toHaveLength(1);
  });

  it("rejects the same request id carrying a different limit (fingerprint guard)", async () => {
    const admin = await curator();
    await seedHeld(admin, "Backlog Conflict");
    const clientRequestId = newRequestId();

    await queueEnrichmentBacklog(h.deps, admin, { clientRequestId, limit: 5 });
    await expect(queueEnrichmentBacklog(h.deps, admin, { clientRequestId, limit: 6 })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("reports the existing queue state per row: pending and in_progress already_queued, fulfilled recently_enriched", async () => {
    const admin = await curator();
    const pending = await seedHeld(admin, "Backlog Pending", 4);
    const inProgress = await seedHeld(admin, "Backlog InProgress", 3);
    const fulfilled = await seedHeld(admin, "Backlog Fulfilled", 2);
    await h.deps.db.insert(enrichmentRequests).values([
      { cigarId: pending, status: "pending" },
      { cigarId: inProgress, status: "in_progress" },
      { cigarId: fulfilled, status: "fulfilled" },
    ]);

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    const byId = new Map(result.entries.map((e) => [e.cigarId, e.status]));

    // `in_progress` is the case maybeQueueEnrichment gets wrong (it dedupes on
    // pending|fulfilled only) — this is the guard that the bulk path uses the
    // correct predicate and never double-queues a row a crawl is draining.
    expect(byId.get(pending)).toBe("already_queued");
    expect(byId.get(inProgress)).toBe("already_queued");
    expect(byId.get(fulfilled)).toBe("recently_enriched");
    expect(result).toMatchObject({ queued: 0, skipped: 3 });
    for (const id of [pending, inProgress, fulfilled]) expect(await requestRows(id)).toHaveLength(1);
  });

  it("reports exhausted rows without re-queueing them, and queues them only on retryExhausted", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Exhausted");
    const [request] = await h.deps.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "exhausted" })
      .returning({ id: enrichmentRequests.id });
    const tried = await retireEverywhere(request!.id);

    const skipped = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    // The verdict NAMES the vendors that looked — an `exhausted` state that does not
    // is meaningless, because a vendor's catalogue is partial (ADR-006, 2026-08-30).
    expect(skipped.entries[0]).toMatchObject({ cigarId, status: "exhausted", triedVendors: tried });
    expect(skipped.eligibleVendors).toEqual(tried);
    expect(skipped).toMatchObject({ queued: 0, skipped: 1 });
    expect(await requestRows(cigarId)).toHaveLength(1);

    const retried = await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      retryExhausted: true,
    });
    expect(retried.entries[0]).toMatchObject({ cigarId, status: "queued" });
    expect(await requestRows(cigarId)).toHaveLength(2);
  });

  it("retries a row that is exhausted AND fulfilled — the state a failed photo capture leaves", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Exhausted Fulfilled");
    // Reachable without any race: ingest wraps capturePhoto in try/catch and still
    // finalizes, so a name match with a throwing capture marks the request fulfilled
    // while the cigar stays photoless and stays on this worklist. Keying the retry
    // off `status === "queued"` alone left the escape hatch inert here — exactly the
    // rows most likely to need it.
    const inserted = await h.deps.db
      .insert(enrichmentRequests)
      .values([
        { cigarId, status: "exhausted" },
        { cigarId, status: "fulfilled" },
      ])
      .returning({ id: enrichmentRequests.id, status: enrichmentRequests.status });
    await retireEverywhere(inserted.find((r) => r.status === "exhausted")!.id);

    const reported = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    expect(reported.entries[0]).toMatchObject({ cigarId, status: "exhausted" });
    expect(await requestRows(cigarId)).toHaveLength(2);

    const retried = await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      retryExhausted: true,
    });
    expect(retried.entries[0]).toMatchObject({ cigarId, status: "queued" });
    expect(await requestRows(cigarId)).toHaveLength(3);
  });

  // THE BLOCKER OF THE #158 REVIEW, at the surface an operator actually sees.
  // Prod: Fox Cigar (NC) drains nightly, Cuban Lou's (CC) is crawl-enabled with a
  // suspended enrich CronJob and only a `seed` run, and 890 of 977 catalog rows are
  // untyped so they need BOTH markets. Holding them against a lane that has never
  // run meant they could never reach `exhausted` — and because `already_queued`
  // short-circuits ahead of the exhausted branch, `retryExhausted` could never
  // touch them either. The majority of the catalogue, open forever and invisible.
  it("an untyped row retires at the lanes that run, instead of hanging on one that never does", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Untyped Prod Shape", 1, { type: null });
    // Cuban Lou's: crawl-enabled, focus CC, no enrich run ever.
    await seedVendor("CC", null);
    const [request] = await h.deps.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "pending" })
      .returning({ id: enrichmentRequests.id });
    const tried = await retireEverywhere(request!.id, null);

    const reported = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    const entry = reported.entries.find((e) => e.cigarId === cigarId)!;
    expect(entry).toMatchObject({ status: "exhausted", triedVendors: tried });
    // The never-run vendor is still REPORTED — it is who COULD look — it simply
    // counts against nothing. That pairing is the honest state: a name in
    // `eligibleVendors` whose market is missing from `enrichedMarkets` is a lane
    // that has never run.
    expect(reported.eligibleVendors.length).toBeGreaterThan(tried.length);

    // And the retry now reaches it and says what the real blocker is, rather than
    // reporting `already_queued` at a row nothing will ever pick up.
    const retried = await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      retryExhausted: true,
    });
    expect(retried.entries.find((e) => e.cigarId === cigarId)).toMatchObject({ status: "no_vendor_coverage" });
    expect(await requestRows(cigarId)).toHaveLength(1);
  });

  // THE SECOND FINDING OF THAT REVIEW. A row every lane failed to REACH is retired,
  // but its ledger holds zero completed looks — reporting it `exhausted` next to
  // `triedVendors` reads as "these vendors looked and none carries it", a catalogue
  // fact that was never established. It gets its own verdict, and the same escape
  // hatch, because falling through to `already_queued` would hide it entirely.
  it("reports a row nobody could finish looking at as vendor_unreachable, not exhausted", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Unreachable");
    const [request] = await h.deps.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "pending" })
      .returning({ id: enrichmentRequests.id });
    const tried = await retireEverywhere(request!.id, "NC", "error");

    const reported = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    expect(reported.entries.find((e) => e.cigarId === cigarId)).toMatchObject({
      cigarId,
      status: "vendor_unreachable",
      triedVendors: tried,
    });
    expect(reported).toMatchObject({ queued: 0, skipped: 1 });
    expect(await requestRows(cigarId)).toHaveLength(1);

    // `retryExhausted` clears both retirement verdicts: the fresh ask carries a
    // fresh error budget, which is the whole point once the vendor is fixed.
    const retried = await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      retryExhausted: true,
    });
    expect(retried.entries.find((e) => e.cigarId === cigarId)).toMatchObject({ status: "queued" });
    expect(await requestRows(cigarId)).toHaveLength(2);
  });

  // THE CACHE-VS-AUTHORITY TEST. `enrichment_requests.status` is a cache of a rollup
  // whose denominator — the lanes that run — changes without the row being touched.
  // The column still says `exhausted`, but the drain admits `exhausted` rows and no
  // vendor has a ledger entry, so the request is very much alive. Any future reader
  // that trusts the column instead of the helper fails right here.
  it("a cached-exhausted row no lane has spent is already_queued, not dead", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Stale Cache");
    // Written straight to the column, with an EMPTY ledger — no vendor ever looked.
    await h.deps.db.insert(enrichmentRequests).values({ cigarId, status: "exhausted" });

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    const entry = result.entries.find((e) => e.cigarId === cigarId)!;
    expect(entry.status).toBe("already_queued");
    expect(entry.triedVendors).toBeUndefined();
    // Reported, never duplicated: the crawler will pick this exact row up.
    expect(await requestRows(cigarId)).toHaveLength(1);
    // And who could have looked is visible, which is what makes the report
    // actionable rather than a bare verdict.
    expect(result.eligibleVendors.length).toBeGreaterThan(0);
  });

  it("caps at `limit`, reports the uncapped eligible count, and takes the highest-remaining rows in worklist order", async () => {
    const admin = await curator();
    for (let i = 1; i <= 12; i += 1) await seedHeld(admin, `Backlog Cap ${String(i).padStart(2, "0")}`, i);

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId(), limit: 5 });

    expect(result).toMatchObject({ eligible: 12, considered: 5, queued: 5, skipped: 0 });
    // The selection rule, not just the count: worklist order is remaining DESC, so
    // the deepest holes in the humidor go first.
    const worklist = await cigarsMissingPhotos(h.deps, admin);
    expect(result.entries.map((e) => e.cigarId)).toEqual(worklist.slice(0, 5).map((w) => w.cigarId));
    expect(result.entries.map((e) => e.canonicalName)).toEqual(worklist.slice(0, 5).map((w) => w.canonicalName));
  });

  it("clamps a limit above the ceiling instead of running unbounded", async () => {
    const admin = await curator();
    // One more row than the ceiling: the assertion has to be able to SEE the clamp.
    // Seeded in two bulk statements rather than a loop so the arrange stays cheap.
    const over = ENRICHMENT_BACKLOG_MAX + 1;
    const inserted = await h.deps.db
      .insert(cigars)
      .values(
        Array.from({ length: over }, (_, i) => ({
          canonicalName: `Backlog Clamp ${String(i).padStart(3, "0")} ${newRequestId()}`,
          type: "NC" as const,
          verification: "verified" as const,
        })),
      )
      .returning({ id: cigars.id });
    await h.deps.db
      .insert(purchases)
      .values(inserted.map((row) => ({ userId: admin.userId, cigarId: row.id, quantity: 1 })));

    const result = await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      limit: 10_000,
    });

    // Delete the clamp and the raw 10_000 flows into the slice: eligible would still
    // be over, but considered/queued would be over too. This is the assertion that
    // fails in that world.
    expect(result).toMatchObject({
      eligible: over,
      considered: ENRICHMENT_BACKLOG_MAX,
      queued: ENRICHMENT_BACKLOG_MAX,
      skipped: 0,
    });
    expect(result.entries).toHaveLength(ENRICHMENT_BACKLOG_MAX);
  }, 60_000);

  // ---- the two preconditions a press ENFORCES (#154 review) -----------------

  it("refuses a canonical name nobody has verified, and writes nothing for it", async () => {
    const admin = await curator();
    const reviewed = await seedHeld(admin, "Backlog Reviewed", 2);
    const raw = await seedHeld(admin, "Backlog Unreviewed", 1, { verification: "unverified" });

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    const byId = new Map(result.entries.map((e) => [e.cigarId, e.status]));

    // Enrichment resolves BY canonical name, and a miss is not free: the crawler
    // counts attempts per request and retires the row after two. The owner's real
    // backlog carries reversed and doubled names ("Trinidad Trinidad Reyes"), so
    // this gate is what stops a press retiring them.
    expect(byId.get(raw)).toBe("unverified_name");
    expect(byId.get(reviewed)).toBe("queued");
    expect(await requestRows(raw)).toHaveLength(0);
    expect(await enrichmentAudits(raw)).toHaveLength(0);
    expect(result).toMatchObject({ queued: 1, skipped: 1 });
  });

  it("refuses a market no enrich lane reaches — a CC row while only an NC vendor enriches", async () => {
    const admin = await curator();
    const nc = await seedHeld(admin, "Backlog Covered NC", 3);
    const cc = await seedHeld(admin, "Backlog Cuban", 2, { type: "CC" });
    const untyped = await seedHeld(admin, "Backlog Untyped", 1, { type: null });

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    const byId = new Map(result.entries.map((e) => [e.cigarId, e.status]));

    // Prod's exact shape: 41 of the 58 photoless holdings are CC and the only enrich
    // CronJob is NC-only, while `attempts` counts per REQUEST — so queuing them is
    // how they get marked exhausted for good. An untyped row could be either market,
    // so it needs both covered.
    expect(byId.get(nc)).toBe("queued");
    expect(byId.get(cc)).toBe("no_vendor_coverage");
    expect(byId.get(untyped)).toBe("no_vendor_coverage");
    expect(result.enrichedMarkets).toEqual(["NC"]);
    expect(await requestRows(cc)).toHaveLength(0);
    expect(await requestRows(untyped)).toHaveLength(0);
  });

  it("opens the CC gate by itself once a CC vendor has completed an enrich run", async () => {
    const admin = await curator();
    const cc = await seedHeld(admin, "Backlog Cuban Lou", 1, { type: "CC" });

    // Cuban Lou's in prod today: crawl_enabled, but only ever a `seed` run and no
    // enrich CronJob. crawl_enabled alone would call CC covered; the run is the
    // half that is actually load-bearing.
    const seedOnly = await seedVendor("CC", "seed");
    const stillBlocked = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    expect(stillBlocked.entries[0]).toMatchObject({ cigarId: cc, status: "no_vendor_coverage" });

    // The ops prerequisite lands (a CC enrich CronJob runs once) and the gate opens
    // with no code change and no flag.
    await h.deps.db.insert(crawlRuns).values({ vendorId: seedOnly, kind: "enrich", status: "succeeded" });
    try {
      const opened = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
      expect(opened.entries[0]).toMatchObject({ cigarId: cc, status: "queued" });
      expect(opened.enrichedMarkets).toEqual(["CC", "NC"]);
      expect(await requestRows(cc)).toHaveLength(1);
    } finally {
      // Coverage is fleet-wide: leave it as this file's other cases expect it.
      await h.deps.db.delete(crawlRuns).where(eq(crawlRuns.vendorId, seedOnly));
      await h.deps.db.delete(vendors).where(eq(vendors.id, seedOnly));
    }
  });

  it("never reaches another user's holdings", async () => {
    const admin = await curator();
    const other = await curator();
    const mine = await seedHeld(admin, "Backlog Mine");
    const theirs = await seedHeld(other, "Backlog Theirs");

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });

    expect(result.entries.map((e) => e.cigarId)).toEqual([mine]);
    expect(await requestRows(theirs)).toHaveLength(0);
  });

  it("rejects a non-admin and writes nothing", async () => {
    const admin = await curator();
    const member = await h.createUser(`backlog-member-${newRequestId()}@example.com`);
    const cigarId = await seedHeld(admin, "Backlog Guarded");

    await expect(
      queueEnrichmentBacklog(h.deps, member, { clientRequestId: newRequestId() }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await requestRows(cigarId)).toHaveLength(0);
  });

  it("audits exactly one attributed row per QUEUED cigar and none for a skip", async () => {
    const admin = await curator();
    const fresh = await seedHeld(admin, "Backlog Audited", 2);
    const already = await seedHeld(admin, "Backlog Unaudited", 1);
    await h.deps.db.insert(enrichmentRequests).values({ cigarId: already, status: "pending" });

    await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      attribution: { actor: "agent", runId: "wo-cigar-curate-20260830", confidence: 0.9 },
    });

    const audits = await enrichmentAudits(fresh);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "agent", runId: "wo-cigar-curate-20260830", confidence: 0.9 });
    expect(audits[0]!.after).toMatchObject({ cigarId: fresh });
    expect(await enrichmentAudits(already)).toHaveLength(0);
  });

  it("renders each queued row in the run review under the cigar's name, not the bare action", async () => {
    const admin = await curator();
    const first = await seedHeld(admin, "Backlog Reviewable A", 2);
    const second = await seedHeld(admin, "Backlog Reviewable B", 1);
    const runId = `wo-cigar-curate-${newRequestId()}`;

    await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      attribution: { actor: "agent", runId, confidence: 0.9 },
    });

    // An enqueue audit has no before-image, and agentRunRows resolves most targets
    // through `before`. Without the after->>'cigarId' branch every row of a bulk
    // press renders as an identical, anonymous "cigar.enrichment_request" — which is
    // the whole run review for the press that matters most.
    const { rows } = await agentRunRows(h.deps, admin, { runId });
    const worklist = await cigarsMissingPhotos(h.deps, admin);
    const nameOf = new Map(worklist.map((w) => [w.cigarId, w.canonicalName]));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === "cigar.enrichment_request")).toBe(true);
    expect(new Set(rows.map((r) => r.targetName))).toEqual(
      new Set([nameOf.get(first), nameOf.get(second)]),
    );
  });

  it("defaults the audit actor to web, so a console press is not filed as agent work", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Console");

    await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });

    const audits = await enrichmentAudits(cigarId);
    expect(audits[0]).toMatchObject({ actor: "web", runId: null, confidence: null });
  });

  // The worklist gates on `rights <> 'suppressed'`; the enqueue's completeness gate
  // (assessEnrichmentFields, shared with add_cigar and get_cigar) counts ANY photo
  // row. So a suppressed photo plus full dimensions lands on the worklist and then
  // classifies `not_needed`. Prod has zero suppressed photos today, so this bites
  // nothing live — but it is real, and pinned here rather than left to be
  // rediscovered. Closing it means changing assessEnrichmentFields, which is the
  // add_cigar hot path: a separate PR (see #154).
  it("reports a suppressed-photo row as not_needed once dimensions are complete", async () => {
    const admin = await curator();
    const cigarId = await h.seedCigar({
      canonicalName: `Backlog Suppressed ${newRequestId()}`,
      type: "NC",
      lengthInches: "5.5",
      ringGauge: 50,
    });
    await h.deps.db.insert(purchases).values({ userId: admin.userId, cigarId, quantity: 1 });
    await seedPhoto(cigarId, "suppressed");

    const worklist = await cigarsMissingPhotos(h.deps, admin);
    expect(worklist.map((w) => w.cigarId)).toContain(cigarId);

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    expect(result.entries[0]).toMatchObject({ cigarId, status: "not_needed" });
    expect(await requestRows(cigarId)).toHaveLength(0);
  });

  it("queues a suppressed-photo row that is still missing dimensions", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Suppressed Sparse");
    await seedPhoto(cigarId, "suppressed");

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    expect(result.entries[0]).toMatchObject({ cigarId, status: "queued" });
  });

  it("leaves a photographed holding off the worklist entirely", async () => {
    const admin = await curator();
    const shot = await seedHeld(admin, "Backlog Shot");
    await seedPhoto(shot, "approved");

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    expect(result).toMatchObject({ eligible: 0, considered: 0, queued: 0, skipped: 0 });
    expect(result.entries).toEqual([]);
    expect(await requestRows(shot)).toHaveLength(0);
  });

  // --- awaitingVendors (#185) -------------------------------------------------

  // `already_queued` was the report's blind spot. Every OTHER verdict says what to
  // do about it; this one said only "something is queued", so a row held open by a
  // lane that stopped running looked exactly like a row being worked through
  // tonight. Naming the counted lanes that owe it a look is what makes the
  // operator's two levers — unsuspend the lane, or flip `crawl_enabled` off — a
  // choice rather than a guess.
  it("an already_queued row names the lanes that still owe it a look", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Awaiting Named");
    // Filed BEFORE the fixture fleet's enrich runs, so those lanes count against it
    // and none of them has spent anything on it.
    await h.deps.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "pending", createdAt: new Date("2026-08-01T00:00:00.000Z") });

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    const entry = result.entries.find((e) => e.cigarId === cigarId)!;

    expect(entry.status).toBe("already_queued");
    expect(entry.awaitingVendors?.length ?? 0).toBeGreaterThan(0);
    // Every awaited lane is one that COULD look — the two lists are the same fleet
    // read at different strengths, and a name in one that is absent from the other
    // would mean the denominator and the eligibility filter had drifted.
    for (const name of entry.awaitingVendors!) expect(result.eligibleVendors).toContain(name);
    // It is not a retirement, so the retirement list stays off the row.
    expect(entry.triedVendors).toBeUndefined();
    expect(await requestRows(cigarId)).toHaveLength(1);
  });

  // The other reading of the same field, and the reason it is omitted rather than
  // sent empty: no lane counts at all. The row is open and self-healing, nobody
  // owes it anything, and there is nothing for an operator to unsuspend.
  it("an already_queued row that no lane counts against carries no awaitingVendors", async () => {
    const admin = await curator();
    const cigarId = await seedHeld(admin, "Backlog Awaiting Nobody");
    // Filed NOW — after every fixture lane's last run — so liveness counts none of
    // them, and an empty ledger counts none of them either.
    await h.deps.db.insert(enrichmentRequests).values({ cigarId, status: "pending" });

    const result = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    const entry = result.entries.find((e) => e.cigarId === cigarId)!;

    expect(entry.status).toBe("already_queued");
    expect(entry.awaitingVendors).toBeUndefined();
    expect(await requestRows(cigarId)).toHaveLength(1);
  });
});
