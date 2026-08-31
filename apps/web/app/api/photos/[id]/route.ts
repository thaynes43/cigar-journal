import { removeSmokePhoto } from "@cj/domain";
import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse, smokePhotoHeaders, PHOTO_VARY } from "@/lib/photo-http";
import { resolveViewablePhoto } from "@/lib/serve-smoke-photo";

// Serve and delete one smoke photo (ADR-007). The bucket is private; access is
// authorized here, not by key secrecy. GET serves the owner's own photo and any
// photo on a public journal (issue #96); DELETE stays owner-only. Full-size object.
//
// Caching is stated once in lib/photo-http.ts and shared with the thumb route:
// the owner variant is immutable and private, the public variant is a revocable
// grant on a short leash, and `Vary: Cookie` rides on every response here.
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
    const object = await photoStorage.get(photo.objectKey);
    return new Response(object.body as BodyInit, {
      headers: smokePhotoHeaders(photo.contentType, isPublic),
    });
  } catch (error) {
    return domainErrorResponse(error, PHOTO_VARY);
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!principal)
    return Response.json({ error: "Not authenticated." }, { status: 401, headers: PHOTO_VARY });
  if (!photoStorage)
    return Response.json({ error: "Photos are not enabled." }, { status: 503, headers: PHOTO_VARY });
  const { id } = await ctx.params;

  try {
    await removeSmokePhoto(deps, photoStorage, principal, { photoId: id });
    return new Response(null, { status: 204, headers: PHOTO_VARY });
  } catch (error) {
    return domainErrorResponse(error, PHOTO_VARY);
  }
}
