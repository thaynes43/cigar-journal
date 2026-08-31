import { randomUUID } from "node:crypto";
import { db } from "@cj/db";
import {
  addSmokePhoto,
  assertPhotoUploadTokenUsable,
  attachProductPhoto,
  consumePhotoUploadToken,
  UploadTokenInvalidError,
  type Deps,
} from "@cj/domain";
import { processPhoto, UnsupportedImageTypeError } from "@cj/photos";
import { photoStorage, MAX_UPLOAD_BYTES } from "@/lib/photos";
import { domainErrorResponse, uploadErrorResponse } from "@/lib/photo-http";

// The POST target of the single-use photo upload page (ADR-007, issue #44 part 2;
// product photos in DESIGN-003 §Images). The token in the path IS the
// authorization — there is no session here. The consumed binding is
// discriminated: a `smoke` token attaches under the token's user; a `product`
// token attaches to its catalog cigar (only an admin can mint one, so the token
// carries that authorization). Provenance is "web".
//
// ORDER IS THE CONTRACT. The token is single-use, so consuming it before the file
// is known-good burned the link on every 400/413/415/422 — the user picked a
// video or a 40MB raw, saw an error, tried again with the right photo, and was
// told the link had expired. It had not; the first attempt had spent it. So:
//
//   1. reject a dead link (a read, not a consume) — nothing below is free, and
//      this endpoint takes no session, so an unusable token must not buy a
//      stranger a full image decode;
//   2. run every check that can reject the FILE — presence, size, type, decode;
//   3. consume, immediately before the store + DB write.
//
// Step 1 reserves nothing: two concurrent posts both pass it and the consume in
// step 3 is still the only thing that makes the use exclusive. Past the consume a
// failure does burn the link (photo_limit, smoke_not_found) — correctly, since
// that is the write itself failing, not the file being wrong.
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (!photoStorage) return uploadErrorResponse("unavailable", 503);
  const { token } = await ctx.params;
  const deps: Deps = { db, now: () => new Date() };

  try {
    await assertPhotoUploadTokenUsable(deps, { token });
  } catch (error) {
    if (error instanceof UploadTokenInvalidError) {
      return uploadErrorResponse("upload_token_invalid", 410);
    }
    throw error;
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return uploadErrorResponse("validation_error", 400);
  if (file.size > MAX_UPLOAD_BYTES) return uploadErrorResponse("too_large", 413);

  const input = Buffer.from(await file.arrayBuffer());
  // `file.size` is what the multipart part declared; this is what actually
  // arrived. Checking both keeps the ceiling honest without buffering twice.
  if (input.byteLength > MAX_UPLOAD_BYTES) return uploadErrorResponse("too_large", 413);

  // The whole pipeline runs here, before the consume, so an unsupported type or
  // bytes that will not decode cost the user nothing but a retry. Decoding once
  // and handing the result down means neither branch below re-decodes.
  let processed;
  try {
    processed = await processPhoto(input, file.type);
  } catch (error) {
    if (error instanceof UnsupportedImageTypeError) return uploadErrorResponse("unsupported_type", 415);
    return uploadErrorResponse("unreadable", 422);
  }

  let consumed;
  try {
    consumed = await consumePhotoUploadToken(deps, { token });
  } catch (error) {
    if (error instanceof UploadTokenInvalidError) {
      return uploadErrorResponse("upload_token_invalid", 410);
    }
    throw error;
  }

  // A product token attaches the catalog cigar's photo. attachProductPhoto owns
  // the pipeline call, so it gets the already-decoded result rather than running
  // sharp a second time. The minting admin's user id rides the token, so we act
  // as that curator (only an admin could have minted this link).
  if (consumed.targetKind === "product") {
    try {
      const result = await attachProductPhoto(
        deps,
        photoStorage,
        async () => processed,
        { userId: consumed.userId, role: "admin" },
        { clientRequestId: randomUUID(), cigarId: consumed.cigarId, image: input, contentType: file.type },
      );
      return Response.json(result, { status: 201 });
    } catch (error) {
      return domainErrorResponse(error);
    }
  }

  // A smoke token: store the processed image under the token's smoke.
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
