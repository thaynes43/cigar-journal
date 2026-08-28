import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { auditLog, smokePhotos, smokes } from "@cj/db";
import type { PhotoStorage } from "@cj/photos";
import type { Deps, Principal } from "./deps.js";
import type { SmokePhotoKind, SmokePhotoView } from "./types.js";
import { SmokeNotFoundError, PhotoNotFoundError, PhotoLimitError } from "./errors.js";
import { toSmokePhotoView, smokePhotoSnapshot } from "./mapping.js";

// Review-bound smoke photos (ADR-007, issue #44 part 1). @cj/domain owns
// ownership, the photo cap, and the audit trail; the image pipeline and the
// object store live in @cj/photos. Storage is passed explicitly per call rather
// than widening the shared Deps — only the photo services need it, and the type
// is the sole thing this module borrows from @cj/photos.

export const MAX_PHOTOS_PER_SMOKE = 12;

// The pipeline output plus its stored byte size, as the adapter hands it over.
export interface ProcessedImage {
  full: Buffer;
  thumb: Buffer;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
}

export interface AddSmokePhotoInput {
  smokeId: string;
  kind?: SmokePhotoKind;
  caption?: string | null;
  image: ProcessedImage;
  // Which adapter drove the add, for the audit row. Defaults to "web" — the web
  // upload route (and the token-backed upload page, which IS a web upload) leave
  // it unset; the MCP add_smoke_photo tool passes "mcp".
  actor?: "web" | "mcp";
  correlationId?: string;
}

export interface RemoveSmokePhotoInput {
  photoId: string;
  correlationId?: string;
}

// The storage-facing coordinates of one photo, for the authed serving route.
export interface SmokePhotoObject {
  objectKey: string;
  thumbKey: string;
  contentType: string;
}

// Attach a processed photo to one of the caller's smokes. Objects land in the
// bucket FIRST, then the row + audit row commit in one transaction; if that
// commit fails, the just-uploaded objects are best-effort deleted so no orphan
// is left behind (ADR-007 failure isolation).
export async function addSmokePhoto(
  deps: Deps,
  storage: PhotoStorage,
  principal: Principal,
  input: AddSmokePhotoInput,
): Promise<SmokePhotoView> {
  const rows = await deps.db.select().from(smokes).where(eq(smokes.id, input.smokeId)).limit(1);
  const smoke = rows[0];
  // Cross-user access is reported as not-found so a smoke never leaks (as in
  // getSmoke/deleteSmoke).
  if (!smoke || smoke.userId !== principal.userId) throw new SmokeNotFoundError();

  const existing = await deps.db
    .select({ value: count() })
    .from(smokePhotos)
    .where(eq(smokePhotos.smokeId, input.smokeId));
  if (Number(existing[0]?.value ?? 0) >= MAX_PHOTOS_PER_SMOKE) {
    throw new PhotoLimitError(MAX_PHOTOS_PER_SMOKE);
  }

  // Same uuid for both objects; unguessable keys, authorization at the route.
  const id = randomUUID();
  const objectKey = `smoke/${input.smokeId}/${id}.jpg`;
  const thumbKey = `smoke/${input.smokeId}/${id}.thumb.jpg`;

  await storage.put(objectKey, input.image.full, input.image.contentType);
  await storage.put(thumbKey, input.image.thumb, input.image.contentType);

  try {
    return await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(smokePhotos)
        .values({
          smokeId: input.smokeId,
          userId: principal.userId,
          kind: input.kind ?? "other",
          caption: input.caption ?? null,
          objectKey,
          thumbKey,
          contentType: input.image.contentType,
          width: input.image.width,
          height: input.image.height,
          bytes: input.image.bytes,
        })
        .returning();
      const photo = inserted[0]!;

      await tx.insert(auditLog).values({
        userId: principal.userId,
        actor: input.actor ?? "web",
        action: "smoke_photo.add",
        smokeId: input.smokeId,
        before: null,
        after: smokePhotoSnapshot(photo),
        correlationId: input.correlationId ?? null,
      });

      return toSmokePhotoView(photo);
    });
  } catch (error) {
    // The row never committed — drop the orphaned objects.
    await storage.delete(objectKey).catch(() => {});
    await storage.delete(thumbKey).catch(() => {});
    throw error;
  }
}

// The caller's photos for one smoke, oldest first. Owner-scoped by the photo's
// own user_id, so a non-owner simply gets nothing.
export async function listSmokePhotos(
  deps: Deps,
  principal: Principal,
  args: { smokeId: string },
): Promise<SmokePhotoView[]> {
  const rows = await deps.db
    .select()
    .from(smokePhotos)
    .where(and(eq(smokePhotos.smokeId, args.smokeId), eq(smokePhotos.userId, principal.userId)))
    .orderBy(smokePhotos.createdAt);
  return rows.map(toSmokePhotoView);
}

// The storage coordinates of one owned photo, for the authed serving route.
export async function getSmokePhoto(
  deps: Deps,
  principal: Principal,
  args: { photoId: string },
): Promise<SmokePhotoObject> {
  const rows = await deps.db
    .select()
    .from(smokePhotos)
    .where(eq(smokePhotos.id, args.photoId))
    .limit(1);
  const photo = rows[0];
  if (!photo || photo.userId !== principal.userId) throw new PhotoNotFoundError();
  return { objectKey: photo.objectKey, thumbKey: photo.thumbKey, contentType: photo.contentType };
}

// Detach one of the caller's photos. The row + audit tombstone go in one
// transaction (the DB is the source of truth); the objects are best-effort
// deleted after — a leaked object is harmless and swept later.
export async function removeSmokePhoto(
  deps: Deps,
  storage: PhotoStorage,
  principal: Principal,
  input: RemoveSmokePhotoInput,
): Promise<{ photoId: string }> {
  const rows = await deps.db
    .select()
    .from(smokePhotos)
    .where(eq(smokePhotos.id, input.photoId))
    .limit(1);
  const photo = rows[0];
  if (!photo || photo.userId !== principal.userId) throw new PhotoNotFoundError();

  await deps.db.transaction(async (tx) => {
    await tx.delete(smokePhotos).where(eq(smokePhotos.id, photo.id));
    await tx.insert(auditLog).values({
      userId: principal.userId,
      actor: "web",
      action: "smoke_photo.remove",
      smokeId: photo.smokeId,
      before: smokePhotoSnapshot(photo),
      after: null,
      correlationId: input.correlationId ?? null,
    });
  });

  await storage.delete(photo.objectKey).catch(() => {});
  await storage.delete(photo.thumbKey).catch(() => {});

  return { photoId: photo.id };
}
