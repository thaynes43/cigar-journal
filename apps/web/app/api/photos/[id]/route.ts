import { removeSmokePhoto } from "@cj/domain";
import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";
import { resolveViewablePhoto } from "@/lib/serve-smoke-photo";

// Serve and delete one smoke photo (ADR-007). The bucket is private; access is
// authorized here, not by key secrecy. GET serves the owner's own photo and any
// photo on a public journal (issue #96); DELETE stays owner-only. Full-size object.
export const dynamic = "force-dynamic";

// Object keys are content-addressed and immutable, so cache hard. Owner bytes stay
// private; a public journal's bytes are publicly cacheable.
const PRIVATE_CACHE = "private, max-age=31536000, immutable";
const PUBLIC_CACHE = "public, max-age=31536000, immutable";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });
  const { id } = await ctx.params;

  try {
    const { photo, isPublic } = await resolveViewablePhoto(deps, principal, id);
    const object = await photoStorage.get(photo.objectKey);
    return new Response(object.body as BodyInit, {
      headers: {
        "Content-Type": photo.contentType,
        "Cache-Control": isPublic ? PUBLIC_CACHE : PRIVATE_CACHE,
      },
    });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!principal) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });
  const { id } = await ctx.params;

  try {
    await removeSmokePhoto(deps, photoStorage, principal, { photoId: id });
    return new Response(null, { status: 204 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
