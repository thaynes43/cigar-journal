import { getBrandImage } from "@cj/domain";
import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";

// One brand's Wikimedia cover thumbnail — the brand-wall tile art (issue 127).
// Same catalog-scoped authorization as the full-size route.
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=31536000, immutable";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!principal) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });
  const { slug } = await ctx.params;

  try {
    const image = await getBrandImage(deps, { slug });
    const object = await photoStorage.get(image.thumbKey);
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": image.contentType, "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
