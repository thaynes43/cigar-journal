import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  auditLog,
  photoDrops,
  smokePhotos,
  smokes,
  stagedSmokePhotos,
  type PhotoDropRow,
  type SmokePhotoRow,
  type StagedSmokePhotoRow,
} from "@cj/db";
import type { PhotoStorage } from "@cj/photos";
import type { Deps, Principal } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type {
  ClaimPhotoDropResult,
  OpenPhotoDropResult,
  PhotoDropPhotoView,
  PhotoDropStatus,
  PhotoDropView,
  SmokePhotoKind,
} from "./types.js";
import { PhotoLimitError, PhotoNotFoundError, SmokeNotFoundError, UploadTokenInvalidError } from "./errors.js";
import { hashToken } from "./photo-upload-tokens.js";
import { addSmokePhoto, removeSmokePhoto, MAX_PHOTOS_PER_SMOKE, type ProcessedImage, type SmokePhotoObject } from "./smoke-photos.js";
import { smokePhotoSnapshot } from "./mapping.js";
import { isUuid } from "./uuid.js";

// The photo drop (ADR-014): a link bound to the user's smoke IN PROGRESS, opened
// before the smoke exists, that takes every photo of that smoke until it expires.
// `add_smoke_photo` binds to a smokeId and a live smoke is journaled as one
// `save_smoke` at the end, so before this every photo had to be sent twice — once
// when it was taken, once when there was finally something to attach it to.
//
// Two authorization regimes live in this file and must not be confused:
//   * the OWNER services (open, claim, sweep) take a Principal, exactly like the
//     rest of @cj/domain;
//   * the TOKEN services take a raw token and no principal at all. The token IS
//     the authorization (as on `/u/<token>`), so they are never owner-scoped and
//     never an oracle: an unknown or dead LINK is one UploadTokenInvalidError,
//     and a photo the link cannot address is one PhotoNotFoundError — the same
//     answer a wrong id gets.
//
// Storage is passed explicitly per call rather than widened into Deps, the same
// arrangement smoke-photos.ts makes and for the same reason.

// 48 hours from opening. Long enough for a smoke plus the conversation that
// follows it, and it is the whole bound on uploads: the link is multi-use for its
// lifetime because a live smoke produces several photos over hours (ADR-014). The
// 256-bit token carries the security weight, not single use.
export const PHOTO_DROP_TTL_SECONDS = 48 * 3600;

// Seven days from OPENING (not from expiry): how long a dead drop's staged
// photos survive before the sweep takes them and their objects. Measured from
// created_at so the window cannot be extended by re-opening.
export const PHOTO_DROP_RETENTION_SECONDS = 7 * 86_400;

// A drop is bounded the way the smoke it will become is. Same number on purpose:
// staging more than a smoke can hold would only produce a `pending` remainder
// nothing can ever attach.
export const MAX_PHOTOS_PER_DROP = MAX_PHOTOS_PER_SMOKE;

export interface OpenPhotoDropInput {
  correlationId?: string;
  // Which adapter drove the open, for the audit row. Defaults to "web".
  actor?: "web" | "mcp";
}

export interface ClaimPhotoDropInput {
  photoDropId: string;
  smokeId: string;
  correlationId?: string;
  // Widened past the sibling services' "web" | "mcp" because the claim's actor
  // comes off the SAVE's provenance (provenanceToActor), which also yields
  // "import" for the legacy importer.
  actor?: "web" | "mcp" | "import";
}

export interface StagePhotoByTokenInput {
  token: string;
  kind?: SmokePhotoKind;
  image: ProcessedImage;
  correlationId?: string;
}

export interface SetPhotoDropPhotoKindInput {
  token: string;
  photoId: string;
  kind: SmokePhotoKind;
}

export interface RemovePhotoDropPhotoInput {
  token: string;
  photoId: string;
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Owner-authorized
// ---------------------------------------------------------------------------

// Hand the caller a drop link. ONE OPEN DROP PER USER: an unclaimed, unexpired
// drop is returned again with a FRESH token rather than a second drop being
// opened, which is what lets a model that lost the id in a two-hour chat get its
// photos back. Rotation is forced, not chosen — only the hash is stored, so the
// earlier raw token is not re-derivable and re-issuing necessarily kills the old
// link. The expiry is NOT extended: 48 hours run from the opening, not from the
// last mention.
export async function openPhotoDrop(
  deps: Deps,
  storage: PhotoStorage,
  principal: Principal,
  input: OpenPhotoDropInput = {},
): Promise<OpenPhotoDropResult> {
  // Lifecycle without a job (ADR-014): the retention sweep rides the next open.
  // Best-effort and swallowed — a drop the sweep could not clear is a
  // housekeeping problem, and it may not cost the user the link they just asked
  // for.
  await sweepPhotoDrops(deps, storage, { userId: principal.userId }).catch(() => {});

  const now = deps.now();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);

