import type {
  AssessmentInput,
  ConstructionInput,
  ProgressionEntryInput,
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
    errors.push({ path: "smokedAt.value", message: "Must be a valid date-time." });
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
    isNonEmpty(input.assessment?.impression);
  if (!substantive) {
    errors.push({
      path: "smoke",
      message: "At least one of progression, overallDescriptors, journal.narrative, or assessment.impression is required.",
    });
  }

  if (input.assessment) checkAssessment(input.assessment, "assessment", errors);
  if (input.construction) checkConstruction(input.construction, "construction", errors);
  if (input.progression) checkProgression(input.progression, errors);
  if (input.smokedAt) checkSmokedAt(input.smokedAt, errors);

  if (errors.length > 0) throw new ValidationError(errors);
}

export function validateUpdateInput(input: UpdateSmokeInput): void {
  const errors: FieldError[] = [];
  const changes = input.changes;

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
