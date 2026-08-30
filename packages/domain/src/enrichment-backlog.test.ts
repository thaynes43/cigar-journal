import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, enrichmentRequests, productPhotos, purchases } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { queueEnrichmentBacklog, cigarsMissingPhotos } from "./curation.js";
import { IdempotencyConflictError, UnauthorizedError } from "./errors.js";
import type { Principal } from "./deps.js";

// queueEnrichmentBacklog (#154): one press turns the "Missing photos" worklist into
// enrichment_requests rows. The worklist is principal-scoped, so every case gets its
// OWN admin — that is the isolation, and it doubles as the scoping proof.

describe("queueEnrichmentBacklog", () => {
  let h: DomainHarness;

  beforeAll(async () => {
    h = await createHarness();
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
  // owner's real photoless holdings.
  async function seedHeld(owner: Principal, name: string, quantity = 1): Promise<string> {
    const cigarId = await h.seedCigar({ canonicalName: `${name} ${newRequestId()}` });
    await h.deps.db.insert(purchases).values({ userId: owner.userId, cigarId, quantity });
    return cigarId;
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
    await h.deps.db.insert(enrichmentRequests).values({ cigarId, status: "exhausted" });

    const skipped = await queueEnrichmentBacklog(h.deps, admin, { clientRequestId: newRequestId() });
    expect(skipped.entries[0]).toMatchObject({ cigarId, status: "exhausted" });
    expect(skipped).toMatchObject({ queued: 0, skipped: 1 });
    expect(await requestRows(cigarId)).toHaveLength(1);

    const retried = await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      retryExhausted: true,
    });
    expect(retried.entries[0]).toMatchObject({ cigarId, status: "queued" });
    expect(await requestRows(cigarId)).toHaveLength(2);
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
    await seedHeld(admin, "Backlog Clamp");
    const result = await queueEnrichmentBacklog(h.deps, admin, {
      clientRequestId: newRequestId(),
      limit: 10_000,
    });
    expect(result).toMatchObject({ eligible: 1, considered: 1, queued: 1 });
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
});