  const open = await deps.db
    .select()
    .from(photoDrops)
    .where(
      and(eq(photoDrops.userId, principal.userId), isNull(photoDrops.claimedAt), gt(photoDrops.expiresAt, now)),
    )
    .orderBy(desc(photoDrops.createdAt))
    .limit(1);
  const existing = open[0];

  if (existing) {
    await deps.db.transaction(async (tx) => {
      await tx.update(photoDrops).set({ tokenHash }).where(eq(photoDrops.id, existing.id));
      await tx.insert(auditLog).values({
        userId: principal.userId,
        ...auditActor(principal, input.actor ?? "web"),
        action: "photo_drop.rotate",
        smokeId: null,
        before: null,
        // Never the hash and never the raw token — only which drop and until when.
        after: { photoDropId: existing.id, expiresAt: existing.expiresAt.toISOString() },
        correlationId: input.correlationId ?? null,
      });
    });

    const staged = await deps.db
      .select({ value: count() })
      .from(stagedSmokePhotos)
      .where(eq(stagedSmokePhotos.dropId, existing.id));

    return {
      photoDropId: existing.id,
      token,
      expiresAt: existing.expiresAt.toISOString(),
      reused: true,
      photoCount: Number(staged[0]?.value ?? 0),
    };
  }

  const expiresAt = new Date(now.getTime() + PHOTO_DROP_TTL_SECONDS * 1000);
  const photoDropId = await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(photoDrops)
      .values({ userId: principal.userId, tokenHash, expiresAt })
      .returning();
    const row = inserted[0]!;
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, input.actor ?? "web"),
      action: "photo_drop.open",
      smokeId: null,
      before: null,
      after: { photoDropId: row.id, expiresAt: expiresAt.toISOString() },
      correlationId: input.correlationId ?? null,
    });
    return row.id;
  });

  return { photoDropId, token, expiresAt: expiresAt.toISOString(), reused: false, photoCount: 0 };
}

