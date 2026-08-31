import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { smokes, smokeProgression, auditLog, idempotencyKeys } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { deleteSmoke } from "./delete-smoke.js";
import { getSmoke } from "./reads.js";
import type { Principal } from "./index.js";
import { SmokeNotFoundError } from "./errors.js";

describe("deleteSmoke", () => {
  let h: DomainHarness;
  let user: Principal;
  let smokeId: string;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("delete@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Doomed Cigar ${newRequestId()}` });
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
      progression: [{ stage: "opening", descriptors: ["cedar"], verbatim: "Woody start." }],
      assessment: { rating: 77, impression: "fine" },
    });
    smokeId = saved.smoke.smokeId;
  });

  it("removes the smoke and its progression, and writes a web audit tombstone with the before-snapshot", async () => {
    const result = await deleteSmoke(h.deps, user, { smokeId });
    expect(result.smokeId).toBe(smokeId);

    expect(await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId))).toHaveLength(0);
    expect(
      await h.deps.db.select().from(smokeProgression).where(eq(smokeProgression.smokeId, smokeId)),
    ).toHaveLength(0);
    // Retry keys for the deleted aggregate are gone.
    expect(
      await h.deps.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.smokeId, smokeId)),
    ).toHaveLength(0);

    // A deletion tombstone survives: actor web, full before-snapshot, no after.
    const tombstones = (await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId))).filter(
      (a) => a.action === "smoke.deleted",
    );
    expect(tombstones).toHaveLength(1);
    const tombstone = tombstones[0]!;
    expect(tombstone.actor).toBe("web");
    expect(tombstone.after).toBeNull();
    const before = tombstone.before as { id: string; rating: number | null; progression?: unknown[] };
    expect(before.id).toBe(smokeId);
    expect(before.rating).toBe(77);
    expect(before.progression).toHaveLength(1);

    // The smoke is unreadable afterward.
    const error = await getSmoke(h.deps, user, { smokeId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmokeNotFoundError);
  });

  it("refuses to delete another user's smoke, reporting not-found and leaving it intact", async () => {
    const other = await h.createUser(`intruder-${newRequestId()}@example.com`);
    const error = await deleteSmoke(h.deps, other, { smokeId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmokeNotFoundError);
    expect(await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId))).toHaveLength(1);
  });

  it("answers a malformed smokeId exactly as it answers an unknown one", async () => {
    // #206. A non-uuid used to reach the `uuid` column and raise Postgres 22P02 —
    // untyped, so it escaped this refusal and became a 500 (and aborted a
    // transaction opened only to unwind it). The web procedure rejects a non-uuid
    // a layer earlier, so what is pinned here is the domain refusing to depend on
    // its adapter: malformed and unknown are one answer.
    const malformed = await deleteSmoke(h.deps, user, { smokeId: "not-a-uuid" }).catch(
      (e: unknown) => e,
    );
    const unknown = await deleteSmoke(h.deps, user, { smokeId: newRequestId() }).catch(
      (e: unknown) => e,
    );

    expect(malformed).toBeInstanceOf(SmokeNotFoundError);
    expect(unknown).toBeInstanceOf(SmokeNotFoundError);
    expect((malformed as SmokeNotFoundError).toPayload()).toEqual(
      (unknown as SmokeNotFoundError).toPayload(),
    );

    // Neither refusal deleted anything.
    expect(await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId))).toHaveLength(1);
  });
});
