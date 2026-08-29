import type {
  AssessmentInput,
  ConstructionInput,
  ProgressionEntryInput,
  QueryMySmokesFilters,
  RecordPurchaseInput,
  SaveSmokeInput,
  SmokedAtInput,
  UpdateSmokeInput,
} from "./types.js";
import { ValidationError, type FieldError } from "./errors.js";

const DRAW_BURN = new Set(["excellent", "good", "fair", "poor"]);
const SMOKE_OUTPUT = new Set(["low", "medium", "high"]);
const SMOKED_AT_SOURCE = new Set(["user", "system-finalized", "legacy-document", "unknown"]);
const SMOKED_AT_PRECISION = new Set(["minute", "approximate", "day"]);

function isNonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function checkRating(rating: number | null | undefined, path: string, errors: FieldError[]): void {
  if (rating == null) return;
  if (!Number.isInteger(rating) || rating < 0 || rating > 100) {
    errors.push({ path, message: "Must be an integer 0-100 or null." });
  }
}

function checkConstruction(construction: ConstructionInput, prefix: string, errors: FieldError[]): void {
  if (construction.draw != null && !DRAW_BURN.has(construction.draw)) {
    errors.push({ path: `${prefix}.draw`, message: "Must be one of excellent, good, fair, poor." });
  }
  if (construction.burn != null && !DRAW_BURN.has(construction.burn)) {
    errors.push({ path: `${prefix}.burn`, message: "Must be one of excellent, good, fair, poor." });
  }
  if (construction.smokeOutput != null && !SMOKE_OUTPUT.has(construction.smokeOutput)) {
    errors.push({ path: `${prefix}.smokeOutput`, message: "Must be one of low, medium, high." });
  }
}

function checkAssessment(assessment: AssessmentInput, prefix: string, errors: FieldError[]): void {
  checkRating(assessment.rating, `${prefix}.rating`, errors);
}

function checkProgression(entries: ProgressionEntryInput[], errors: FieldError[]): void {
  entries.forEach((entry, index) => {
    const position = entry.approximatePosition;
    if (position != null && (typeof position !== "number" || Number.isNaN(position) || position < 0 || position > 1)) {
      errors.push({ path: `progression[${index}].approximatePosition`, message: "Must be between 0 and 1." });
    }
  });
}

function checkSmokedAt(smokedAt: SmokedAtInput, errors: FieldError[]): void {
  if (Number.isNaN(Date.parse(smokedAt.value))) {
    errors.push({
      path: "smokedAt.value",
      // Date-only values are accepted (precision: day), so the message must not
      // demand a full time — mirrors the query-filter wording.
      message: "Must be an ISO-8601 date (YYYY-MM-DD) or date-time.",
    });
  }
  if (smokedAt.source != null && !SMOKED_AT_SOURCE.has(smokedAt.source)) {
    errors.push({ path: "smokedAt.source", message: "Invalid source." });
  }
  if (smokedAt.precision != null && !SMOKED_AT_PRECISION.has(smokedAt.precision)) {
    errors.push({ path: "smokedAt.precision", message: "Invalid precision." });
  }
}

// Minimum validity (ADR-002): a cigar reference plus at least one substantive
// field. Descriptors are normalized, never rejected, so they are validated for
// substance (non-empty) only, not shape.
export function validateSaveInput(input: SaveSmokeInput): void {
  const errors: FieldError[] = [];

  const hasCigar =
    ("cigarId" in input.cigar && isNonEmpty(input.cigar.cigarId)) ||
    ("described" in input.cigar && isNonEmpty(input.cigar.described?.canonicalName));
  if (!hasCigar) {
    errors.push({ path: "cigar", message: "A cigarId or described.canonicalName is required." });
  }

  const substantive =
    (input.progression?.length ?? 0) > 0 ||
    (input.overallDescriptors?.length ?? 0) > 0 ||
    isNonEmpty(input.journal?.narrative) ||
    isNonEmpty(input.assessment?.impression) ||
    isNonEmpty(input.originalMarkdown);
  if (!substantive) {
    // Message names only the client-suppliable fields: originalMarkdown is an
    // import-only field, not part of the save_smoke tool schema, so surfacing it
    // to a conversational client would ask for something it cannot provide.
    errors.push({
      path: "smoke",
      message:
        "At least one of progression, overallDescriptors, journal.narrative, or assessment.impression is required.",
    });
  }

  if (input.assessment) checkAssessment(input.assessment, "assessment", errors);
  if (input.construction) checkConstruction(input.construction, "construction", errors);
  if (input.progression) checkProgression(input.progression, errors);
  if (input.smokedAt) checkSmokedAt(input.smokedAt, errors);

  if (errors.length > 0) throw new ValidationError(errors);
}

