import { randomUUID } from "node:crypto";
import { db } from "@cj/db";
import {
  assertPhotoDropUsable,
  getPhotoDropByToken,
  stagePhotoByToken,
  type DomainError,
  UploadTokenInvalidError,
  type Deps,
} from "@cj/domain";
import { processPhoto, UnsupportedImageTypeError } from "@cj/photos";
import { photoStorage, MAX_UPLOAD_BYTES } from "@/lib/photos";
import { domainErrorResponse, uploadErrorResponse } from "@/lib/photo-http";
import { isSmokePhotoKind } from "@/lib/photo-kinds";
import { webEvent, logScalar } from "@/lib/log";

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

// EVERY upload attempt leaves exactly one `[web] photo_drop_upload` line, staged
// or rejected (lib/log.ts). `photoDropId` is the join to the `open_photo_drop`
// that minted the link and `correlationId` the join to the audit row this request
// writes — before this, a mint whose photo never landed and one whose photo
// landed fine were the same silence. The token is NEVER logged, in any form: it
// is the whole authorization, so an unknown or expired one logs a null drop id
// rather than a hash.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const startedAt = Date.now();
  const correlationId = randomUUID();
  // Host-writable, so bounded — enough to tell a phone camera upload from a curl.
  const ua = logScalar(req.headers.get("user-agent"));
  const seen: {
    photoDropId: string | null;
    photoId: string | null;
    bytes: number | null;
    width: number | null;
    height: number | null;
    mime: string | null;
  } = { photoDropId: null, photoId: null, bytes: null, width: null, height: null, mime: null };

  // `outcome` is `staged` or `rejected:<code>`, where the code is the one the
  // page reads off the envelope — so the log line and the user's message name the
  // same failure.
  const done = (outcome: string, res: Response): Response => {
    webEvent("photo_drop_upload", {
      correlationId,
      photoDropId: seen.photoDropId,
      photoId: seen.photoId,
      outcome,
      status: res.status,
      bytes: seen.bytes,
      width: seen.width,
      height: seen.height,
      mime: seen.mime,
      ua,
      ms: Date.now() - startedAt,
    });
    return res;
  };

  if (!photoStorage) return done("rejected:unavailable", uploadErrorResponse("unavailable", 503));
  const { token } = await ctx.params;

  try {
    // The id is for the log line only — the response is unchanged, so a dead link
    // still answers one 410 with nothing to probe.
    seen.photoDropId = (await assertPhotoDropUsable(deps(), { token })).photoDropId;
  } catch (error) {
    if (error instanceof UploadTokenInvalidError) {
      return done("rejected:upload_token_invalid", uploadErrorResponse("upload_token_invalid", 410));
    }
    throw error;
  }

  // A truncated or otherwise unparsable multipart body makes formData() THROW —
  // an uncaught TypeError, so the request became a Next 500 with no
  // `photo_drop_upload` line at all: the one upload outcome this endpoint could
  // not describe, on the path the model falls back to when nothing is forwarded.
  // It is a malformed request, not a server fault, so it answers the envelope the
  // page already reads for a missing file and leaves its record like every other
  // rejection. The token endpoint takes the same care for the same reason.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return done("rejected:malformed_body", uploadErrorResponse("validation_error", 400));
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return done("rejected:no_file", uploadErrorResponse("validation_error", 400));
  }
  // Declared first, then what actually arrived, then what was stored — the line
  // always states the most it knows about the bytes at the point it was written.
  seen.bytes = file.size;
  seen.mime = logScalar(file.type);

  // The kind arrives on an anonymous request and lands in a `text` column, so it
  // is checked here rather than trusted; omitting it is fine and means "cigar"
  // (#287) — the drop page's chips then open on `Cigar` already selected.
  const rawKind = form.get("kind");
  if (rawKind !== null && !isSmokePhotoKind(rawKind)) {
    return done("rejected:bad_kind", uploadErrorResponse("validation_error", 400));
  }
  const kind = rawKind === null ? undefined : rawKind;

  if (file.size > MAX_UPLOAD_BYTES) {
    return done("rejected:too_large", uploadErrorResponse("too_large", 413));
  }
  const input = Buffer.from(await file.arrayBuffer());
  // `file.size` is what the multipart part declared; this is what actually
  // arrived. Checking both keeps the ceiling honest without buffering twice.
  seen.bytes = input.byteLength;
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    return done("rejected:too_large", uploadErrorResponse("too_large", 413));
  }

  let processed;
  try {
    processed = await processPhoto(input, file.type);
  } catch (error) {
    if (error instanceof UnsupportedImageTypeError) {
      return done("rejected:unsupported_type", uploadErrorResponse("unsupported_type", 415));
    }
    return done("rejected:unreadable", uploadErrorResponse("unreadable", 422));
  }
  seen.bytes = processed.full.byteLength;
  seen.width = processed.width;
  seen.height = processed.height;
  seen.mime = processed.contentType;

  // Staged before the claim, straight onto the smoke after it — the drop decides,
  // and the page renders whichever it says (`attached`).
  try {
    const view = await stagePhotoByToken(deps(), photoStorage, {
      token,
      kind,
      correlationId,
      image: {
        full: processed.full,
        thumb: processed.thumb,
        contentType: processed.contentType,
        width: processed.width,
        height: processed.height,
        bytes: processed.full.byteLength,
      },
    });
    seen.photoId = view.photoId;
    return done("staged", Response.json(view, { status: 201 }));
  } catch (error) {
    // domainErrorResponse re-throws anything that is not a DomainError, so a 500
    // is Next's and leaves no line here — by design: this record describes the
    // upload contract, not an unhandled fault.
    const res = domainErrorResponse(error);
    return done(`rejected:${(error as DomainError).code}`, res);
  }
}
