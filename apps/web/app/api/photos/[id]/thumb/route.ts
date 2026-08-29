import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";
import { resolveViewablePhoto } from "@/lib/serve-smoke-photo";

// Serve one smoke photo's thumbnail (ADR-007). Same authorization path as the
// full-size route: the owner's own photo and any photo on a public journal
// (issue #96). Owner bytes private-cached; public journal bytes publicly cacheable.
export const dynamic = "force-dynamic";

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
    const object = await photoStorage.get(photo.thumbKey);
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
