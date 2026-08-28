import { getSmokePhoto } from "@cj/domain";
import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";

// Serve one smoke photo's thumbnail (ADR-007). Owner-only, private-cached, same
// authorization path as the full-size route.
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=31536000, immutable";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!principal) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });
  const { id } = await ctx.params;

  try {
    const photo = await getSmokePhoto(deps, principal, { photoId: id });
    const object = await photoStorage.get(photo.thumbKey);
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": photo.contentType, "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
