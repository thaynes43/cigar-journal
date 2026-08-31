import { DomainError, type ErrorCode } from "@cj/domain";

// The smoke-photo cache policy, stated once because the full-size and thumb
// routes are mirrors and must never drift apart.
//
// Owner bytes are content-addressed and never leave the owner's own cache, so
// they keep the immutable year. Public bytes are a *revocable* grant: deleting
// the photo, or flipping the journal back to private, has to take effect in
// shared caches promptly — which `immutable` for a year cannot do, since a
// shared cache is entitled to serve those bytes to anyone for the full year with
// no revalidation. Hence a short TTL that must be revalidated.
export const PHOTO_PRIVATE_CACHE = "private, max-age=31536000, immutable";
export const PHOTO_PUBLIC_CACHE = "public, max-age=300, must-revalidate";

// One URL, two variants: the same photo id serves owner bytes or public bytes
// depending on the session cookie. Every response on those routes carries this,
// so a shared cache can never hand one viewer's variant — or its cache scope —
// to another.
export const PHOTO_VARY: Record<string, string> = { Vary: "Cookie" };

// The headers for a served smoke photo, full-size or thumbnail.
export function smokePhotoHeaders(contentType: string, isPublic: boolean): Record<string, string> {
  return {
    ...PHOTO_VARY,
    "Content-Type": contentType,
    "Cache-Control": isPublic ? PHOTO_PUBLIC_CACHE : PHOTO_PRIVATE_CACHE,
  };
}

// Domain typed errors → HTTP status for the photo REST routes, mirroring the
// tRPC error mapper (server/trpc.ts). The machine-readable domain payload rides
// in the body so a client can self-correct; nothing else leaks.
const DOMAIN_TO_STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthenticated: 401,
  unauthorized: 403,
  cigar_not_found: 404,
  cigar_ambiguous: 409,
  smoke_not_found: 404,
  photo_not_found: 404,
  photo_limit: 409,
  upload_token_invalid: 410,
  invite_invalid: 410,
  version_conflict: 409,
  idempotency_conflict: 409,
  unavailable: 503,
};

// Turn a caught error into a Response. Domain errors map to their status with
// the structured payload; anything else is re-thrown so Next surfaces a 500
// without leaking internals. `headers` carries per-route cache directives that
// must ride on the error response too (the smoke-photo routes' `Vary: Cookie`).
export function domainErrorResponse(error: unknown, headers?: HeadersInit): Response {
  if (error instanceof DomainError) {
    return Response.json(
      { error: error.toPayload() },
      { status: DOMAIN_TO_STATUS[error.code], headers },
    );
  }
  throw error;
}
