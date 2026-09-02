import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, photoDrops, stagedSmokePhotos } from "@cj/db";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { deleteSmoke } from "./delete-smoke.js";
import { addSmokePhoto, listSmokePhotos, MAX_PHOTOS_PER_SMOKE } from "./smoke-photos.js";
import {
  openPhotoDrop,
  claimPhotoDrop,
  sweepPhotoDrops,
  getPhotoDropByToken,
  assertPhotoDropUsable,
  stagePhotoByToken,
  setPhotoDropPhotoKind,
  removePhotoDropPhoto,
  getPhotoDropPhotoObject,
  MAX_PHOTOS_PER_DROP,
  PHOTO_DROP_TTL_SECONDS,
} from "./photo-drops.js";
import { PhotoLimitError, PhotoNotFoundError, SmokeNotFoundError, UploadTokenInvalidError } from "./errors.js";
import type { Principal, ProcessedImage } from "./index.js";

// The clock the harness starts on. `deps.now` drives every expiry decision, so a
// test that wants a dead drop moves the clock rather than waiting.
const BASE = new Date("2026-08-27T12:00:00.000Z");

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

describe("photo drops", () => {
  let h: DomainHarness;
  let storage: PhotoStorage;
  let user: Principal;
  let cigarId: string;

  beforeAll(async () => {
    h = await createHarness();
    cigarId = await h.seedCigar({ canonicalName: `Drop Subject ${newRequestId()}` });
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // ONE open drop per user is the rule under test in half this file, so every
  // test gets its own user rather than inheriting the previous test's drop.
  beforeEach(async () => {
    h.setNow(BASE);
    storage = createMemoryPhotoStorage();
    user = await h.createUser(`drop-${newRequestId()}@example.com`);
  });

  async function newSmoke(owner: Principal = user): Promise<string> {
    const saved = await saveSmoke(h.deps, owner, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
    });
    return saved.smoke.smokeId;
  }

  async function auditActions(dropId: string): Promise<string[]> {
    const rows = await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId));
    return rows
      .filter((r) => JSON.stringify(r.after ?? {}).includes(dropId) || r.action.startsWith("staged_photo."))
      .map((r) => r.action);
  }

  it("opens a fresh drop, audited, with a link that reads open and empty", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);

    expect(drop.reused).toBe(false);
    expect(drop.photoCount).toBe(0);
    expect(drop.token).toHaveLength(43); // 32 random bytes, base64url
    expect(drop.expiresAt).toBe(new Date(BASE.getTime() + PHOTO_DROP_TTL_SECONDS * 1000).toISOString());

    // The raw token is returned, never stored.
    const rows = await h.deps.db.select().from(photoDrops).where(eq(photoDrops.id, drop.photoDropId));
    expect(rows[0]!.tokenHash).not.toBe(drop.token);
    expect(rows[0]!.claimedAt).toBeNull();
    expect(rows[0]!.smokeId).toBeNull();

    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view).toMatchObject({ photoDropId: drop.photoDropId, status: "open", smokeId: null, photos: [] });

    expect(await auditActions(drop.photoDropId)).toContain("photo_drop.open");
  });

  it("re-opens the same drop with a fresh token and kills the old link", async () => {
    const first = await openPhotoDrop(h.deps, storage, user);
    await stagePhotoByToken(h.deps, storage, { token: first.token, image: image() });
    await stagePhotoByToken(h.deps, storage, { token: first.token, kind: "band", image: image() });

    const second = await openPhotoDrop(h.deps, storage, user);
    expect(second.photoDropId).toBe(first.photoDropId);
    expect(second.reused).toBe(true);
    expect(second.photoCount).toBe(2);
    expect(second.token).not.toBe(first.token);
    // The expiry runs from the OPENING; re-opening does not extend it.
    expect(second.expiresAt).toBe(first.expiresAt);

    // The raw token is not re-derivable, so handing the drop back necessarily
    // rotated it — the earlier link is now simply unknown.
    await expect(assertPhotoDropUsable(h.deps, { token: first.token })).rejects.toBeInstanceOf(
      UploadTokenInvalidError,
    );
    await expect(getPhotoDropByToken(h.deps, { token: first.token })).rejects.toBeInstanceOf(
      UploadTokenInvalidError,
    );

    await assertPhotoDropUsable(h.deps, { token: second.token });
    const view = await getPhotoDropByToken(h.deps, { token: second.token });
    expect(view.photos).toHaveLength(2);
    expect(view.photos.every((p) => p.attached === false)).toBe(true);
    expect(await auditActions(first.photoDropId)).toContain("photo_drop.rotate");
  });

  it("stages photos under drop/ keys up to the cap, then refuses", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);

    for (let i = 0; i < MAX_PHOTOS_PER_DROP; i++) {
      await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });
    }
    const err = await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PhotoLimitError);
    expect((err as PhotoLimitError).limit).toBe(MAX_PHOTOS_PER_DROP);

    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view.photos).toHaveLength(MAX_PHOTOS_PER_DROP);

    const obj = await getPhotoDropPhotoObject(h.deps, {
      token: drop.token,
      photoId: view.photos[0]!.photoId,
    });
    expect(obj.objectKey).toMatch(new RegExp(`^drop/${drop.photoDropId}/[0-9a-f-]+\\.jpg$`));
    expect(obj.thumbKey).toMatch(new RegExp(`^drop/${drop.photoDropId}/[0-9a-f-]+\\.thumb\\.jpg$`));
    await expect(storage.get(obj.objectKey)).resolves.toBeDefined();
  });

  it("reclassifies a staged photo through the link", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    const staged = await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });
    expect(staged.kind).toBe("other");

    const updated = await setPhotoDropPhotoKind(h.deps, {
      token: drop.token,
      photoId: staged.photoId,
      kind: "construction",
    });
    expect(updated).toMatchObject({ photoId: staged.photoId, kind: "construction", attached: false });

    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view.photos[0]!.kind).toBe("construction");

    // A photo of another drop (or none at all) is not addressable through this link.
    await expect(
      setPhotoDropPhotoKind(h.deps, { token: drop.token, photoId: newRequestId(), kind: "burn" }),
    ).rejects.toBeInstanceOf(PhotoNotFoundError);
  });

  it("removes a staged photo with its objects and a tombstone", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    const staged = await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });
    const obj = await getPhotoDropPhotoObject(h.deps, { token: drop.token, photoId: staged.photoId });

    const removed = await removePhotoDropPhoto(h.deps, storage, {
      token: drop.token,
      photoId: staged.photoId,
    });
    expect(removed.photoId).toBe(staged.photoId);

    await expect(storage.get(obj.objectKey)).rejects.toThrow();
    await expect(storage.get(obj.thumbKey)).rejects.toThrow();
    expect((await getPhotoDropByToken(h.deps, { token: drop.token })).photos).toEqual([]);

    const tombstones = (
      await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId))
    ).filter((a) => a.action === "staged_photo.remove");
    expect(tombstones).toHaveLength(1);
    expect((tombstones[0]!.before as { id: string }).id).toBe(staged.photoId);
    expect(tombstones[0]!.after).toBeNull();
  });

  it("claims a drop onto a smoke, moving every staged photo with its id and audit", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    const staged = [
      await stagePhotoByToken(h.deps, storage, { token: drop.token, kind: "cigar", image: image() }),
      await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() }),
      await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() }),
    ];
    const smokeId = await newSmoke();

    const claim = await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
    expect(claim).toEqual({ photoDropId: drop.photoDropId, status: "claimed", attached: 3, pending: 0 });

    // Same ids, same order — a move, not a copy.
    const photos = await listSmokePhotos(h.deps, user, { smokeId });
    expect(photos.map((p) => p.photoId)).toEqual(staged.map((p) => p.photoId));
    expect(photos[0]!.kind).toBe("cigar");
    expect(
      await h.deps.db.select().from(stagedSmokePhotos).where(eq(stagedSmokePhotos.dropId, drop.photoDropId)),
    ).toHaveLength(0);

    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view.status).toBe("attached");
    expect(view.smokeId).toBe(smokeId);
    expect(view.photos.map((p) => p.attached)).toEqual([true, true, true]);

    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, smokeId));
    const adds = audits.filter((a) => a.action === "smoke_photo.add");
    expect(adds).toHaveLength(3);
    expect((adds[0]!.after as { via: string }).via).toBe("photo_drop");
    const claims = audits.filter((a) => a.action === "photo_drop.claim");
    expect(claims).toHaveLength(1);
    expect(claims[0]!.after).toMatchObject({ photoDropId: drop.photoDropId, attached: 3, pending: 0 });
  });

  it("claims only what the smoke has room for and leaves the remainder staged", async () => {
    const smokeId = await newSmoke();
    for (let i = 0; i < MAX_PHOTOS_PER_SMOKE - 1; i++) {
      await addSmokePhoto(h.deps, storage, user, { smokeId, image: image() });
    }
    const drop = await openPhotoDrop(h.deps, storage, user);
    for (let i = 0; i < 3; i++) {
      await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });
    }

    const claim = await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
    expect(claim).toMatchObject({ status: "claimed", attached: 1, pending: 2 });
    expect(await listSmokePhotos(h.deps, user, { smokeId })).toHaveLength(MAX_PHOTOS_PER_SMOKE);
    expect(
      await h.deps.db.select().from(stagedSmokePhotos).where(eq(stagedSmokePhotos.dropId, drop.photoDropId)),
    ).toHaveLength(2);

    // The remainder is still the link's — it shows the smoke's photos, then what
    // is still waiting.
    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view.photos.filter((p) => p.attached)).toHaveLength(MAX_PHOTOS_PER_SMOKE);
    expect(view.photos.filter((p) => !p.attached)).toHaveLength(2);
  });

  it("is idempotent on a re-claim of the same smoke", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });
    const smokeId = await newSmoke();

    const first = await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
    expect(first).toMatchObject({ status: "claimed", attached: 1, pending: 0 });
    const claimedAt = (
      await h.deps.db.select().from(photoDrops).where(eq(photoDrops.id, drop.photoDropId))
    )[0]!.claimedAt;

    h.setNow(new Date(BASE.getTime() + 3600_000));
    const second = await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
    expect(second).toMatchObject({ status: "claimed", attached: 0, pending: 0 });
    // COALESCE, not an overwrite: the drop was claimed once.
    expect(
      (await h.deps.db.select().from(photoDrops).where(eq(photoDrops.id, drop.photoDropId)))[0]!.claimedAt,
    ).toEqual(claimedAt);
    expect(await listSmokePhotos(h.deps, user, { smokeId })).toHaveLength(1);
  });

  it("reports not_found for another user's drop and for a malformed id, and never leaks", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });

    const intruder = await h.createUser(`drop-intruder-${newRequestId()}@example.com`);
    const theirSmoke = await newSmoke(intruder);

    const crossUser = await claimPhotoDrop(h.deps, intruder, {
      photoDropId: drop.photoDropId,
      smokeId: theirSmoke,
    });
    const unknown = await claimPhotoDrop(h.deps, intruder, {
      photoDropId: newRequestId(),
      smokeId: theirSmoke,
    });
    const malformed = await claimPhotoDrop(h.deps, intruder, {
      photoDropId: "not-a-uuid",
      smokeId: theirSmoke,
    });
    expect(crossUser.status).toBe("not_found");
    expect(unknown.status).toBe("not_found");
    expect(malformed.status).toBe("not_found");

    // Nothing moved, and the owner's drop is untouched.
    expect(await listSmokePhotos(h.deps, intruder, { smokeId: theirSmoke })).toHaveLength(0);
    expect((await getPhotoDropByToken(h.deps, { token: drop.token })).status).toBe("open");
  });

  it("throws smoke_not_found for a smoke that is not the claimer's", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    const stranger = await h.createUser(`drop-stranger-${newRequestId()}@example.com`);
    const theirSmoke = await newSmoke(stranger);

    // A wrong drop id is REPORTED; a wrong smoke id is a caller error and throws.
    const cross = await claimPhotoDrop(h.deps, user, {
      photoDropId: drop.photoDropId,
      smokeId: theirSmoke,
    }).catch((e: unknown) => e);
    const unknown = await claimPhotoDrop(h.deps, user, {
      photoDropId: drop.photoDropId,
      smokeId: newRequestId(),
    }).catch((e: unknown) => e);
    expect(cross).toBeInstanceOf(SmokeNotFoundError);
    expect(unknown).toBeInstanceOf(SmokeNotFoundError);
    expect((cross as SmokeNotFoundError).toPayload()).toEqual((unknown as SmokeNotFoundError).toPayload());
  });

  it("refuses a second smoke once the drop is bound, moving nothing", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });
    const first = await newSmoke();
    const second = await newSmoke();

    await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId: first });
    const rebind = await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId: second });

    expect(rebind).toEqual({
      photoDropId: drop.photoDropId,
      status: "bound_elsewhere",
      attached: 0,
      pending: 0,
    });
    expect(await listSmokePhotos(h.deps, user, { smokeId: first })).toHaveLength(1);
    expect(await listSmokePhotos(h.deps, user, { smokeId: second })).toHaveLength(0);
  });

  it("sends a post-claim upload straight to the smoke through the same link", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    const smokeId = await newSmoke();
    await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });

    const added = await stagePhotoByToken(h.deps, storage, {
      token: drop.token,
      kind: "burn",
      image: image(),
    });
    expect(added.attached).toBe(true);
    expect(added.kind).toBe("burn");

    const photos = await listSmokePhotos(h.deps, user, { smokeId });
    expect(photos.map((p) => p.photoId)).toEqual([added.photoId]);
    // It went in as an ordinary smoke photo, keyed under the smoke.
    const obj = await getPhotoDropPhotoObject(h.deps, { token: drop.token, photoId: added.photoId });
    expect(obj.objectKey).toMatch(new RegExp(`^smoke/${smokeId}/`));
    expect(
      await h.deps.db.select().from(stagedSmokePhotos).where(eq(stagedSmokePhotos.dropId, drop.photoDropId)),
    ).toHaveLength(0);
  });

  it("closes at the expiry: uploads refused, the page shows nothing", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });

    h.setNow(new Date(BASE.getTime() + (PHOTO_DROP_TTL_SECONDS + 60) * 1000));

    await expect(
      stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() }),
    ).rejects.toBeInstanceOf(UploadTokenInvalidError);
    await expect(assertPhotoDropUsable(h.deps, { token: drop.token })).rejects.toBeInstanceOf(
      UploadTokenInvalidError,
    );

    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view.status).toBe("closed");
    expect(view.photos).toEqual([]);
  });

  it("closes a claimed drop when its smoke is deleted", async () => {
    const drop = await openPhotoDrop(h.deps, storage, user);
    await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });
    const smokeId = await newSmoke();
    await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
    expect((await getPhotoDropByToken(h.deps, { token: drop.token })).status).toBe("attached");

    await deleteSmoke(h.deps, user, { smokeId });

    // photo_drops.smoke_id is ON DELETE SET NULL: claimed with no smoke is closed.
    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view.status).toBe("closed");
    expect(view.smokeId).toBeNull();
    expect(view.photos).toEqual([]);
    await expect(
      stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() }),
    ).rejects.toBeInstanceOf(UploadTokenInvalidError);
  });

  it("sweeps a drop past retention with its objects and leaves a live one alone", async () => {
    const stale = await openPhotoDrop(h.deps, storage, user);
    const staged = await stagePhotoByToken(h.deps, storage, { token: stale.token, image: image() });
    const obj = await getPhotoDropPhotoObject(h.deps, { token: stale.token, photoId: staged.photoId });

    // created_at defaults to the database clock, so age it explicitly rather than
    // moving the harness clock (which would also expire the live drop below).
    await h.deps.db
      .update(photoDrops)
      .set({ createdAt: new Date(BASE.getTime() - 8 * 86_400 * 1000) })
      .where(eq(photoDrops.id, stale.photoDropId));

    const live = await h.createUser(`drop-live-${newRequestId()}@example.com`);
    const liveDrop = await openPhotoDrop(h.deps, storage, live);
    await stagePhotoByToken(h.deps, storage, { token: liveDrop.token, image: image() });

    const swept = await sweepPhotoDrops(h.deps, storage, { userId: user.userId });
    expect(swept).toEqual({ drops: 1, photos: 1 });

    await expect(storage.get(obj.objectKey)).rejects.toThrow();
    await expect(storage.get(obj.thumbKey)).rejects.toThrow();
    await expect(getPhotoDropByToken(h.deps, { token: stale.token })).rejects.toBeInstanceOf(
      UploadTokenInvalidError,
    );
    // Another user's live drop is untouched — the sweep is owner-scoped.
    expect((await getPhotoDropByToken(h.deps, { token: liveDrop.token })).photos).toHaveLength(1);
  });

  it("sweeps on the next open, and a sweep failure never costs the caller a link", async () => {
    const stale = await openPhotoDrop(h.deps, storage, user);
    await stagePhotoByToken(h.deps, storage, { token: stale.token, image: image() });
    await h.deps.db
      .update(photoDrops)
      .set({ createdAt: new Date(BASE.getTime() - 8 * 86_400 * 1000) })
      .where(eq(photoDrops.id, stale.photoDropId));

    // A bucket that refuses every delete: the sweep cannot finish, and the open
    // must still succeed (ADR-014 — the lifecycle rides the open, it does not gate it).
    const broken: PhotoStorage = {
      ...storage,
      delete: () => Promise.reject(new Error("bucket unavailable")),
    };
    const fresh = await openPhotoDrop(h.deps, broken, user);
    expect(fresh.reused).toBe(false);
    expect(fresh.photoDropId).not.toBe(stale.photoDropId);
  });

  it("answers an unknown token with one error, whatever the caller asked for", async () => {
    const token = "definitely-not-a-token";
    const payloads = await Promise.all(
      [
        getPhotoDropByToken(h.deps, { token }),
        assertPhotoDropUsable(h.deps, { token }),
        stagePhotoByToken(h.deps, storage, { token, image: image() }),
        getPhotoDropPhotoObject(h.deps, { token, photoId: newRequestId() }),
      ].map((p) => p.catch((e: unknown) => e)),
    );
    for (const error of payloads) {
      expect(error).toBeInstanceOf(UploadTokenInvalidError);
    }
  });
});
