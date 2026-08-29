import { createHash, randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { auditLog, cigars, productPhotos, type ProductPhotoRow } from "@cj/db";
import type { PhotoStorage, ProcessedPhoto } from "@cj/photos";
import type { Deps, Principal } from "./deps.js";
import { fingerprint } from "./fingerprint.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { CigarNotFoundError, PhotoNotFoundError, UnauthorizedError } from "./errors.js";
import type { ProductPhotoRights } from "./types.js";

// The product tier of ADR-007: at most one photo per catalog cigar, captured by
// the crawler OR attached by a curator (DESIGN-003 §Images). Unlike smoke photos
// this read is NOT principal-scoped — a product photo belongs to the catalog, not
// a user; the serving route gates on any signed-in user. Storage keys stay
// server-side and are streamed through the authed proxy route, never referenced
// by key from a view.
export interface ProductPhotoObject {
  objectKey: string;
  thumbKey: string;
  contentType: string;
}

// Storage coordinates for one cigar's product photo, or PhotoNotFoundError when
// none serves (the route maps that to a 404). A `suppressed` photo (rights
// takedown, DESIGN-003 §Curation) is treated as absent — never served, even to an
// authed principal — so the serving routes 404 naturally via this read. `pending`
// and `approved` both serve the authed catalog; the public gate (approved-only)
// lands with the public serving path.
export async function getProductPhoto(deps: Deps, args: { cigarId: string }): Promise<ProductPhotoObject> {
  const rows = await deps.db
    .select({
      objectKey: productPhotos.objectKey,
      thumbKey: productPhotos.thumbKey,
      contentType: productPhotos.contentType,
    })
    .from(productPhotos)
    .where(and(eq(productPhotos.cigarId, args.cigarId), ne(productPhotos.rights, "suppressed")))
    .limit(1);
  const photo = rows[0];
  if (!photo) throw new PhotoNotFoundError();
  return photo;
}

// The curator's view of a cigar's product photo: the rights value, or null when
// no row exists (including nothing to un-suppress). Drives the detail-page admin
// control's initial state (Add/Upload-link vs Replace/Suppress vs Approve).
// Curator-only — the same gate as setProductPhotoRights.
export async function getProductPhotoState(
  deps: Deps,
  principal: Principal,
  args: { cigarId: string },
): Promise<{ rights: ProductPhotoRights } | null> {
  assertCurator(principal);
  const rows = await deps.db
    .select({ rights: productPhotos.rights })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, args.cigarId))
    .limit(1);
  return rows[0] ? { rights: rows[0].rights } : null;
}

// --------------------------------------------------------------------------
// attachProductPhoto — a curator uploads a cigar's product photo (DESIGN-003
// §Images wave 5). The one path that fixes the owner's 46 CC cigars with a clean
// rights story: uploader-asserted rights, so the row lands `approved` with a null
// source_url (no vendor listing behind it).
// --------------------------------------------------------------------------

// The image pipeline is injected (not imported) so this module — and the domain
// test harness — never load sharp; the web route wires @cj/photos' processPhoto,
// tests pass a fake (mirrors the crawler's IngestDeps.processPhoto).
export type ProcessProductPhoto = (input: Buffer, contentType: string) => Promise<ProcessedPhoto>;

export interface AttachProductPhotoInput {
  clientRequestId: string;
  cigarId: string;
  image: Buffer;
  contentType: string;
  correlationId?: string;
}

export interface AttachProductPhotoResult {
  cigarId: string;
  rights: "approved";
  // Whether an existing photo was replaced (its row overwritten, its old objects
  // best-effort deleted). False on a first attach.
  replaced: boolean;
  replayed: boolean;
}

function assertCurator(principal: Principal): void {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Product-photo upload is restricted to catalog curators.");
  }
}

// JSON-safe audit snapshot — enough to identify the row and record the transition
// without the raw storage keys.
function photoSnapshot(row: ProductPhotoRow): Record<string, unknown> {
  return { id: row.id, cigarId: row.cigarId, vendorId: row.vendorId, sourceUrl: row.sourceUrl, rights: row.rights };
}