// Bind a drop to the smoke that has just been saved and move its staged photos
// onto it. Runs AFTER the save committed, in its own transaction, and is
// idempotent: re-claiming the same smoke moves whatever is staged (usually
// nothing) and reports `claimed` again, so a retried save is safe.
//
// The two "wrong id" cases are answered differently ON PURPOSE. A wrong DROP id
// is reported, because the save that carries it has already committed and a photo
// problem may not fail it (ADR-007); a wrong SMOKE id is a caller error — the
// save passes the smoke it just wrote, so only a hand-written call can get it
// wrong — and throws, exactly as the sibling photo services do.
export async function claimPhotoDrop(
  deps: Deps,
  principal: Principal,
  input: ClaimPhotoDropInput,
): Promise<ClaimPhotoDropResult> {
  const notFound: ClaimPhotoDropResult = {
    photoDropId: input.photoDropId,
    status: "not_found",
    attached: 0,
    pending: 0,
  };
  // A malformed id names nothing, which is what another user's drop also
  // "names" here — one answer for both, and ahead of the query it would 22P02
  // (./uuid.ts).
  if (!isUuid(input.photoDropId)) return notFound;

  const dropRows = await deps.db.select().from(photoDrops).where(eq(photoDrops.id, input.photoDropId)).limit(1);
  const drop = dropRows[0];
  if (!drop || drop.userId !== principal.userId) return notFound;

  if (!isUuid(input.smokeId)) throw new SmokeNotFoundError();
  const smokeRows = await deps.db.select().from(smokes).where(eq(smokes.id, input.smokeId)).limit(1);
  const smoke = smokeRows[0];
  if (!smoke || smoke.userId !== principal.userId) throw new SmokeNotFoundError();

  // Already this drop's smoke? That is the idempotent re-claim, and it falls
  // through. A DIFFERENT smoke is not: moving the photos would take them off the
  // smoke that already owns them.
  if (drop.smokeId !== null && drop.smokeId !== input.smokeId) {
    return { photoDropId: drop.id, status: "bound_elsewhere", attached: 0, pending: 0 };
  }

  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const staged = await tx
      .select()
      .from(stagedSmokePhotos)
      .where(eq(stagedSmokePhotos.dropId, drop.id))
      .orderBy(asc(stagedSmokePhotos.createdAt));
    const held = await tx
      .select({ value: count() })
      .from(smokePhotos)
      .where(eq(smokePhotos.smokeId, input.smokeId));
    // The smoke's cap is the binding one — the drop may hold photos an already
    // photographed smoke has no room for. The remainder stays STAGED rather than
    // being dropped: the link still shows it, and removing a photo and re-claiming
    // brings it over.
    const room = Math.max(0, MAX_PHOTOS_PER_SMOKE - Number(held[0]?.value ?? 0));
    const moving = staged.slice(0, room);

    for (const photo of moving) {
      // A MOVE, not a copy: same id (a link already showing the photo keeps
      // working), same object keys (nothing is rewritten in the bucket), same
      // created_at (the smoke's photos stay in the order they were taken).
      const inserted = await tx
        .insert(smokePhotos)
        .values({
          id: photo.id,
          smokeId: input.smokeId,
          userId: photo.userId,
          kind: photo.kind,
          caption: photo.caption,
          objectKey: photo.objectKey,
          thumbKey: photo.thumbKey,
          contentType: photo.contentType,
          width: photo.width,
          height: photo.height,
          bytes: photo.bytes,
          createdAt: photo.createdAt,
        })
        .returning();
      await tx.delete(stagedSmokePhotos).where(eq(stagedSmokePhotos.id, photo.id));

      // The same audit row an ordinary add writes, so a photo's history reads the
      // same however it arrived; `via` is the only thing that says it came through
      // a drop.
      await tx.insert(auditLog).values({
        userId: drop.userId,
        ...auditActor(principal, input.actor ?? "web"),
        action: "smoke_photo.add",
        smokeId: input.smokeId,
        before: null,
        after: { ...smokePhotoSnapshot(inserted[0]!), via: "photo_drop" },
        correlationId: input.correlationId ?? null,
      });
    }

    await tx
      .update(photoDrops)
      .set({
        smokeId: input.smokeId,
        // COALESCE, not an overwrite: a re-claim must not restamp when the drop
        // was first claimed.
        claimedAt: sql`coalesce(${photoDrops.claimedAt}, ${now})`,
      })
      .where(eq(photoDrops.id, drop.id));

    const pending = staged.length - moving.length;
    await tx.insert(auditLog).values({
      userId: drop.userId,
      ...auditActor(principal, input.actor ?? "web"),
      action: "photo_drop.claim",
      smokeId: input.smokeId,
      before: null,
      after: { photoDropId: drop.id, smokeId: input.smokeId, attached: moving.length, pending },
      correlationId: input.correlationId ?? null,
    });

    return { photoDropId: drop.id, status: "claimed" as const, attached: moving.length, pending };
  });
}

// Lifecycle without a job (ADR-014): drops this user has finished with, taken
// lazily on their next open. Two things qualify — anything past the retention
// window from its OPENING, and a drop closed by the deletion of the smoke it was
// claimed by (`smoke_id` back to null via the FK) once its link has expired.
export async function sweepPhotoDrops(
  deps: Deps,
  storage: PhotoStorage,
  args: { userId: string },
): Promise<{ drops: number; photos: number }> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - PHOTO_DROP_RETENTION_SECONDS * 1000);

  const doomed = await deps.db
    .select({ id: photoDrops.id })
    .from(photoDrops)
    .where(
      and(
        eq(photoDrops.userId, args.userId),
        or(
          lt(photoDrops.createdAt, cutoff),
          and(isNotNull(photoDrops.claimedAt), isNull(photoDrops.smokeId), lt(photoDrops.expiresAt, now)),
        ),
      ),
    );
  if (doomed.length === 0) return { drops: 0, photos: 0 };

  const ids = doomed.map((d) => d.id);
  const staged = await deps.db.select().from(stagedSmokePhotos).where(inArray(stagedSmokePhotos.dropId, ids));

  // Objects BEFORE rows, the opposite ordering from removeSmokePhoto and for the
  // reason that inverts it: nothing here is being kept, and the row is the only
  // record of where the bytes are — dropping it first would strand them in the
  // bucket forever, while a failed delete just leaves an object the next sweep
  // over the same rows tries again.
  for (const photo of staged) {
    await storage.delete(photo.objectKey).catch(() => {});
    await storage.delete(photo.thumbKey).catch(() => {});
  }
  // Claimed photos are NOT touched: they live on smoke_photos now, with the smoke.
  await deps.db.delete(photoDrops).where(inArray(photoDrops.id, ids)); // cascades staged rows

  return { drops: ids.length, photos: staged.length };
}

