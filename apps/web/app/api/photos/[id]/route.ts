import { getSmokePhoto, removeSmokePhoto } from "@cj/domain";
import { createContext } from "@/server/context";
import { photoStorage } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";

// Serve and delete one smoke photo (ADR-007). The bucket is private; access is
// authorized here (owner-only), not by key secrecy. Full-size object.
export const dynamic = "force-dynamic";

// Object keys are content-addressed and immutable, so cache hard — but privately,
// since the bytes are owner-scoped.
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
    const object = await photoStorage.get(photo.objectKey);
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": photo.contentType, "Cache-Control": CACHE_CONTROL },
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
