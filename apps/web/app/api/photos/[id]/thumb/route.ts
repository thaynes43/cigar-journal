import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse, smokePhotoHeaders, PHOTO_VARY } from "@/lib/photo-http";
import { resolveViewablePhoto } from "@/lib/serve-smoke-photo";

// Serve one smoke photo's thumbnail (ADR-007). Same authorization path as the
// full-size route: the owner's own photo and any photo on a public journal
// (issue #96), and the same shared cache policy — owner bytes private and
// immutable, public bytes revocable on a short leash, `Vary: Cookie` throughout.
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!photoStorage)
    return Response.json({ error: "Photos are not enabled." }, { status: 503, headers: PHOTO_VARY });
  const { id } = await ctx.params;

  try {
    const { photo, isPublic } = await resolveViewablePhoto(deps, principal, id);
    const object = await photoStorage.get(photo.thumbKey);
    return new Response(object.body as BodyInit, {
      headers: smokePhotoHeaders(photo.contentType, isPublic),
    });
  } catch (error) {
    return domainErrorResponse(error, PHOTO_VARY);
  }
}
