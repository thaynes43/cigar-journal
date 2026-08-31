import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, smokePhotos } from "@cj/db";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { getSmoke, queryMySmokes } from "./reads.js";
import {
  addSmokePhoto,
  listSmokePhotos,
  getSmokePhoto,
  removeSmokePhoto,
  MAX_PHOTOS_PER_SMOKE,
} from "./smoke-photos.js";
import { SmokeNotFoundError, PhotoNotFoundError, PhotoLimitError } from "./errors.js";
import type { Principal, ProcessedImage } from "./index.js";

function image(over: Partial<ProcessedImage> = {}): ProcessedImage {
  return {
    full: Buffer.from(`full-${newRequestId()}`),
    thumb: Buffer.from(`thumb-${newRequestId()}`),
    contentType: "image/jpeg",
    width: 1600,
    height: 1200,
    bytes: 4096,
    ...over,
  };
}

describe("smoke photos", () => {
  let h: DomainHarness;
  let storage: PhotoStorage;
  let user: Principal;
  let other: Principal;
  let smokeId: string;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("photos-owner@example.com");
    other = await h.createUser("photos-intruder@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    storage = createMemoryPhotoStorage();
    const cigarId = await h.seedCigar({ canonicalName: `Photogenic Cigar ${newRequestId()}` });
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
    });
    smokeId = saved.smoke.smokeId;
  });

  it("adds, lists, and serves a photo, storing both objects", async () => {
    const view = await addSmokePhoto(h.deps, storage, user, {
      smokeId,
      kind: "band",
      caption: "The band",
      image: image(),
    });
    expect(view.smokeId).toBe(smokeId);
    expect(view.kind).toBe("band");
    expect(view.caption).toBe("The band");
    expect(view.width).toBe(1600);
    expect(typeof view.createdAt).toBe("string");

    const listed = await listSmokePhotos(h.deps, user, { smokeId });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.photoId).toBe(view.photoId);

    // The serving route reads the storage coordinates; both objects are present.
    const obj = await getSmokePhoto(h.deps, user, { photoId: view.photoId });
    expect(obj.objectKey).toMatch(new RegExp(`^smoke/${smokeId}/[0-9a-f-]+\\.jpg$`));
    expect(obj.thumbKey).toMatch(new RegExp(`^smoke/${smokeId}/[0-9a-f-]+\\.thumb\\.jpg$`));
    // Same uuid backs both objects.
    expect(obj.objectKey.replace(/\.jpg$/, "")).toBe(obj.thumbKey.replace(/\.thumb\.jpg$/, ""));
    await expect(storage.get(obj.objectKey)).resolves.toBeDefined();
    await expect(storage.get(obj.thumbKey)).resolves.toBeDefined();

    // Additive on get_smoke.
    const smoke = await getSmoke(h.deps, user, { smokeId });
    expect(smoke.photos).toHaveLength(1);
    expect(smoke.photos[0]!.photoId).toBe(view.photoId);
  });

  it("defaults kind to other and keeps caption nullable", async () => {
    const view = await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() });
    expect(view.kind).toBe("other");
    expect(view.caption).toBeNull();
  });

  it("writes an audit row on add and a tombstone on remove, and deletes both objects", async () => {
    const view = await addSmokePhoto(h.deps, storage, user, { smokeId, kind: "burn", image: image() });
    const coords = await getSmokePhoto(h.deps, user, { photoId: view.photoId });

    const adds = (await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, smokeId))).filter(
      (a) => a.action === "smoke_photo.add",
    );
    expect(adds).toHaveLength(1);
    expect(adds[0]!.actor).toBe("web");
    expect(adds[0]!.before).toBeNull();
    expect((adds[0]!.after as { objectKey: string }).objectKey).toBe(coords.objectKey);

    const removed = await removeSmokePhoto(h.deps, storage, user, { photoId: view.photoId });
    expect(removed.photoId).toBe(view.photoId);

    // Row gone.
    expect(await h.deps.db.select().from(smokePhotos).where(eq(smokePhotos.id, view.photoId))).toHaveLength(0);
    // Storage objects gone.
    await expect(storage.get(coords.objectKey)).rejects.toThrow();
    await expect(storage.get(coords.thumbKey)).rejects.toThrow();
    // Tombstone with the before-snapshot.
    const tombstones = (
      await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, smokeId))
    ).filter((a) => a.action === "smoke_photo.remove");
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.after).toBeNull();
    expect((tombstones[0]!.before as { id: string }).id).toBe(view.photoId);
  });

  it("isolates by owner: a non-owner cannot add, list, serve, or remove", async () => {
    const view = await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() });

    const addErr = await addSmokePhoto(h.deps, storage, other, { smokeId, image: image() }).catch(
      (e: unknown) => e,
    );
    expect(addErr).toBeInstanceOf(SmokeNotFoundError);

    // The intruder sees no photos and cannot serve or remove the owner's photo.
    expect(await listSmokePhotos(h.deps, other, { smokeId })).toHaveLength(0);
    const getErr = await getSmokePhoto(h.deps, other, { photoId: view.photoId }).catch((e: unknown) => e);
    expect(getErr).toBeInstanceOf(PhotoNotFoundError);
    const removeErr = await removeSmokePhoto(h.deps, storage, other, { photoId: view.photoId }).catch(
      (e: unknown) => e,
    );
    expect(removeErr).toBeInstanceOf(PhotoNotFoundError);

    // The owner's photo is untouched.
    expect(await listSmokePhotos(h.deps, user, { smokeId })).toHaveLength(1);
  });

  it("enforces the per-smoke photo cap", async () => {
    for (let i = 0; i < MAX_PHOTOS_PER_SMOKE; i++) {
      await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() });
    }
    const err = await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PhotoLimitError);
    expect((err as PhotoLimitError).limit).toBe(MAX_PHOTOS_PER_SMOKE);
    expect(await listSmokePhotos(h.deps, user, { smokeId })).toHaveLength(MAX_PHOTOS_PER_SMOKE);
  });

  it("reports photoCount on queryMySmokes", async () => {
    await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() });
    await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() });

    const result = await queryMySmokes(h.deps, user, { limit: 25 });
    const summary = result.smokes.find((s) => s.smokeId === smokeId);
    expect(summary?.photoCount).toBe(2);
  });

  // #206. Every entry point below takes an id the caller chose — an MCP tool
  // argument or an image-URL segment — and carried it raw into a `uuid` column,
  // where a non-uuid raised Postgres 22P02 and escaped as a 500. Each assertion is
  // the same: malformed must be INDISTINGUISHABLE from unknown-but-valid.
  it("addSmokePhoto answers a malformed id exactly as it answers an unknown one", async () => {
    const malformed = await addSmokePhoto(h.deps, storage, user, {
      smokeId: "not-a-uuid",
      image: image(),
    }).catch((e: unknown) => e);
    const unknown = await addSmokePhoto(h.deps, storage, user, {
      smokeId: newRequestId(),
      image: image(),
    }).catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(SmokeNotFoundError);
    expect(unknown).toBeInstanceOf(SmokeNotFoundError);
    expect((malformed as SmokeNotFoundError).toPayload()).toEqual(
      (unknown as SmokeNotFoundError).toPayload(),
    );
  });

  it("listSmokePhotos answers a malformed id exactly as it answers an unknown one", async () => {
    // A listing, not an identity: emptiness is the shared answer.
    const malformed = await listSmokePhotos(h.deps, user, { smokeId: "not-a-uuid" });
    const unknown = await listSmokePhotos(h.deps, user, { smokeId: newRequestId() });
    expect(malformed).toEqual(unknown);
    expect(malformed).toEqual([]);
  });

  it("getSmokePhoto answers a malformed id exactly as it answers an unknown one", async () => {
    const malformed = await getSmokePhoto(h.deps, user, { photoId: "not-a-uuid" }).catch(
      (e: unknown) => e,
    );
    const unknown = await getSmokePhoto(h.deps, user, { photoId: newRequestId() }).catch(
      (e: unknown) => e,
    );
    expect(malformed).toBeInstanceOf(PhotoNotFoundError);
    expect(unknown).toBeInstanceOf(PhotoNotFoundError);
    expect((malformed as PhotoNotFoundError).toPayload()).toEqual(
      (unknown as PhotoNotFoundError).toPayload(),
    );
  });

  it("removeSmokePhoto answers a malformed id exactly as it answers an unknown one", async () => {
    const malformed = await removeSmokePhoto(h.deps, storage, user, {
      photoId: "not-a-uuid",
    }).catch((e: unknown) => e);
    const unknown = await removeSmokePhoto(h.deps, storage, user, {
      photoId: newRequestId(),
    }).catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(PhotoNotFoundError);
    expect(unknown).toBeInstanceOf(PhotoNotFoundError);
    expect((malformed as PhotoNotFoundError).toPayload()).toEqual(
      (unknown as PhotoNotFoundError).toPayload(),
    );
  });
});
