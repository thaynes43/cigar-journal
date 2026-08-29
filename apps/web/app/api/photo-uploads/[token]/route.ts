import { randomUUID } from "node:crypto";
import { db } from "@cj/db";
import {
  addSmokePhoto,
  attachProductPhoto,
  consumePhotoUploadToken,
  UploadTokenInvalidError,
  type Deps,
} from "@cj/domain";
import { processPhoto, UnsupportedImageTypeError } from "@cj/photos";
import { photoStorage, MAX_UPLOAD_BYTES } from "@/lib/photos";
import { domainErrorResponse } from "@/lib/photo-http";

// The POST target of the single-use photo upload page (ADR-007, issue #44 part 2;
// product photos in DESIGN-003 §Images). The token in the path IS the
// authorization — there is no session here. The token is consumed (single-use,
// atomic) BEFORE the image is processed; if the add then fails the token stays
// burned (acceptable — the page shows the error and the model/curator can mint
// another). The consumed binding is discriminated: a `smoke` token attaches under
// the token's user; a `product` token attaches to its catalog cigar (only an admin
// can mint one, so the token carries that authorization). Provenance is "web".
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

  // A product token attaches the catalog cigar's photo. attachProductPhoto runs the
  // pipeline itself; the minting admin's user id rides the token, so we act as that
  // curator (only an admin could have minted this link).
  if (consumed.targetKind === "product") {
    try {
      const result = await attachProductPhoto(
        deps,
        photoStorage,
        processPhoto,
        { userId: consumed.userId, role: "admin" },
        { clientRequestId: randomUUID(), cigarId: consumed.cigarId, image: input, contentType: file.type },
      );
      return Response.json(result, { status: 201 });
    } catch (error) {
      if (error instanceof UnsupportedImageTypeError) {
        return Response.json({ error: "Upload failed." }, { status: 415 });
      }
      return domainErrorResponse(error);
    }
  }

  // A smoke token: run the pipeline here, then store under the token's smoke.
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