// Objects land in the bucket FIRST, then the row (replacing any prior one via the
// UNIQUE(cigar_id) constraint) + audit commit in one transaction. On a successful
// replace the OLD objects are best-effort deleted; on any commit failure the
// just-uploaded NEW objects are dropped so no orphan is left behind (ADR-007
// failure isolation, mirroring addSmokePhoto / the crawler's capturePhoto). Same
// key shape as the crawler: `product/<cigarId>/<uuid>.jpg` + `.thumb.jpg`.
// Idempotent through the ADR-003 envelope — a replay neither re-decodes nor
// re-uploads (the fingerprint covers the cigar + a digest of the image bytes).
export async function attachProductPhoto(
  deps: Deps,
  storage: PhotoStorage,
  processPhoto: ProcessProductPhoto,
  principal: Principal,
  input: AttachProductPhotoInput,
): Promise<AttachProductPhotoResult> {
  assertCurator(principal);

  const imageDigest = createHash("sha256").update(input.image).digest("hex");
  const requestFingerprint = fingerprint({ cigarId: input.cigarId, imageDigest });

  // Short-circuit a replay BEFORE the pipeline + upload, so a retried request
  // never re-decodes the image or writes a second pair of objects.
  const pre = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
  if (pre) {
    assertReplayable(pre, requestFingerprint);
    return { ...(pre.result as AttachProductPhotoResult), replayed: true };
  }

  const cigarRows = await deps.db
    .select({ id: cigars.id })
    .from(cigars)
    .where(eq(cigars.id, input.cigarId))
    .limit(1);
  if (!cigarRows[0]) throw new CigarNotFoundError();

  // Runs the shared pipeline (decode → EXIF-strip → normalize → thumb). An
  // unsupported type throws here, before any storage write — the route maps it.
  const processed = await processPhoto(input.image, input.contentType);

  const id = randomUUID();
  const objectKey = `product/${input.cigarId}/${id}.jpg`;
  const thumbKey = `product/${input.cigarId}/${id}.thumb.jpg`;

  await storage.put(objectKey, processed.full, processed.contentType);
  await storage.put(thumbKey, processed.thumb, processed.contentType);

  // The replaced photo's objects, captured inside the committed transaction so we
  // only delete them once the row swap is durable (a plain holder, so its value
  // survives the async transaction boundary without closure-narrowing games).
  const replaced: { old: { objectKey: string; thumbKey: string } | null } = { old: null };

  try {
    const result = await deps.db.transaction(async (tx) => {
      const existingKey = await loadIdempotency(tx, principal.userId, input.clientRequestId);
      if (existingKey) {
        assertReplayable(existingKey, requestFingerprint);
        return { ...(existingKey.result as AttachProductPhotoResult), replayed: true };
      }

      const existingRows = await tx
        .select()
        .from(productPhotos)
        .where(eq(productPhotos.cigarId, input.cigarId))
        .limit(1);
      const existing = existingRows[0];
      const before = existing ? photoSnapshot(existing) : null;
      if (existing) {
        replaced.old = { objectKey: existing.objectKey, thumbKey: existing.thumbKey };
        await tx.delete(productPhotos).where(eq(productPhotos.id, existing.id));
      }

      const inserted = await tx
        .insert(productPhotos)
        .values({
          cigarId: input.cigarId,
          vendorId: null,
          sourceUrl: null, // uploader-asserted rights: no vendor listing behind it
          objectKey,
          thumbKey,
          contentType: processed.contentType,
          width: processed.width,
          height: processed.height,
          bytes: processed.full.length,
          rights: "approved",
        })
        .returning();
      const photo = inserted[0]!;

      await tx.insert(auditLog).values({
        userId: principal.userId,
        actor: "web",
        action: "product_photo.attach",
        smokeId: null,
        before,
        after: photoSnapshot(photo),
        correlationId: input.correlationId ?? input.clientRequestId,
      });

      const result: AttachProductPhotoResult = {
        cigarId: input.cigarId,
        rights: "approved",
        replaced: Boolean(existing),
        replayed: false,
      };

      await recordIdempotency(tx, {
        userId: principal.userId,
        clientRequestId: input.clientRequestId,
        tool: "attach_product_photo",
        requestFingerprint,
        smokeId: null,
        result,
      });

      return result;
    });

    if (result.replayed) {
      // A concurrent writer won the key — our freshly-uploaded objects are unused.
      await storage.delete(objectKey).catch(() => {});
      await storage.delete(thumbKey).catch(() => {});
    } else if (replaced.old) {
      // Replace committed — the prior photo's objects are now unreferenced.
      await storage.delete(replaced.old.objectKey).catch(() => {});
      await storage.delete(replaced.old.thumbKey).catch(() => {});
    }
    return result;
  } catch (error) {
    // The new row never committed — drop the orphaned objects we just uploaded.
    await storage.delete(objectKey).catch(() => {});
    await storage.delete(thumbKey).catch(() => {});
    // Concurrent first-writer committed the key between our pre-check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as AttachProductPhotoResult), replayed: true };
      }
    }
    throw error;
  }
}