// A change block is meaningful only when it actually carries an operation:
// an empty `changes` (or blocks with no operative keys, e.g. `progression:
// { append: [] }`) would otherwise bump the version and write an audit row for
// nothing. Mirrors buildPatch, which produces no changedFields in these cases.
function hasAnyChange(changes: UpdateSmokeInput["changes"]): boolean {
  if (changes.cigar) return true;
  if (changes.smokedAt) return true;
  if ("context" in changes) return true;
  if (changes.assessment && Object.keys(changes.assessment).length > 0) return true;
  if (changes.construction && Object.keys(changes.construction).length > 0) return true;
  if (changes.journal && Object.keys(changes.journal).length > 0) return true;
  if (
    changes.overallDescriptors &&
    ((changes.overallDescriptors.add?.length ?? 0) > 0 ||
      (changes.overallDescriptors.remove?.length ?? 0) > 0)
  ) {
    return true;
  }
  if ((changes.progression?.append?.length ?? 0) > 0) return true;
  if (changes.consumption) return true;
  return false;
}

export function validateUpdateInput(input: UpdateSmokeInput): void {
  const errors: FieldError[] = [];
  const changes = input.changes;

  if (!hasAnyChange(changes)) {
    errors.push({ path: "changes", message: "At least one change operation is required." });
  }

  if (changes.assessment) checkAssessment(changes.assessment, "changes.assessment", errors);
  if (changes.construction) checkConstruction(changes.construction, "changes.construction", errors);
  if (changes.progression?.append) {
    changes.progression.append.forEach((entry, index) => {
      const position = entry.approximatePosition;
      if (
        position != null &&
        (typeof position !== "number" || Number.isNaN(position) || position < 0 || position > 1)
      ) {
        errors.push({
          path: `changes.progression.append[${index}].approximatePosition`,
          message: "Must be between 0 and 1.",
        });
      }
    });
  }
  if (changes.smokedAt) checkSmokedAt(changes.smokedAt, errors);
  if (changes.cigar && !isNonEmpty(changes.cigar.resolveTo)) {
    errors.push({ path: "changes.cigar.resolveTo", message: "Required." });
  }

  if (errors.length > 0) throw new ValidationError(errors);
}

function checkDate(value: string | null | undefined, path: string, errors: FieldError[]): void {
  if (value != null && Number.isNaN(Date.parse(value))) {
    errors.push({ path, message: "Must be an ISO-8601 date (YYYY-MM-DD) or date-time." });
  }
}

// Everything is a purchase row (owner, 2026-08-28): quantity is required and
// non-zero; a negative quantity is a correction and must carry its reason in
// notes. Dates and price are lenient leaves the domain checks so a malformed
// value returns a structured validation_error rather than an opaque DB fault.
export function validateRecordPurchaseInput(input: RecordPurchaseInput): void {
  const errors: FieldError[] = [];

  const hasCigar =
    ("cigarId" in input.cigar && isNonEmpty(input.cigar.cigarId)) ||
    ("described" in input.cigar && isNonEmpty(input.cigar.described?.canonicalName));
  if (!hasCigar) {
    errors.push({ path: "cigar", message: "A cigarId or described.canonicalName is required." });
  }

  if (!Number.isInteger(input.quantity)) {
    errors.push({ path: "quantity", message: "Must be a non-zero integer." });
  } else if (input.quantity === 0) {
    errors.push({ path: "quantity", message: "Must not be zero — record an acquisition or a correction." });
  } else if (input.quantity < 0 && !isNonEmpty(input.notes)) {
    // A negative quantity corrects the count; notes carry the reason.
    errors.push({ path: "notes", message: "A negative quantity requires notes explaining the correction." });
  }

  if (input.pricePerStick != null && (typeof input.pricePerStick !== "number" || !Number.isFinite(input.pricePerStick))) {
    errors.push({ path: "pricePerStick", message: "Must be a number or null." });
  }
  checkDate(input.purchasedAt, "purchasedAt", errors);
  checkDate(input.boxDate, "boxDate", errors);
  checkDate(input.humidorAt, "humidorAt", errors);

  if (errors.length > 0) throw new ValidationError(errors);
}

// Read-tool filters carry the same lenient-leaf discipline as writes: a
// malformed date string reaches the domain and returns a structured, field-
// pathed validation_error (fix_and_retry) rather than being handed to Postgres
// as an invalid timestamp, which would surface as an opaque `unavailable`.
export function validateQueryFilters(filters: QueryMySmokesFilters): void {
  const errors: FieldError[] = [];
  if (filters.smokedAfter != null && Number.isNaN(Date.parse(filters.smokedAfter))) {
    errors.push({ path: "smokedAfter", message: "Must be an ISO-8601 date (YYYY-MM-DD) or date-time." });
  }
  if (filters.smokedBefore != null && Number.isNaN(Date.parse(filters.smokedBefore))) {
    errors.push({ path: "smokedBefore", message: "Must be an ISO-8601 date (YYYY-MM-DD) or date-time." });
  }
  if (errors.length > 0) throw new ValidationError(errors);
}
