import { db } from "@cj/db";
import {
  removePhotoDropPhoto,
  updatePhotoDropPhoto,
  MAX_PHOTO_CAPTION_LENGTH,
  type Deps,
  type SmokePhotoKind,
} from "@cj/domain";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse, uploadErrorResponse } from "@/lib/photo-http";
import { isSmokePhotoKind } from "@/lib/photo-kinds";

// One photo inside a drop (ADR-014): say what it shows, caption it, or take it
// back out. All three are anonymous and token-authorized like the rest of
// `/api/photo-drops` — the token names the drop, and the drop is the only place
// these ids resolve, so a photo this link cannot address is a 404 whether it
// exists elsewhere or not at all.
//
// The page calls PATCH on a chip tap and on a caption blur, and DELETE on Remove,
// all immediately: a photo just added is not worth a form or a confirmation.
export const dynamic = "force-dynamic";

function deps(): Deps {
  return { db, now: () => new Date() };
}

// The PATCH body, checked rather than trusted — it arrives on an anonymous
// request and both fields land in `text` columns. Either field may be sent
// alone; ABSENT means "leave it alone" and a `null`/blank caption is the erase.
// A body naming neither is rejected, not treated as a no-op: it is a client bug,
// and answering 200 would hide it.
type PatchBody = { kind?: SmokePhotoKind; caption?: string | null };

function parsePatch(body: unknown): PatchBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = body as { kind?: unknown; caption?: unknown };
  const patch: PatchBody = {};

  if (raw.kind !== undefined) {
    if (!isSmokePhotoKind(raw.kind)) return null;
    patch.kind = raw.kind;
  }
  if (raw.caption !== undefined) {
    if (raw.caption === null) patch.caption = null;
    else if (typeof raw.caption === "string" && raw.caption.length <= MAX_PHOTO_CAPTION_LENGTH)
      patch.caption = raw.caption;
    else return null;
  }

  return patch.kind === undefined && patch.caption === undefined ? null : patch;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ token: string; id: string }> },
): Promise<Response> {
  // No storage is touched here, but the whole feature is off without it and one
  // answer for that is better than a route that half works.
  if (!photoStorage) return uploadErrorResponse("unavailable", 503);
  const { token, id } = await ctx.params;

  const patch = parsePatch(await req.json().catch(() => null));
  if (!patch) return uploadErrorResponse("validation_error", 400);

  try {
    return Response.json(await updatePhotoDropPhoto(deps(), { token, photoId: id, ...patch }));
  } catch (error) {
    return domainErrorResponse(error);
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ token: string; id: string }> },
): Promise<Response> {
  if (!photoStorage) return uploadErrorResponse("unavailable", 503);
  const { token, id } = await ctx.params;

  try {
    await removePhotoDropPhoto(deps(), photoStorage, { token, photoId: id });
    return new Response(null, { status: 204 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
