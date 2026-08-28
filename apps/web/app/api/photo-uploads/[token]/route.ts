import { db } from "@cj/db";
import {
  addSmokePhoto,
  consumePhotoUploadToken,
  UploadTokenInvalidError,
  type Deps,
} from "@cj/domain";
import { processPhoto, UnsupportedImageTypeError } from "@cj/photos";
import { photoStorage, MAX_UPLOAD_BYTES } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";

// The POST target of the single-use photo upload page (ADR-007, issue #44 part 2).
// The token in the path IS the authorization — there is no session here. The
// token is consumed (single-use, atomic) BEFORE the image is processed; if the
// photo add then fails the token stays burned (acceptable — the page shows the
// error and the model can mint another). Provenance is "web": it genuinely is a
// web upload, just token-authenticated rather than session-authenticated.
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });
  const { token } = await ctx.params;
  const deps: Deps = { db, now: () => new Date() };

  let consumed;
  try {
    consumed = await consumePhotoUploadToken(deps, { token });
  } catch (error) {
    if (error instanceof UploadTokenInvalidError) {
      return Response.json({ error: "Link expired." }, { status: 410 });
    }
    throw error;
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Upload failed." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "Upload failed." }, { status: 413 });
  }

  const input = Buffer.from(await file.arrayBuffer());
  let processed;
  try {
    processed = await processPhoto(input, file.type);
  } catch (error) {
    if (error instanceof UnsupportedImageTypeError) {
      return Response.json({ error: "Upload failed." }, { status: 415 });
    }
    return Response.json({ error: "Upload failed." }, { status: 422 });
  }

  try {
    const view = await addSmokePhoto(
      deps,
      photoStorage,
      { userId: consumed.userId, role: "user" },
      {
        smokeId: consumed.smokeId,
        kind: consumed.kind,
        caption: consumed.caption,
        image: {
          full: processed.full,
          thumb: processed.thumb,
          contentType: processed.contentType,
          width: processed.width,
          height: processed.height,
          bytes: processed.full.byteLength,
        },
      },
    );
    return Response.json(view, { status: 201 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
