import { ValidationError } from "./errors.js";

// Review-score normalization (ADR-013 §2): one native score, as the source
// stated it, mapped onto the single 0–100 axis every aggregate averages over.
//
// Nothing here touches the database. It is separated from the ingestion writer
// for one reason: the mapping is a CONVENTION, not a measurement, and a
// convention has to be readable, table-driven, and testable on its own. The
// native score and its scale are stored verbatim beside the normalized number
// (`native_scale` + `native_score`, migration 0028), so if a mapping below is
// ever judged wrong it can be restated and the whole corpus recomputed from
// stored facts — no re-crawl, no lost information.
//
// THE REFUSAL IS THE POINT. An unrecognized scale raises rather than guessing.
// A reviewer who scores out of 20 is not a reviewer who scores out of 100 with
// a low ceiling, and silently treating "17" as 17/100 would poison every
// aggregate above it with a number nobody ever wrote. Adding a scale is a
// deliberate edit here plus a CHECK-constraint change in a migration; it is
// meant to be that visible.

// The scales this build knows how to normalize. The list is duplicated as a
// CHECK constraint on `review_observations.native_scale` in migration 0028 —
// deliberately, so a scale the code cannot map is also a row the database
// cannot hold. `review-scores.test.ts` pins the two lists together.
export const REVIEW_SCALES = ["0-100", "0-10", "0-5-stars", "letter"] as const;

export type ReviewScale = (typeof REVIEW_SCALES)[number];

export function isReviewScale(value: string): value is ReviewScale {
  return (REVIEW_SCALES as readonly string[]).includes(value);
}

// The numeric scales, keyed by the value that means 100. Zero is the floor on
// all of them; a scale whose floor is not zero (a 50–100 "everything passes"
// house scale, say) is not representable here and must not be forced into one
// of these — it needs its own entry and its own affine mapping.
const NUMERIC_CEILINGS: Record<Exclude<ReviewScale, "letter">, number> = {
  "0-100": 100,
  "0-10": 10,
  "0-5-stars": 5,
};

// The letter-grade convention. Fixed once, so the same letter always yields the
// same number and two reviewers who both say "B+" contribute the same value.
//
// This is the widely published letter→percentage table, anchored rather than
// band-centred, and both halves of that choice are deliberate:
//
//   A+ is 100 because the top grade is the top of the axis. Mapping it to the
//   midpoint of a 97–100 band (98.5) would make a perfect review unable to
//   express a perfect score, which no other scale here suffers from.
//
//   F is 50, not the midpoint of its enormous 0–59 band (29.5) and not 0. On a
//   review axis, F means the cigar was bad — not that it failed to exist. 29.5
//   would let a single F drag a blend's aggregate further than any reviewer
//   using a numeric scale could, and 0 would do so twice over. 50 sits just
//   below D-, which is exactly the ordering the grade asserts.
//
// The interior grades are the conventional band anchors. Monotonicity across
// the whole table is asserted in the tests, because a non-monotone mapping
// would be a silent inversion — a worse grade scoring higher — and that is the
// one defect here that no aggregate downstream could reveal.
const LETTER_GRADES: Record<string, number> = {
  "A+": 100,
  A: 95,
  "A-": 90,
  "B+": 87,
  B: 85,
  "B-": 80,
  "C+": 77,
  C: 75,
  "C-": 70,
  "D+": 67,
  D: 65,
  "D-": 60,
  F: 50,
};

// Letters in the order the grades rank, best first. Exported so the tests can
// assert monotonicity without re-deriving the order from the map's key order,
// which is an implementation detail of the object literal.
export const LETTER_GRADE_ORDER = Object.keys(LETTER_GRADES);

// Source text arrives with whatever dash the reviewer's CMS emitted. A hyphen,
// a non-breaking hyphen, a figure dash, an en dash and a minus sign all mean
// "minus" in a grade, and none of them are worth a refusal.
const DASHES = /[‐‑‒–—−]/g;

// Round to two decimals. `0-10` and `0-5-stars` land on exact hundredths for
// any half- or tenth-step the source could state, so this only ever bites an
// odd native value (a 3.33/5). Two decimals keep it representable in the
// column's numeric(5,2) without the ingestion writer and the database
// disagreeing about the stored value.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function refuse(path: string, message: string): never {
  throw new ValidationError([{ path, message }]);
}

/**
 * Map one source-stated score onto the 0–100 axis.
 *
 * `nativeScore` is the score exactly as the source wrote it — a number for the
 * numeric scales, a grade string for `letter`. Numeric scales also accept a
 * numeric string, because an extractor that pulled "91" out of a page has no
 * reason to parse it first.
 *
 * Refuses (ValidationError, `fix_and_retry`) rather than guessing on: an
 * unknown scale, a value that is not a number on a numeric scale, a value
 * outside the scale's range, and an unknown letter grade. Every one of those is
 * a statement that the extractor misread the source, and a misread score is
 * worse than a missing one — it is indistinguishable from a real one once it is
 * averaged.
 */
export function normalizeReviewScore(nativeScale: string, nativeScore: number | string): number {
  if (!isReviewScale(nativeScale)) {
    refuse(
      "nativeScale",
      `Unknown review scale "${nativeScale}". Known scales: ${REVIEW_SCALES.join(", ")}.`,
    );
  }

  if (nativeScale === "letter") {
    // Case and stray whitespace are formatting; the dash class above is
    // typography. Neither changes which grade was given.
    const grade = String(nativeScore).trim().replace(DASHES, "-").toUpperCase();
    const mapped = LETTER_GRADES[grade];
    if (mapped == null) {
      refuse(
        "nativeScore",
        `Unknown letter grade "${String(nativeScore)}". Known grades: ${LETTER_GRADE_ORDER.join(", ")}.`,
      );
    }
    return mapped;
  }

  const ceiling = NUMERIC_CEILINGS[nativeScale];
  // A numeric string is accepted; a blank one is not. `Number("")` is 0, which
  // would turn "the extractor found nothing" into the worst possible score.
  const raw = typeof nativeScore === "number" ? nativeScore : String(nativeScore).trim();
  const value = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) {
    refuse(
      "nativeScore",
      `Score "${String(nativeScore)}" is not a number on the ${nativeScale} scale.`,
    );
  }
  if (value < 0 || value > ceiling) {
    refuse(
      "nativeScore",
      `Score ${value} is outside the ${nativeScale} scale's range (0-${ceiling}).`,
    );
  }

  return round2((value / ceiling) * 100);
}

/**
 * The verbatim form stored in `native_score`. A number keeps the shortest
 * round-tripping decimal form JS gives it; a string is trimmed and otherwise
 * left exactly as the source wrote it (`"B+"`, `"4.5"`), because the column
 * exists to preserve what was actually claimed.
 */
export function nativeScoreText(nativeScore: number | string): string {
  return typeof nativeScore === "number" ? String(nativeScore) : String(nativeScore).trim();
}