// ---------------------------------------------------------------------------
// Token-authorized (anonymous)
// ---------------------------------------------------------------------------

// What the drop's own page reads. Which photos it shows follows the status: an
// open drop shows what is staged, an attached one shows the smoke's photos
// (oldest first) followed by any remainder the cap left staged, and a closed one
// shows nothing at all — the link is over.
export async function getPhotoDropByToken(deps: Deps, args: { token: string }): Promise<PhotoDropView> {
  const drop = await loadDropByToken(deps, args.token);
  const status = dropStatus(drop, deps.now());
  return {
    photoDropId: drop.id,
    status,
    expiresAt: drop.expiresAt.toISOString(),
    smokeId: drop.smokeId,
    photos: status === "closed" ? [] : await dropPhotos(deps, drop, status),
  };
}

// Is this link still usable? The pre-decode check the upload route runs so a dead
// link is rejected BEFORE the endpoint spends CPU on an image — the same job
// assertPhotoUploadTokenUsable does for the single-use links, and the same absence
// of an oracle: unknown, expired and closed-by-deletion are one error. It grants
// nothing; the stage that follows re-reads the drop.
export async function assertPhotoDropUsable(deps: Deps, args: { token: string }): Promise<void> {
  const drop = await loadDropByToken(deps, args.token);
  if (dropStatus(drop, deps.now()) === "closed") throw new UploadTokenInvalidError();
}

// Put a photo into the drop. Before the claim it is staged; after it, the same
// link keeps working and the photo goes straight onto the smoke (ADR-014) — which
// is the whole point of the drop surviving its claim.
export async function stagePhotoByToken(
  deps: Deps,
  storage: PhotoStorage,
  input: StagePhotoByTokenInput,
): Promise<PhotoDropPhotoView> {
  const drop = await loadDropByToken(deps, input.token);
  const status = dropStatus(drop, deps.now());
  if (status === "closed") throw new UploadTokenInvalidError();

  if (status === "attached") {
    // Delegated rather than reimplemented: the cap, the ordering of bucket writes
    // and the audit row are addSmokePhoto's, and this path must not fork them.
    // The principal is the DROP'S OWNER — the uploader is anonymous, the token is
    // the authorization — and the actor is "web" because a token upload IS a web
    // upload, whichever surface handed the link over.
    const view = await addSmokePhoto(
      deps,
      storage,
      { userId: drop.userId, role: "user" },
      { smokeId: drop.smokeId!, kind: input.kind, image: input.image, actor: "web", correlationId: input.correlationId },
    );
    return {
      photoId: view.photoId,
      kind: view.kind,
      caption: view.caption,
      width: view.width,
      height: view.height,
      createdAt: view.createdAt,
      attached: true,
    };
  }

  const existing = await deps.db
    .select({ value: count() })
    .from(stagedSmokePhotos)
    .where(eq(stagedSmokePhotos.dropId, drop.id));
  if (Number(existing[0]?.value ?? 0) >= MAX_PHOTOS_PER_DROP) throw new PhotoLimitError(MAX_PHOTOS_PER_DROP);

  // Keyed by the drop, not the smoke — there is no smoke yet — and the key is what
  // the claim carries across unchanged. Same uuid backs both objects.
  const id = randomUUID();
  const objectKey = `drop/${drop.id}/${id}.jpg`;
  const thumbKey = `drop/${drop.id}/${id}.thumb.jpg`;

  await storage.put(objectKey, input.image.full, input.image.contentType);
  await storage.put(thumbKey, input.image.thumb, input.image.contentType);

  try {
    return await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(stagedSmokePhotos)
        .values({
          dropId: drop.id,
          userId: drop.userId,
          kind: input.kind ?? "other",
          objectKey,
          thumbKey,
          contentType: input.image.contentType,
          width: input.image.width,
          height: input.image.height,
          bytes: input.image.bytes,
        })
        .returning();
      const photo = inserted[0]!;

      // Attributed to the drop's owner, with no client: the writer is an anonymous
      // token holder, so there is no principal and no credential to name.
      await tx.insert(auditLog).values({
        userId: drop.userId,
        ...auditActor(undefined, "web"),
        action: "staged_photo.add",
        smokeId: null,
        before: null,
        after: stagedPhotoSnapshot(photo),
        correlationId: input.correlationId ?? null,
      });

      return toStagedView(photo);
    });
  } catch (error) {
    // The row never committed — drop the orphaned objects (addSmokePhoto's rule).
    await storage.delete(objectKey).catch(() => {});
    await storage.delete(thumbKey).catch(() => {});
    throw error;
  }
}

