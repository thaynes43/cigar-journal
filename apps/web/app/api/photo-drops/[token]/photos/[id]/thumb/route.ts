import { db } from "@cj/db";
import { getPhotoDropPhotoObject, type Deps } from "@cj/domain";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse, uploadErrorResponse, PHOTO_DROP_CACHE } from "@/lib/photo-http";

// The thumbnails the drop page renders (ADR-014). The bucket is private and the
// token is the authorization, so this is the only way those bytes are reachable
// — and the reason they are served `private, no-store`: the credential is in the
// URL, so no shared cache may keep a copy that outlives the link.
//
// Thumbnails only. The full-size object has no reader on this page and would be
// a second anonymous surface for no gain.
export const dynamic = "force-dynamic";

function deps(): Deps {
  return { db, now: () => new Date() };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string; id: string }> },
): Promise<Response> {
  if (!photoStorage) return uploadErrorResponse("unavailable", 503);
  const { token, id } = await ctx.params;

  try {
    const photo = await getPhotoDropPhotoObject(deps(), { token, photoId: id });
    const object = await photoStorage.get(photo.thumbKey);
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": photo.contentType, "Cache-Control": PHOTO_DROP_CACHE },
    });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
