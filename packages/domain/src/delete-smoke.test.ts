import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { smokes, smokeProgression, auditLog, idempotencyKeys } from "@cj/db";
import { createMemoryPhotoStorage } from "@cj/photos";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { deleteSmoke } from "./delete-smoke.js";
import { addSmokePhoto, getSmokePhoto } from "./smoke-photos.js";
import { openPhotoDrop, stagePhotoByToken, claimPhotoDrop, getPhotoDropByToken } from "./photo-drops.js";
import { getSmoke } from "./reads.js";
import type { Principal, ProcessedImage } from "./index.js";
import { SmokeNotFoundError } from "./errors.js";

function image(): ProcessedImage {
  return {
    full: Buffer.from(`full-${newRequestId()}`),
    thumb: Buffer.from(`thumb-${newRequestId()}`),
    contentType: "image/jpeg",
    width: 1600,
    height: 1200,
    bytes: 4096,
  };
}

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
    const result = await deleteSmoke(h.deps, null, user, { smokeId });
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
    const error = await deleteSmoke(h.deps, null, other, { smokeId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmokeNotFoundError);
    expect(await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId))).toHaveLength(1);
  });

  it("answers a malformed smokeId exactly as it answers an unknown one", async () => {
    // #206. A non-uuid used to reach the `uuid` column and raise Postgres 22P02 —
    // untyped, so it escaped this refusal and became a 500 (and aborted a
    // transaction opened only to unwind it). The web procedure rejects a non-uuid
    // a layer earlier, so what is pinned here is the domain refusing to depend on
    // its adapter: malformed and unknown are one answer.
    const malformed = await deleteSmoke(h.deps, null, user, { smokeId: "not-a-uuid" }).catch(
      (e: unknown) => e,
    );
    const unknown = await deleteSmoke(h.deps, null, user, { smokeId: newRequestId() }).catch(
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

  it("sweeps the smoke's photo objects out of the bucket, drop-keyed ones included", async () => {
    // #264. ADR-007 puts object cleanup in @cj/domain, not the DB: smoke_photos
    // cascades with the smoke, so nothing but this would ever free the bytes.
    const storage = createMemoryPhotoStorage();
    const direct = await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() });

    // The second photo arrives through a drop, which keeps its `drop/` key across
    // the claim (ADR-014 moves the row, never the object) — the prefix the sweep
    // must not assume away.
    const drop = await openPhotoDrop(h.deps, storage, user);
    const staged = await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });
    await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });

    const directObj = await getSmokePhoto(h.deps, user, { photoId: direct.photoId });
    const dropObj = await getSmokePhoto(h.deps, user, { photoId: staged.photoId });
    expect(directObj.objectKey).toMatch(new RegExp(`^smoke/${smokeId}/`));
    expect(dropObj.objectKey).toMatch(new RegExp(`^drop/${drop.photoDropId}/`));

    await deleteSmoke(h.deps, storage, user, { smokeId });

    for (const key of [directObj.objectKey, directObj.thumbKey, dropObj.objectKey, dropObj.thumbKey]) {
      await expect(storage.get(key)).rejects.toThrow();
    }
    // The drop went with the smoke: claimed with no smoke is closed (ADR-014,
    // migration 0033's ON DELETE SET NULL).
    expect((await getPhotoDropByToken(h.deps, { token: drop.token })).status).toBe("closed");
  });

  it("deletes a photographed smoke with no storage configured, sweeping nothing and throwing nothing", async () => {
    const storage = createMemoryPhotoStorage();
    const photo = await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() });
    const object = await getSmokePhoto(h.deps, user, { photoId: photo.photoId });

    // Photos unconfigured cluster-wide: the delete is not the surface that
    // degrades (the journal works without a bucket), it just sweeps nothing.
    const result = await deleteSmoke(h.deps, null, user, { smokeId });

    expect(result.smokeId).toBe(smokeId);
    expect(await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId))).toHaveLength(0);
    await expect(storage.get(object.objectKey)).resolves.toBeDefined();
  });
});
