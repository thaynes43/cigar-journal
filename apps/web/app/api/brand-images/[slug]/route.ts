import { getBrandImage } from "@cj/domain";
import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";

// One brand's Wikimedia cover (ADR-007 third binding, issue 127). Catalog-scoped
// like the product-photo routes: any signed-in user may view it, authorization is
// at the route. 404 when no approved image serves, 503 when the object store is
// unconfigured.
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=31536000, immutable";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!principal) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });
  const { slug } = await ctx.params;

  try {
    const image = await getBrandImage(deps, { slug });
    const object = await photoStorage.get(image.objectKey);
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": image.contentType, "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