// Reclassify one of the drop's photos, staged or already on the smoke. The update
// and its audit row go in ONE transaction, as every other mutation on these two
// tables does (#267): the writer being an anonymous token holder is a reason to
// record the change, not to skip it. Re-selecting the kind already stored still
// returns the view but writes nothing — a row whose before equals its after says
// nothing about the photo. Both rows are attributed to the drop's OWNER with no
// client, exactly as stagePhotoByToken attributes its own writes: the token is
// the authorization, so there is no principal and no credential to name.
export async function setPhotoDropPhotoKind(
  deps: Deps,
  args: SetPhotoDropPhotoKindInput,
): Promise<PhotoDropPhotoView> {
  const drop = await loadDropByToken(deps, args.token);
  const ref = await resolveDropPhoto(deps, drop, args.photoId);
  const before = ref.row.kind;

  if (ref.where === "staged") {
    if (before === args.kind) return toStagedView(ref.row);
    return deps.db.transaction(async (tx) => {
      const updated = await tx
        .update(stagedSmokePhotos)
        .set({ kind: args.kind })
        .where(eq(stagedSmokePhotos.id, ref.row.id))
        .returning();
      await tx.insert(auditLog).values({
        userId: drop.userId,
        ...auditActor(undefined, "web"),
        action: "staged_photo.kind",
        // Nothing to point at: a staged photo is bound to the drop, not a smoke.
        smokeId: null,
        before: { photoId: ref.row.id, kind: before },
        after: { photoId: ref.row.id, kind: args.kind },
        correlationId: null,
      });
      return toStagedView(updated[0]!);
    });
  }

  if (before === args.kind) return toAttachedView(ref.row);
  return deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(smokePhotos)
      .set({ kind: args.kind })
      .where(eq(smokePhotos.id, ref.row.id))
      .returning();
    await tx.insert(auditLog).values({
      userId: drop.userId,
      ...auditActor(undefined, "web"),
      action: "smoke_photo.kind",
      smokeId: ref.row.smokeId,
      before: { photoId: ref.row.id, kind: before },
      after: { photoId: ref.row.id, kind: args.kind },
      correlationId: null,
    });
    return toAttachedView(updated[0]!);
  });
}

// Take one photo back out of the drop — the remedy the ADR relies on when two
// simultaneous smokes by one user share a drop.
export async function removePhotoDropPhoto(
  deps: Deps,
  storage: PhotoStorage,
  args: RemovePhotoDropPhotoInput,
): Promise<{ photoId: string }> {
  const drop = await loadDropByToken(deps, args.token);
  const ref = await resolveDropPhoto(deps, drop, args.photoId);

  if (ref.where === "attached") {
    return removeSmokePhoto(
      deps,
      storage,
      { userId: drop.userId, role: "user" },
      { photoId: ref.row.id, correlationId: args.correlationId },
    );
  }

  // Row + tombstone in one transaction, objects after — removeSmokePhoto's
  // ordering, and for its reason: the DB is the source of truth and a leaked
  // object is harmless.
  await deps.db.transaction(async (tx) => {
    await tx.delete(stagedSmokePhotos).where(eq(stagedSmokePhotos.id, ref.row.id));
    await tx.insert(auditLog).values({
      userId: drop.userId,
      ...auditActor(undefined, "web"),
      action: "staged_photo.remove",
      smokeId: null,
      before: stagedPhotoSnapshot(ref.row),
      after: null,
      correlationId: args.correlationId ?? null,
    });
  });

  await storage.delete(ref.row.objectKey).catch(() => {});
  await storage.delete(ref.row.thumbKey).catch(() => {});

  return { photoId: ref.row.id };
}

