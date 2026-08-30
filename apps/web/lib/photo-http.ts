import { DomainError, type ErrorCode } from "@cj/domain";

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
// without leaking internals.
export function domainErrorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    return Response.json({ error: error.toPayload() }, { status: DOMAIN_TO_STATUS[error.code] });
  }
  throw error;
}
