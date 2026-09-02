// What each upload failure actually was, in the user's terms. A single "Upload
// failed." for every case told someone holding a 40MB video the same thing it
// told someone whose link had expired — one of them could have fixed it in a
// second and had no way to know. The route names the failure; this is the only
// place that turns a name into words.
//
// Shared by both anonymous token surfaces — the single-use upload page
// (`/u/<token>`, ADR-007) and the photo drop (`/d/<token>`, ADR-014) — because
// they post the same file to the same pipeline and get back the same
// `{ error: { code } }` vocabulary (lib/photo-http.ts). One copy of the words,
// so a message cannot be fixed on one page and left wrong on the other.
//
// Every number here comes from the thing that enforced it — the byte ceiling
// from the constant the route checks, the photo count from the domain error's
// own payload — so no message can outlive the rule it describes. The type list
// is the pipeline's ACCEPTED set (@cj/photos), minus the HEIF spelling of HEIC.
import { MAX_UPLOAD_LABEL } from "./upload-limits";

export const GENERIC_UPLOAD_ERROR = "Upload failed — try again.";
const PHOTO_LIMIT_FALLBACK = 12; // @cj/domain MAX_PHOTOS_PER_SMOKE

// `photoLimit` is a parameter rather than a constant because it is the ONE
// sentence the two surfaces cannot share: a `/u` link names a smoke that already
// holds its photos, a drop has no smoke yet and states the ceiling instead.
// Passing it in keeps that difference at the call site, where the difference is.
export function messageFor(
  code: string | undefined,
  limit: number | undefined,
  photoLimit: (limit: number) => string,
): string {
  switch (code) {
    case "photo_limit":
      return photoLimit(limit ?? PHOTO_LIMIT_FALLBACK);
    case "too_large":
      return `That photo is over the ${MAX_UPLOAD_LABEL} limit.`;
    case "unsupported_type":
      return "That file type isn't supported — use a JPEG, PNG, HEIC, or WebP photo.";
    case "upload_token_invalid":
      return "This link has expired or was already used. Ask for a new one in chat.";
    default:
      return GENERIC_UPLOAD_ERROR;
  }
}