// The storage coordinates of one of the drop's photos, for the token-authorized
// image route — the anonymous counterpart to getSmokePhoto.
export async function getPhotoDropPhotoObject(
  deps: Deps,
  args: { token: string; photoId: string },
): Promise<SmokePhotoObject> {
  const drop = await loadDropByToken(deps, args.token);
  const ref = await resolveDropPhoto(deps, drop, args.photoId);
  return { objectKey: ref.row.objectKey, thumbKey: ref.row.thumbKey, contentType: ref.row.contentType };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// A dead drop still RESOLVES — `closed` is a state its page reports, not an
// error — so only an unknown token is invalid here.
async function loadDropByToken(deps: Deps, token: string): Promise<PhotoDropRow> {
  const rows = await deps.db
    .select()
    .from(photoDrops)
    .where(eq(photoDrops.tokenHash, hashToken(token)))
    .limit(1);
  const drop = rows[0];
  if (!drop) throw new UploadTokenInvalidError();
  return drop;
}

function dropStatus(drop: PhotoDropRow, now: Date): PhotoDropStatus {
  const expired = drop.expiresAt.getTime() <= now.getTime();
  if (drop.claimedAt === null) return expired ? "closed" : "open";
  // Claimed with no smoke: the smoke was deleted and the FK nulled the link
  // (migration 0033). That closes the drop rather than reopening it — the photos
  // it carried went with the smoke.
  if (drop.smokeId === null) return "closed";
  return expired ? "closed" : "attached";
}

type DropPhotoRef =
  | { where: "staged"; row: StagedSmokePhotoRow }
  | { where: "attached"; row: SmokePhotoRow };

// The photos this token can address. A closed drop addresses none — which is
// exactly what its page shows — so every photo-level service answers
// PhotoNotFoundError there, indistinguishable from an unknown id. Only the LINK
// itself reports UploadTokenInvalidError, and only where the link is what the
// caller is using (staging, and the pre-decode check).
async function resolveDropPhoto(deps: Deps, drop: PhotoDropRow, photoId: string): Promise<DropPhotoRef> {
  // The id comes off an anonymous URL, so any string can arrive (./uuid.ts).
  if (!isUuid(photoId)) throw new PhotoNotFoundError();
  const status = dropStatus(drop, deps.now());
  if (status === "closed") throw new PhotoNotFoundError();

  const staged = await deps.db
    .select()
    .from(stagedSmokePhotos)
    .where(and(eq(stagedSmokePhotos.id, photoId), eq(stagedSmokePhotos.dropId, drop.id)))
    .limit(1);
  if (staged[0]) return { where: "staged", row: staged[0] };

  if (status === "attached" && drop.smokeId !== null) {
    const attached = await deps.db
      .select()
      .from(smokePhotos)
      .where(
        and(
          eq(smokePhotos.id, photoId),
          eq(smokePhotos.smokeId, drop.smokeId),
          eq(smokePhotos.userId, drop.userId),
        ),
      )
      .limit(1);
    if (attached[0]) return { where: "attached", row: attached[0] };
  }
  throw new PhotoNotFoundError();
}

async function dropPhotos(deps: Deps, drop: PhotoDropRow, status: PhotoDropStatus): Promise<PhotoDropPhotoView[]> {
  const views: PhotoDropPhotoView[] = [];
  if (status === "attached" && drop.smokeId !== null) {
    const attached = await deps.db
      .select()
      .from(smokePhotos)
      .where(and(eq(smokePhotos.smokeId, drop.smokeId), eq(smokePhotos.userId, drop.userId)))
      .orderBy(asc(smokePhotos.createdAt));
    views.push(...attached.map(toAttachedView));
  }
  const staged = await deps.db
    .select()
    .from(stagedSmokePhotos)
    .where(eq(stagedSmokePhotos.dropId, drop.id))
    .orderBy(asc(stagedSmokePhotos.createdAt));
  views.push(...staged.map(toStagedView));
  return views;
}

function toStagedView(row: StagedSmokePhotoRow): PhotoDropPhotoView {
  return {
    photoId: row.id,
    kind: row.kind,
    caption: row.caption,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
    attached: false,
  };
}

function toAttachedView(row: SmokePhotoRow): PhotoDropPhotoView {
  return {
    photoId: row.id,
    kind: row.kind,
    caption: row.caption,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
    attached: true,
  };
}

// The staged counterpart of smokePhotoSnapshot — the full row, storage keys
// included, so a sweep or a removal can be reconstructed from the audit trail.
function stagedPhotoSnapshot(row: StagedSmokePhotoRow): Record<string, unknown> {
  return {
    id: row.id,
    dropId: row.dropId,
    userId: row.userId,
    kind: row.kind,
    caption: row.caption,
    objectKey: row.objectKey,
    thumbKey: row.thumbKey,
    contentType: row.contentType,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    createdAt: row.createdAt.toISOString(),
  };
}
