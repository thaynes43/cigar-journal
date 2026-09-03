// Typed error taxonomy matching the MCP tool contract codes. Every error
// carries a machine-readable `code`, `recoverable`, and an `action` so a client
// can self-correct. `toPayload()` is the only thing an adapter serializes — it
// never contains stack traces, SQL, secrets, or other users' existence.

export type ErrorCode =
  | "validation_error"
  | "unauthenticated"
  | "unauthorized"
  | "cigar_not_found"
  | "cigar_ambiguous"
  | "smoke_not_found"
  | "purchase_not_found"
  | "photo_not_found"
  | "photo_limit"
  | "photo_drop_not_found"
  | "upload_token_invalid"
  | "invite_invalid"
  | "version_conflict"
  | "idempotency_conflict"
  | "unavailable";

export interface ErrorAction {
  type: string;
  tool?: string;
}

export interface FieldError {
  path: string;
  message: string;
}

// Candidates carry the fields that distinguish otherwise same-named catalog
// rows, so an `ask_user` action is answerable (vitola/brand/verification usually
// separate them). When rows are genuine duplicates with no differentiators this
// cannot help — that is a catalog-curation (merge) problem, not a surface one.
export interface CigarCandidate {
  cigarId: string;
  canonicalName: string;
  brand: string | null;
  vitola: string | null;
  verification: "verified" | "unverified";
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  action: ErrorAction | null;
  [extra: string]: unknown;
}

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly recoverable: boolean;
  abstract readonly action: ErrorAction | null;

  toPayload(): ErrorPayload {
    return { code: this.code, message: this.message, recoverable: this.recoverable, action: this.action };
  }
}

export class ValidationError extends DomainError {
  readonly code = "validation_error" as const;
  readonly recoverable = true;
  readonly action: ErrorAction = { type: "fix_and_retry" };
  constructor(readonly fields: FieldError[]) {
    super("One or more fields are invalid.");
  }
  override toPayload(): ErrorPayload {
    return { ...super.toPayload(), fields: this.fields };
  }
}

export class UnauthenticatedError extends DomainError {
  readonly code = "unauthenticated" as const;
  readonly recoverable = false;
  readonly action: ErrorAction = { type: "reconnect" };
  constructor() {
    super("Not authenticated.");
  }
}

// Scope/ownership failures that are not about hiding a record's existence.
// A record that exists but isn't the caller's is reported as *_not_found so we
// never leak that it exists (tool-contract error principle).
export class UnauthorizedError extends DomainError {
  readonly code = "unauthorized" as const;
  readonly recoverable = false;
  readonly action: ErrorAction | null = null;
  constructor(message = "Not authorized.") {
    super(message);
  }
}

export class CigarNotFoundError extends DomainError {
  readonly code = "cigar_not_found" as const;
  readonly recoverable = true;
  readonly action: ErrorAction = { type: "search_first" };
  constructor() {
    super("No catalog cigar matches the given id.");
  }
}

export class CigarAmbiguousError extends DomainError {
  readonly code = "cigar_ambiguous" as const;
  readonly recoverable = true;
  readonly action: ErrorAction = { type: "ask_user" };
  constructor(
    query: string,
    readonly candidates: CigarCandidate[],
  ) {
    super(`Multiple catalog cigars match "${query}".`);
  }
  override toPayload(): ErrorPayload {
    return { ...super.toPayload(), candidates: this.candidates };
  }
}

export class SmokeNotFoundError extends DomainError {
  readonly code = "smoke_not_found" as const;
  readonly recoverable = false;
  readonly action: ErrorAction | null = null;
  constructor() {
    super("No smoke matches the given id.");
  }
}

// A purchase lot that exists but isn't the caller's, or no lot at all — the same
// shape and the same principle as SmokeNotFoundError: ownership never leaks, so
// a cross-user id reads exactly like an unknown one (ADR-017's update_purchase).
export class PurchaseNotFoundError extends DomainError {
  readonly code = "purchase_not_found" as const;
  readonly recoverable = false;
  readonly action: ErrorAction | null = null;
  constructor() {
    super("No purchase matches the given id.");
  }
}

// A photo that exists but isn't the caller's, or no photo at all, is reported as
// not-found so ownership never leaks (same principle as SmokeNotFoundError).
export class PhotoNotFoundError extends DomainError {
  readonly code = "photo_not_found" as const;
  readonly recoverable = false;
  readonly action: ErrorAction | null = null;
  constructor() {
    super("No photo matches the given id.");
  }
}

// The smoke already holds the maximum number of photos.
export class PhotoLimitError extends DomainError {
  readonly code = "photo_limit" as const;
  readonly recoverable = true;
  readonly action: ErrorAction = { type: "remove_a_photo_and_retry" };
  constructor(readonly limit: number) {
    super(`A smoke can hold at most ${limit} photos.`);
  }
  override toPayload(): ErrorPayload {
    return { ...super.toPayload(), limit: this.limit };
  }
}

// A photo drop that names nothing, or is not the caller's. The CLAIM never
// throws this — it reports `not_found` on its result, because by then the smoke
// is committed and a photo problem may not fail a save (ADR-014). The error
// exists for the callers that must throw instead of report: add_smoke_photo's
// `photoDropId` branch has no result to carry a status on.
export class PhotoDropNotFoundError extends DomainError {
  readonly code = "photo_drop_not_found" as const;
  readonly recoverable = false;
  readonly action: ErrorAction | null = null;
  constructor() {
    super("Photo drop not found.");
  }
}

// A photo upload link that is unknown, already used, or expired. One error for
// all three so the page (and any caller) learns nothing about which failure it
// was — no oracle for probing tokens. Not owner-scoped: the raw token IS the
// authorization, so a bad token is simply invalid.
export class UploadTokenInvalidError extends DomainError {
  readonly code = "upload_token_invalid" as const;
  readonly recoverable = false;
  readonly action: ErrorAction | null = null;
  constructor() {
    super("The upload link is invalid or has expired.");
  }
}

// An invite link that is unknown, already redeemed, revoked, or expired. One
// error for all four so nothing learns which — the same no-oracle rule as
// UploadTokenInvalidError. The raw token IS the authorization, so a bad token is
// simply invalid; there is no owner scope to leak.
export class InviteInvalidError extends DomainError {
  readonly code = "invite_invalid" as const;
  readonly recoverable = false;
  readonly action: ErrorAction | null = null;
  constructor() {
    super("The invite link is invalid or has expired.");
  }
}

export class VersionConflictError extends DomainError {
  readonly code = "version_conflict" as const;
  readonly recoverable = true;
  readonly action: ErrorAction = { type: "retrieve_latest_and_retry", tool: "get_smoke" };
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super("The smoke was modified since the expected version.");
  }
  override toPayload(): ErrorPayload {
    return { ...super.toPayload(), expectedVersion: this.expectedVersion, currentVersion: this.currentVersion };
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = "idempotency_conflict" as const;
  readonly recoverable = false;
  readonly action: ErrorAction | null = null;
  constructor() {
    super("This clientRequestId was already used for a different request.");
  }
}

export class UnavailableError extends DomainError {
  readonly code = "unavailable" as const;
  readonly recoverable = true;
  readonly action: ErrorAction = { type: "retry" };
  constructor() {
    super("The service is temporarily unavailable.");
  }
}
