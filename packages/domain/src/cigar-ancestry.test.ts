import { describe, it, expect } from "vitest";
import { assertCigarAncestry, checkCigarAncestry } from "./cigar-ancestry.js";
import { ValidationError } from "./errors.js";

// The invariant migration 0026 deliberately does NOT enforce in SQL: a cigar's
// line must belong to its brand, and its blend to its line (ADR-012). Every
// write path that sets those columns calls this, so the rules are pinned here.

const BRAND_A = "11111111-1111-1111-1111-111111111111";
const BRAND_B = "22222222-2222-2222-2222-222222222222";
const LINE_A = "33333333-3333-3333-3333-333333333333";
const LINE_B = "44444444-4444-4444-4444-444444444444";
const BLEND_A = "55555555-5555-5555-5555-555555555555";

const lineA = { id: LINE_A, brandId: BRAND_A };
const lineB = { id: LINE_B, brandId: BRAND_B };
const blendA = { id: BLEND_A, lineId: LINE_A };

const paths = (errors: { path: string }[]): string[] => errors.map((e) => e.path);

describe("cigar ancestry", () => {
  describe("what is allowed", () => {
    // Nothing is invented: a cigar whose ancestry is entirely unknown is a
    // perfectly valid row, and stays that way until someone learns more.
    it("accepts a fully unknown ancestry", () => {
      expect(checkCigarAncestry({ brandId: null, lineId: null, blendId: null })).toEqual([]);
    });

    // The 565 unbranded production rows become these once Wave 3 attaches them:
    // brand known, line not. ADR-012 requires this to be representable.
    it("accepts a brand with no line — the cigar hangs off its brand", () => {
      expect(checkCigarAncestry({ brandId: BRAND_A, lineId: null, blendId: null })).toEqual([]);
    });

    it("accepts a brand and a line that belongs to it", () => {
      expect(
        checkCigarAncestry({ brandId: BRAND_A, lineId: LINE_A, blendId: null }, { line: lineA }),
      ).toEqual([]);
    });

    it("accepts a full brand → line → blend chain", () => {
      expect(
        checkCigarAncestry(
          { brandId: BRAND_A, lineId: LINE_A, blendId: BLEND_A },
          { line: lineA, blend: blendA },
        ),
      ).toEqual([]);
    });
  });

  describe("what is rejected", () => {
    // The failure the flat model made easy and this rule makes impossible:
    // borrowing another brand's line.
    it("rejects a line belonging to a different brand", () => {
      const errors = checkCigarAncestry(
        { brandId: BRAND_A, lineId: LINE_B, blendId: null },
        { line: lineB },
      );
      expect(paths(errors)).toEqual(["lineId"]);
      expect(errors[0]!.message).toMatch(/different brand/);
    });

    it("rejects a blend belonging to a different line", () => {
      const errors = checkCigarAncestry(
        { brandId: BRAND_A, lineId: LINE_B, blendId: BLEND_A },
        { line: { ...lineB, brandId: BRAND_A }, blend: blendA },
      );
      expect(paths(errors)).toEqual(["blendId"]);
      expect(errors[0]!.message).toMatch(/different line/);
    });

    // A line carries a brand on its own row, so naming a line without a brand is
    // not partial knowledge — it is a contradiction.
    it("rejects a line with no brand", () => {
      const errors = checkCigarAncestry({ brandId: null, lineId: LINE_A, blendId: null }, { line: lineA });
      expect(paths(errors)).toEqual(["brandId"]);
    });

    // `blends.line_id` is NOT NULL, so a known blend always supplies a line.
    it("rejects a blend with no line", () => {
      const errors = checkCigarAncestry(
        { brandId: BRAND_A, lineId: null, blendId: BLEND_A },
        { blend: blendA },
      );
      expect(paths(errors)).toContain("lineId");
    });

    // A caller that cannot load the row it is asserting has not verified
    // anything, so an unresolved level is a violation rather than a pass.
    it("rejects an unresolvable line or blend", () => {
      expect(paths(checkCigarAncestry({ brandId: BRAND_A, lineId: LINE_A, blendId: null }))).toEqual([
        "lineId",
      ]);
      expect(
        paths(checkCigarAncestry({ brandId: BRAND_A, lineId: LINE_A, blendId: BLEND_A }, { line: lineA })),
      ).toEqual(["blendId"]);
    });

    it("rejects a context row whose id is not the one referenced", () => {
      const errors = checkCigarAncestry(
        { brandId: BRAND_A, lineId: LINE_A, blendId: null },
        { line: { id: LINE_B, brandId: BRAND_A } },
      );
      expect(paths(errors)).toEqual(["lineId"]);
      expect(errors[0]!.message).toMatch(/does not match/);
    });

    // Both levels wrong reports both, so a caller fixes one round-trip, not two.
    it("reports every level at fault at once", () => {
      const errors = checkCigarAncestry({ brandId: null, lineId: LINE_A, blendId: BLEND_A });
      expect(paths(errors).sort()).toEqual(["blendId", "brandId", "lineId"]);
    });
  });

  describe("assertCigarAncestry", () => {
    it("returns silently on a consistent ancestry", () => {
      expect(() =>
        assertCigarAncestry({ brandId: BRAND_A, lineId: LINE_A, blendId: BLEND_A }, { line: lineA, blend: blendA }),
      ).not.toThrow();
    });

    // The surfaces need the offending field, not just a failure — it rides on
    // the existing validation_error code rather than a new contract code.
    it("throws a ValidationError naming the level at fault", () => {
      let thrown: unknown;
      try {
        assertCigarAncestry({ brandId: BRAND_A, lineId: LINE_B, blendId: null }, { line: lineB });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      const payload = (thrown as ValidationError).toPayload();
      expect(payload.code).toBe("validation_error");
      expect(payload.fields).toEqual([
        { path: "lineId", message: "The line belongs to a different brand than the cigar." },
      ]);
    });
  });
});
