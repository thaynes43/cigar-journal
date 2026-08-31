import { randomUUID } from "node:crypto";
import { attachProductPhoto, getProductPhoto } from "@cj/domain";
import { processPhoto, UnsupportedImageTypeError } from "@cj/photos";
import { createContext } from "@/server/context";
import { photoStorage, MAX_UPLOAD_BYTES } from "@/lib/photos";
import { MAX_UPLOAD_LABEL } from "@/lib/upload-limits";
import { domainErrorResponse } from "@/lib/photo-http";

// One cigar's product photo (ADR-007). GET serves it — product photos are
// catalog-scoped, not owner-scoped: any signed-in user may view them
// (authorization is at the route, not by key secrecy). POST attaches/replaces it
// and is curator-only (DESIGN-003 §Images) — the direct upload path for the
// owner's un-crawlable cigars. 404 when absent, 503 when the object store is
// unconfigured.
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
    const object = await photoStorage.get(photo.objectKey);
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": photo.contentType, "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

// Curator upload (DESIGN-003 §Images). Multipart in; the image is run through the
// shared pipeline inside @cj/domain (EXIF applied + stripped, normalized JPEG +
// thumb), the objects land under `product/<cigarId>/…`, and the row is upserted
// `approved` with a null source_url (uploader-asserted rights). Same size/type
// limits as the smoke-photo route. Non-admin → 403 (the resource is readable by
// any authed user via GET, so hiding the mutation behind a 404 would be theatre —
// 403 matches adminProcedure/photo-http).
export async function POST(
  req: Request,
  ctx: { params: Promise<{ cigarId: string }> },
): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!principal) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (principal.role !== "admin") return Response.json({ error: "Not authorized." }, { status: 403 });
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });
  const { cigarId } = await ctx.params;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file is required." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: `Image exceeds the ${MAX_UPLOAD_LABEL} limit.` }, { status: 413 });
  }
  const requestIdRaw = form.get("clientRequestId");
  const clientRequestId = typeof requestIdRaw === "string" && requestIdRaw.length > 0 ? requestIdRaw : randomUUID();

  const image = Buffer.from(await file.arrayBuffer());
  try {
    const result = await attachProductPhoto(deps, photoStorage, processPhoto, principal, {
      clientRequestId,
      cigarId,
      image,
      contentType: file.type,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof UnsupportedImageTypeError) {
      return Response.json({ error: error.message }, { status: 415 });
    }
    return domainErrorResponse(error);
  }
}
