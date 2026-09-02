import { db } from "@cj/db";
import { removePhotoDropPhoto, setPhotoDropPhotoKind, type Deps } from "@cj/domain";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse, uploadErrorResponse } from "@/lib/photo-http";
import { isSmokePhotoKind } from "@/lib/photo-kinds";

// One photo inside a drop (ADR-014): reclassify it, or take it back out. Both are
// anonymous and token-authorized like the rest of `/api/photo-drops` — the token
// names the drop, and the drop is the only place these ids resolve, so a photo
// this link cannot address is a 404 whether it exists elsewhere or not at all.
//
// The page calls PATCH on a chip tap and DELETE on Remove, both immediately: a
// photo just added is not worth a form or a confirmation.
export const dynamic = "force-dynamic";

function deps(): Deps {
  return { db, now: () => new Date() };
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ token: string; id: string }> },
): Promise<Response> {
  // No storage is touched here, but the whole feature is off without it and one
  // answer for that is better than a route that half works.
  if (!photoStorage) return uploadErrorResponse("unavailable", 503);
  const { token, id } = await ctx.params;

  const body = (await req.json().catch(() => null)) as { kind?: unknown } | null;
  if (!isSmokePhotoKind(body?.kind)) return uploadErrorResponse("validation_error", 400);

  try {
    return Response.json(
      await setPhotoDropPhotoKind(deps(), { token, photoId: id, kind: body.kind }),
    );
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
