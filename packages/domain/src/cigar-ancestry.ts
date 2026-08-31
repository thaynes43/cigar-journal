import { ValidationError, type FieldError } from "./errors.js";

// Ancestry consistency for the catalog taxonomy (ADR-012, migration 0026).
//
// A `cigars` row carries three nullable FKs — `brandId`, `lineId`, `blendId`.
// The database enforces that each points at a real row, but NOT that they agree
// with each other: nothing at the SQL level stops a cigar from claiming Drew
// Estate's brand and Padrón's line. That rule lives here.
//
// NOT YET CALLED FROM ANYWHERE. Wave 1 defines and tests the invariant; Wave 2
// wires it into the identity write paths that set these columns. That is safe
// only because Wave 1 writes no `lineId` or `blendId` at all — the 0026 backfill
// sets `brandId` and nothing above it, and a brand alone is always consistent.
//
// Deliberately not a composite FK, for a reason about ON DELETE SET NULL rather
// than about timing: a composite FK is checked at the END of the statement, so
// it would not fight a single-statement re-parent. What it would do is
// `FOREIGN KEY (brandId, lineId) REFERENCES lines (brandId, id) ON DELETE SET
// NULL`, which nulls the whole column pair when a line is retired — discarding a
// brand link that is still true — while the default MATCH SIMPLE skips the check
// outright whenever either column is NULL, the common shape here.
//
// Not a trigger either: a field-level error is what the callers need — the MCP
// and curation surfaces report WHICH level disagrees so the caller can correct
// it — and the Wave 3 curation paths re-parent brand, line and blend in a single
// statement, which a per-row trigger would fight.
//
// The rules, in full:
//   - All null is valid. Unknown ancestry stays NULL and is never invented.
//   - `brandId` alone is valid: a cigar whose line is unknown hangs off its brand.
//   - `lineId` requires `brandId`, and the line must belong to that brand.
//   - `blendId` requires `lineId`, and the blend must belong to that line.
//   - Brand agreement at the blend level follows transitively from those two.

// The three structural FKs as they would be written to a `cigars` row.
export interface CigarAncestry {
  brandId: string | null;
  lineId: string | null;
  blendId: string | null;
}

// The registry rows the ancestry names, as loaded by the caller. Each must be
// the row whose id the cigar claims; a missing one is itself a violation, since
// it means the caller could not resolve the level it is asserting.
export interface CigarAncestryContext {
  line?: { id: string; brandId: string } | null;
  blend?: { id: string; lineId: string } | null;
}

// Returns the field errors rather than throwing, for callers that collect
// several validations before reporting (the curation batch paths do this).
export function checkCigarAncestry(
  ancestry: CigarAncestry,
  context: CigarAncestryContext = {},
): FieldError[] {
  const { brandId, lineId, blendId } = ancestry;
  const errors: FieldError[] = [];

  if (lineId != null) {
    // A line implies a brand: the line's own row carries one, so a cigar that
    // names a line but no brand is not "partially known", it is inconsistent.
    if (brandId == null) {
      errors.push({ path: "brandId", message: "A cigar with a line must also carry that line's brand." });
    }
    const line = context.line;
    if (line == null) {
      errors.push({ path: "lineId", message: "The referenced line could not be resolved." });
    } else if (line.id !== lineId) {
      errors.push({ path: "lineId", message: "The resolved line does not match the referenced line." });
    } else if (brandId != null && line.brandId !== brandId) {
      errors.push({ path: "lineId", message: "The line belongs to a different brand than the cigar." });
    }
  }

  if (blendId != null) {
    // A blend implies a line: `blends.line_id` is NOT NULL, so every blend has
    // one. There is no such thing as a cigar whose blend is known but whose line
    // is not — the blend row itself supplies it.
    if (lineId == null) {
      errors.push({ path: "lineId", message: "A cigar with a blend must also carry that blend's line." });
    }
    const blend = context.blend;
    if (blend == null) {
      errors.push({ path: "blendId", message: "The referenced blend could not be resolved." });
    } else if (blend.id !== blendId) {
      errors.push({ path: "blendId", message: "The resolved blend does not match the referenced blend." });
    } else if (lineId != null && blend.lineId !== lineId) {
      errors.push({ path: "blendId", message: "The blend belongs to a different line than the cigar." });
    }
  }

  return errors;
}

// Throws ValidationError when the ancestry is inconsistent. The error carries a
// `fields` list naming the level at fault, so an MCP client or the curation UI
// can point at it directly. Reuses the existing `validation_error` code rather
// than minting a new one — the MCP tool contract's code set is fixed, and an
// inconsistent ancestry is a malformed write, not a new failure mode.
export function assertCigarAncestry(
  ancestry: CigarAncestry,
  context: CigarAncestryContext = {},
): void {
  const errors = checkCigarAncestry(ancestry, context);
  if (errors.length > 0) throw new ValidationError(errors);
}
