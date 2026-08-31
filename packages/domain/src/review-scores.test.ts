import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  normalizeReviewScore,
  nativeScoreText,
  isReviewScale,
  REVIEW_SCALES,
  LETTER_GRADE_ORDER,
} from "./review-scores.js";
import { ValidationError } from "./errors.js";

// The review-score normalization convention (ADR-013 §2). Table-driven, because
// the mapping IS a table and the only way to review it is to read it as one.
//
// Two properties matter more than any individual number. Monotonicity: a worse
// grade must never normalize higher than a better one, which is the one defect
// here that no aggregate downstream could reveal — an inverted grade would just
// look like a reviewer who liked it. And refusal: an unrecognized scale must
// raise rather than pass a plausible-looking number into a mean, because once
// averaged a misread score is indistinguishable from a real one.
describe("review score normalization", () => {
  describe("numeric scales", () => {
    const cases: { scale: string; native: number | string; expected: number }[] = [
      // 0-100 is the identity, including both ends.
      { scale: "0-100", native: 0, expected: 0 },
      { scale: "0-100", native: 91, expected: 91 },
      { scale: "0-100", native: 100, expected: 100 },
      { scale: "0-100", native: 88.5, expected: 88.5 },
      // A numeric string is accepted: an extractor that pulled "91" off a page
      // has no reason to have parsed it first.
      { scale: "0-100", native: "91", expected: 91 },
      { scale: "0-100", native: " 91 ", expected: 91 },
      // 0-10, the common long-form review scale, including a tenth-step.
      { scale: "0-10", native: 10, expected: 100 },
      { scale: "0-10", native: 8.7, expected: 87 },
      { scale: "0-10", native: 0, expected: 0 },
      // Stars, including the half-star every star widget emits.
      { scale: "0-5-stars", native: 5, expected: 100 },
      { scale: "0-5-stars", native: 4.5, expected: 90 },
      { scale: "0-5-stars", native: 3, expected: 60 },
      // An odd native value keeps two decimals rather than being rounded to an
      // integer, which is the whole reason the column is numeric(5,2).
      { scale: "0-5-stars", native: 3.33, expected: 66.6 },
      { scale: "0-10", native: 7.77, expected: 77.7 },
    ];

    for (const { scale, native, expected } of cases) {
      it(`maps ${JSON.stringify(native)} on ${scale} to ${expected}`, () => {
        expect(normalizeReviewScore(scale, native)).toBe(expected);
      });
    }
  });

  describe("letter grades", () => {
    const cases: { native: string; expected: number }[] = [
      { native: "A+", expected: 100 },
      { native: "A", expected: 95 },
      { native: "A-", expected: 90 },
      { native: "B+", expected: 87 },
      { native: "B", expected: 85 },
      { native: "B-", expected: 80 },
      { native: "C+", expected: 77 },
      { native: "C", expected: 75 },
      { native: "C-", expected: 70 },
      { native: "D+", expected: 67 },
      { native: "D", expected: 65 },
      { native: "D-", expected: 60 },
      { native: "F", expected: 50 },
    ];

    for (const { native, expected } of cases) {
      it(`maps ${native} to ${expected}`, () => {
        expect(normalizeReviewScore("letter", native)).toBe(expected);
      });
    }

    it("is monotone: no worse grade scores higher than a better one", () => {
      const values = LETTER_GRADE_ORDER.map((grade) => normalizeReviewScore("letter", grade));
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i - 1]!).toBeGreaterThan(values[i]!);
      }
    });

    it("accepts the case and dash typography a CMS actually emits", () => {
      // Case is formatting and the dash class is typography; neither changes
      // which grade the reviewer gave.
      expect(normalizeReviewScore("letter", "b+")).toBe(87);
      expect(normalizeReviewScore("letter", " A- ")).toBe(90);
      expect(normalizeReviewScore("letter", "A–")).toBe(90); // en dash
      expect(normalizeReviewScore("letter", "A−")).toBe(90); // minus sign
      expect(normalizeReviewScore("letter", "A‑")).toBe(90); // non-breaking hyphen
    });

    it("refuses a grade outside the table rather than inventing a place for it", () => {
      // E is not in the US letter table this convention transcribes. Guessing it
      // sits between D- and F would be inventing a claim the reviewer never made.
      expect(() => normalizeReviewScore("letter", "E")).toThrow(ValidationError);
      expect(() => normalizeReviewScore("letter", "A++")).toThrow(ValidationError);
      expect(() => normalizeReviewScore("letter", "")).toThrow(ValidationError);
    });
  });

  describe("refusals", () => {
    it("refuses an unknown scale instead of guessing a ceiling", () => {
      // A reviewer scoring out of 20 is not a reviewer scoring out of 100 with a
      // low ceiling. Treating 17 as 17/100 would poison every aggregate above it.
      expect(() => normalizeReviewScore("0-20", 17)).toThrow(ValidationError);
      expect(() => normalizeReviewScore("stars", 4)).toThrow(ValidationError);
      expect(() => normalizeReviewScore("", 4)).toThrow(ValidationError);
    });

    it("names the offending field so a caller can fix it", () => {
      try {
        normalizeReviewScore("0-20", 17);
        expect.unreachable("should have refused");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).fields[0]!.path).toBe("nativeScale");
      }
      try {
        normalizeReviewScore("0-10", 11);
        expect.unreachable("should have refused");
      } catch (error) {
        expect((error as ValidationError).fields[0]!.path).toBe("nativeScore");
      }
    });

    it("refuses a score outside the scale's range", () => {
      expect(() => normalizeReviewScore("0-100", 101)).toThrow(ValidationError);
      expect(() => normalizeReviewScore("0-100", -1)).toThrow(ValidationError);
      expect(() => normalizeReviewScore("0-10", 10.5)).toThrow(ValidationError);
      expect(() => normalizeReviewScore("0-5-stars", 6)).toThrow(ValidationError);
    });

    it("refuses a non-number on a numeric scale, including the empty string", () => {
      // `Number("")` is 0, which would silently turn "the extractor found
      // nothing" into the worst possible score.
      expect(() => normalizeReviewScore("0-100", "")).toThrow(ValidationError);
      expect(() => normalizeReviewScore("0-100", "   ")).toThrow(ValidationError);
      expect(() => normalizeReviewScore("0-100", "ninety-one")).toThrow(ValidationError);
      expect(() => normalizeReviewScore("0-100", Number.NaN)).toThrow(ValidationError);
      expect(() => normalizeReviewScore("0-100", Number.POSITIVE_INFINITY)).toThrow(
        ValidationError,
      );
    });
  });

  it("keeps the native score verbatim, because that is what was actually claimed", () => {
    expect(nativeScoreText("B+")).toBe("B+");
    expect(nativeScoreText(" 4.5 ")).toBe("4.5");
    expect(nativeScoreText(91)).toBe("91");
  });

  it("isReviewScale admits exactly the known scales", () => {
    for (const scale of REVIEW_SCALES) expect(isReviewScale(scale)).toBe(true);
    expect(isReviewScale("0-20")).toBe(false);
  });

  // The drift test. `REVIEW_SCALES` and the CHECK on
  // `review_observations.native_scale` are two spellings of one list, and they are
  // duplicated on purpose — a scale the code cannot normalize must also be a row
  // the database cannot hold. Duplication is only safe while something notices
  // when the copies part.
  it("agrees with migration 0028's native_scale CHECK", () => {
    const migration = readFileSync(
      fileURLToPath(new URL("../../db/migrations/0028_review_observations.sql", import.meta.url)),
      "utf8",
    );
    const check = /CHECK \(native_scale IN \(([^)]*)\)\)/.exec(migration);
    expect(check, "0028 must still CHECK native_scale against a literal list").toBeTruthy();
    const inSql = check![1]!
      .split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""))
      .sort();
    expect(inSql).toEqual([...REVIEW_SCALES].sort());
  });
});
