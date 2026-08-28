import { getProductPhoto } from "@cj/domain";
import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";

// Serve one cigar's product-photo thumbnail (ADR-007). Same catalog-scoped
// authorization as the full-size route; drives catalog tile art.
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=31536000, immutable";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ cigarId: string }> },
): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!principal) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });
  const { cigarId } = await ctx.params;

  try {
    const photo = await getProductPhoto(deps, { cigarId });
    const object = await photoStorage.get(photo.thumbKey);
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": photo.contentType, "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
