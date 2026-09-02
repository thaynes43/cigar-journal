import { db } from "@cj/db";
import {
  assertPhotoDropUsable,
  getPhotoDropByToken,
  stagePhotoByToken,
  UploadTokenInvalidError,
  type Deps,
} from "@cj/domain";
import { processPhoto, UnsupportedImageTypeError } from "@cj/photos";
import { photoStorage, MAX_UPLOAD_BYTES } from "@/lib/photos";
import { domainErrorResponse, uploadErrorResponse } from "@/lib/photo-http";
import { isSmokePhotoKind } from "@/lib/photo-kinds";

// The photo drop's own endpoints (ADR-014, issue #263): what `/d/<token>` reads,
// and where it posts. Anonymous — the token in the path IS the authorization,
// exactly as on `/api/photo-uploads/<token>`, and there is no session here. It is
// excluded from the edge session gate for that reason (middleware.ts).
//
// The drop link is MULTI-USE for its 48 hours, which is the one way this differs
// from its single-use sibling: nothing is spent, so a rejected file costs the
// user only a retry by construction rather than by ordering. The ORDER below is
// still the sibling's, and still the contract — an unusable link must not buy a
// stranger a full image decode:
//
//   1. reject a dead link (a read that grants nothing);
//   2. run every check that can reject the FILE — presence, kind, size, decode;
//   3. stage, which re-reads the drop and is the only authority on the cap.
//
// Errors ride the shared `{ error: { code } }` envelope (lib/photo-http.ts): the
// code is what selects the sentence the page shows.
export const dynamic = "force-dynamic";

function deps(): Deps {
  return { db, now: () => new Date() };
}

// The drop as its page reads it: status, the smoke once one has claimed it, and
// the photos this link can address.
//
// A CLOSED drop is answered 410, not 200 — the one place this route does not
// simply pass the domain view through. The domain resolves a dead drop on
// purpose (`closed` is a state, not an error) because a service may need to know
// which kind of dead it is; over HTTP nothing may, so expired, closed-by-deletion
// and never-existed collapse into the single answer the page shows as expired.
// That also keeps the read from being an oracle the POST is not.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (!photoStorage) return uploadErrorResponse("unavailable", 503);
  const { token } = await ctx.params;

  try {
    const view = await getPhotoDropByToken(deps(), { token });
    if (view.status === "closed") return uploadErrorResponse("upload_token_invalid", 410);
    return Response.json(view);
  } catch (error) {
    return domainErrorResponse(error);
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (!photoStorage) return uploadErrorResponse("unavailable", 503);
  const { token } = await ctx.params;

  try {
    await assertPhotoDropUsable(deps(), { token });
  } catch (error) {
    if (error instanceof UploadTokenInvalidError) {
      return uploadErrorResponse("upload_token_invalid", 410);
    }
    throw error;
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return uploadErrorResponse("validation_error", 400);

  // The kind arrives on an anonymous request and lands in a `text` column, so it
  // is checked here rather than trusted; omitting it is fine and means "other".
  const rawKind = form.get("kind");
  if (rawKind !== null && !isSmokePhotoKind(rawKind)) {
    return uploadErrorResponse("validation_error", 400);
  }
  const kind = rawKind === null ? undefined : rawKind;

  if (file.size > MAX_UPLOAD_BYTES) return uploadErrorResponse("too_large", 413);
  const input = Buffer.from(await file.arrayBuffer());
  // `file.size` is what the multipart part declared; this is what actually
  // arrived. Checking both keeps the ceiling honest without buffering twice.
  if (input.byteLength > MAX_UPLOAD_BYTES) return uploadErrorResponse("too_large", 413);

  let processed;
  try {
    processed = await processPhoto(input, file.type);
  } catch (error) {
    if (error instanceof UnsupportedImageTypeError) return uploadErrorResponse("unsupported_type", 415);
    return uploadErrorResponse("unreadable", 422);
  }

  // Staged before the claim, straight onto the smoke after it — the drop decides,
  // and the page renders whichever it says (`attached`).
  try {
    const view = await stagePhotoByToken(deps(), photoStorage, {
      token,
      kind,
      image: {
        full: processed.full,
        thumb: processed.thumb,
        contentType: processed.contentType,
        width: processed.width,
        height: processed.height,
        bytes: processed.full.byteLength,
      },
    });
    return Response.json(view, { status: 201 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
