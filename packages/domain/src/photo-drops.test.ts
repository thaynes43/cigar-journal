import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, photoDrops, stagedSmokePhotos } from "@cj/db";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { deleteSmoke } from "./delete-smoke.js";
import { addSmokePhoto, listSmokePhotos, MAX_PHOTOS_PER_SMOKE } from "./smoke-photos.js";
import { getSmoke } from "./reads.js";
import {
  openPhotoDrop,
  claimPhotoDrop,
  sweepPhotoDrops,
  getPhotoDropByToken,
  assertPhotoDropUsable,
  stagePhotoByToken,
  updatePhotoDropPhoto,
  removePhotoDropPhoto,
  getPhotoDropPhotoObject,
  MAX_PHOTOS_PER_DROP,
  PHOTO_DROP_TTL_SECONDS,
  DROP_SESSION_GAP_HOURS,
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

  async function auditRows(action: string) {
    const rows = await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId));
    return rows.filter((r) => r.action === action);
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
    // The default is `cigar` (#287) — the common photo is the stick itself.
    expect(staged.kind).toBe("cigar");

    const updated = await updatePhotoDropPhoto(h.deps, {
      token: drop.token,
      photoId: staged.photoId,
      kind: "construction",
    });
    expect(updated).toMatchObject({ photoId: staged.photoId, kind: "construction", attached: false });

    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view.photos[0]!.kind).toBe("construction");

    // A photo of another drop (or none at all) is not addressable through this link.
    await expect(
      updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: newRequestId(), kind: "burn" }),
    ).rejects.toBeInstanceOf(PhotoNotFoundError);
  });

  it("audits a kind change staged and attached, and writes nothing for a no-op", async () => {
    // #267. Every other mutation on these two tables leaves a row; a change made
    // through the anonymous link is the one that most needs to be traceable.
    const drop = await openPhotoDrop(h.deps, storage, user);
    const staged = await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });

    await updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: staged.photoId, kind: "band" });
    await updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: staged.photoId, kind: "band" });

    const stagedRows = await auditRows("staged_photo.kind");
    expect(stagedRows).toHaveLength(1);
    // The drop's owner, attributed to no credential — the writer held a token.
    expect(stagedRows[0]!.actor).toBe("web");
    expect(stagedRows[0]!.clientId).toBeNull();
    expect(stagedRows[0]!.smokeId).toBeNull();
    expect(stagedRows[0]!.before).toEqual({ photoId: staged.photoId, kind: "cigar" });
    expect(stagedRows[0]!.after).toEqual({ photoId: staged.photoId, kind: "band" });

    // The same photo after the claim: the row lives on smoke_photos now, so the
    // action changes and the audit row can finally name the smoke.
    const smokeId = await newSmoke();
    await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
    await updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: staged.photoId, kind: "burn" });
    await updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: staged.photoId, kind: "burn" });

    const attachedRows = await auditRows("smoke_photo.kind");
    expect(attachedRows).toHaveLength(1);
    expect(attachedRows[0]!.smokeId).toBe(smokeId);
    expect(attachedRows[0]!.before).toEqual({ photoId: staged.photoId, kind: "band" });
    expect(attachedRows[0]!.after).toEqual({ photoId: staged.photoId, kind: "burn" });
    expect(await auditRows("staged_photo.kind")).toHaveLength(1);
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

  it("preserves each photo's created_at across the claim, and keeps the order stable on a tie", async () => {
    // #288. Two invariants that only bite with SEVERAL photos, which is the case
    // the drop was built for and the one never exercised live.
    //
    // The claim is a MOVE: the row keeps its id, its keys AND its created_at, so
    // the smoke's photos stay in the order they were taken rather than in the
    // order the transaction happened to insert them.
    //
    // And `created_at, id`, not `created_at` alone: three photos dropped in one
    // burst can land in the same millisecond, and a same-timestamp tie under
    // `ORDER BY created_at` is unordered — the planner may hand back a different
    // order on the next read of the same rows. The tie is forced here rather than
    // hoped for, because a real burst produces it only sometimes.
    const drop = await openPhotoDrop(h.deps, storage, user);
    const staged = [
      await stagePhotoByToken(h.deps, storage, { token: drop.token, kind: "cigar", image: image() }),
      await stagePhotoByToken(h.deps, storage, { token: drop.token, kind: "band", image: image() }),
      await stagePhotoByToken(h.deps, storage, { token: drop.token, kind: "burn", image: image() }),
    ];
    const tie = new Date("2026-08-27T12:34:56.000Z");
    for (const photo of staged) {
      await h.deps.db
        .update(stagedSmokePhotos)
        .set({ createdAt: tie })
        .where(eq(stagedSmokePhotos.id, photo.photoId));
    }
    // Postgres compares a uuid by its bytes and the dashes sit at fixed
    // positions, so plain code-unit order on the text form is the same order.
    const byId = [...staged].sort((a, b) => (a.photoId < b.photoId ? -1 : 1));

    // The drop's own page already agrees with the tie-break before the claim.
    const beforeClaim = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(beforeClaim.photos.map((p) => p.photoId)).toEqual(byId.map((p) => p.photoId));

    const smokeId = await newSmoke();
    await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });

    const photos = await listSmokePhotos(h.deps, user, { smokeId });
    expect(photos.map((p) => p.createdAt)).toEqual([tie.toISOString(), tie.toISOString(), tie.toISOString()]);
    expect(photos.map((p) => p.photoId)).toEqual(byId.map((p) => p.photoId));
    // Every kind survives the move, each on its own photo.
    expect(photos.map((p) => p.kind)).toEqual(byId.map((p) => p.kind));

    // Stable across reads and across surfaces: the same order twice, and the same
    // order the link reports.
    expect((await listSmokePhotos(h.deps, user, { smokeId })).map((p) => p.photoId)).toEqual(
      byId.map((p) => p.photoId),
    );
    const view = await getPhotoDropByToken(h.deps, { token: drop.token });
    expect(view.photos.map((p) => p.photoId)).toEqual(byId.map((p) => p.photoId));
  });

  it("captions a photo through the link, staged and attached, and clears it with null", async () => {
    // #288: the drop page is where the user is when a photo is worth a line, so
    // the caption rides the same PATCH the kind chips use — either field alone.
    const drop = await openPhotoDrop(h.deps, storage, user);
    const staged = await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });

    const captioned = await updatePhotoDropPhoto(h.deps, {
      token: drop.token,
      photoId: staged.photoId,
      caption: "  First third  ",
    });
    // Trimmed on the way in; the kind it arrived with is untouched.
    expect(captioned).toMatchObject({ caption: "First third", kind: "cigar" });

    // Both fields at once, then the erase.
    const both = await updatePhotoDropPhoto(h.deps, {
      token: drop.token,
      photoId: staged.photoId,
      kind: "band",
      caption: "The second band",
    });
    expect(both).toMatchObject({ caption: "The second band", kind: "band" });

    // Blank IS the erase — the column carries a caption or it carries nothing.
    expect(
      (await updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: staged.photoId, caption: "   " }))
        .caption,
    ).toBeNull();

    const smokeId = await newSmoke();
    await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
    const attached = await updatePhotoDropPhoto(h.deps, {
      token: drop.token,
      photoId: staged.photoId,
      caption: "Halfway",
    });
    expect(attached).toMatchObject({ caption: "Halfway", attached: true });
    expect((await listSmokePhotos(h.deps, user, { smokeId }))[0]!.caption).toBe("Halfway");
  });

  it("audits a caption change staged and attached, and writes nothing for a no-op", async () => {
    // The kind's audit contract (#267), held for the caption on the same pattern:
    // one row per changed field, attributed to the drop's owner with no client,
    // and nothing at all when the value did not move.
    const drop = await openPhotoDrop(h.deps, storage, user);
    const staged = await stagePhotoByToken(h.deps, storage, { token: drop.token, image: image() });

    await updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: staged.photoId, caption: "Foot" });
    await updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: staged.photoId, caption: "Foot" });

    const stagedRows = await auditRows("staged_photo.caption");
    expect(stagedRows).toHaveLength(1);
    expect(stagedRows[0]!.actor).toBe("web");
    expect(stagedRows[0]!.clientId).toBeNull();
    expect(stagedRows[0]!.smokeId).toBeNull();
    expect(stagedRows[0]!.before).toEqual({ photoId: staged.photoId, caption: null });
    expect(stagedRows[0]!.after).toEqual({ photoId: staged.photoId, caption: "Foot" });

    // One call changing BOTH fields leaves one row per field, not a merged one.
    await updatePhotoDropPhoto(h.deps, {
      token: drop.token,
      photoId: staged.photoId,
      kind: "burn",
      caption: "Ash",
    });
    expect(await auditRows("staged_photo.caption")).toHaveLength(2);
    expect(await auditRows("staged_photo.kind")).toHaveLength(1);

    const smokeId = await newSmoke();
    await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
    await updatePhotoDropPhoto(h.deps, { token: drop.token, photoId: staged.photoId, caption: null });

    const attachedRows = await auditRows("smoke_photo.caption");
    expect(attachedRows).toHaveLength(1);
    expect(attachedRows[0]!.smokeId).toBe(smokeId);
    expect(attachedRows[0]!.after).toEqual({ photoId: staged.photoId, caption: null });
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

    await deleteSmoke(h.deps, storage, user, { smokeId });

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

  // The drop's SESSION window (ADR-016). `created_at` cannot be the smoke's
  // start: one open drop per user means the same drop carries evening after
  // evening — the drop the 2026-09-02 save claimed had been created 23 hours
  // earlier and was merely re-opened for that night's first photo.
  describe("session window", () => {
    async function dropRow(id: string) {
      const rows = await h.deps.db.select().from(photoDrops).where(eq(photoDrops.id, id));
      return rows[0]!;
    }

    it("opens a fresh drop with both stamps on this open", async () => {
      const drop = await openPhotoDrop(h.deps, storage, user);
      const row = await dropRow(drop.photoDropId);
      expect(row.sessionStartedAt.toISOString()).toBe(BASE.toISOString());
      expect(row.lastOpenedAt.toISOString()).toBe(BASE.toISOString());
    });

    it("continues the session when the re-open falls inside the gap", async () => {
      const first = await openPhotoDrop(h.deps, storage, user);
      const later = new Date(BASE.getTime() + 90 * 60_000); // 1h30m — the same evening
      h.setNow(later);
      const again = await openPhotoDrop(h.deps, storage, user);
      expect(again.reused).toBe(true);

      const row = await dropRow(first.photoDropId);
      expect(row.sessionStartedAt.toISOString()).toBe(BASE.toISOString());
      // The gap is always measured from the LAST open, never from the session.
      expect(row.lastOpenedAt.toISOString()).toBe(later.toISOString());
    });

    it("starts a new session when the re-open falls past the gap", async () => {
      const first = await openPhotoDrop(h.deps, storage, user);
      const tomorrow = new Date(BASE.getTime() + (DROP_SESSION_GAP_HOURS + 1) * 3600_000);
      h.setNow(tomorrow);
      const again = await openPhotoDrop(h.deps, storage, user);
      expect(again.reused).toBe(true);

      const row = await dropRow(first.photoDropId);
      expect(row.sessionStartedAt.toISOString()).toBe(tomorrow.toISOString());
      expect(row.lastOpenedAt.toISOString()).toBe(tomorrow.toISOString());
      // The drop itself is the same one — only its session moved. Which is the
      // whole point: creation and session start have parted company, and it is
      // the session the save reads.
      expect(again.photoDropId).toBe(first.photoDropId);
      expect(row.sessionStartedAt.getTime()).not.toBe(row.createdAt.getTime());
    });

    it("a late claim fills the start from the session, and never overwrites one", async () => {
      // The drop is a day old and was re-opened at the start of tonight's smoke,
      // so the session — not the creation — is what the claim writes.
      const created = new Date("2026-09-01T02:50:00.000Z");
      h.setNow(created);
      const drop = await openPhotoDrop(h.deps, storage, user);
      const lit = new Date("2026-09-02T01:04:00.000Z");
      h.setNow(lit);
      // Tonight's first photo re-opens the same drop, which resets its session.
      const reopened = await openPhotoDrop(h.deps, storage, user);
      expect(reopened.photoDropId).toBe(drop.photoDropId);
      await stagePhotoByToken(h.deps, storage, { token: reopened.token, image: image() });

      h.setNow(new Date("2026-09-02T02:20:00.000Z"));
      const smokeId = await newSmoke();
      const claim = await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
      expect(claim.status).toBe("claimed");

      const after = await getSmoke(h.deps, user, { smokeId });
      expect(after.startedAt).toEqual({ value: lit.toISOString(), source: "photo-drop" });
      expect(after.durationMinutes).toBe(76);

      // Re-claiming is idempotent and COALESCEs, so nothing is restamped.
      h.setNow(new Date("2026-09-02T04:00:00.000Z"));
      await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });
      const again = await getSmoke(h.deps, user, { smokeId });
      expect(again.startedAt).toEqual({ value: lit.toISOString(), source: "photo-drop" });
    });

    it("a late claim leaves a stale session unapplied", async () => {
      h.setNow(new Date("2026-09-01T02:50:00.000Z"));
      const drop = await openPhotoDrop(h.deps, storage, user);
      h.setNow(new Date("2026-09-02T02:20:00.000Z"));
      const smokeId = await newSmoke();

      await claimPhotoDrop(h.deps, user, { photoDropId: drop.photoDropId, smokeId });

      const after = await getSmoke(h.deps, user, { smokeId });
      expect(after.startedAt).toBeNull();
      expect(after.durationMinutes).toBeNull();
    });
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
