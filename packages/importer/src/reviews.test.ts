import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseReviewPage } from "./reviews.js";
import { parseRatingCell, parseBrandIndexRatings } from "./ratings.js";
import { parseLegacyDate, stripTrailingDate } from "./dates.js";
import { buildSmokeInputs } from "./smoke-input.js";

const DOCS = fileURLToPath(new URL("./__fixtures__/archive/docs/", import.meta.url));
const read = (rel: string): string => readFileSync(DOCS + rel, "utf8");

describe("parseLegacyDate", () => {
  it("parses the two supported formats and rejects year-less / unknown", () => {
    expect(parseLegacyDate("11/16/2025")).toBe("2025-11-16");
    expect(parseLegacyDate("2025-11-14")).toBe("2025-11-14");
    expect(parseLegacyDate("10/31")).toBeNull(); // no year
    expect(parseLegacyDate("9/18")).toBeNull();
    expect(parseLegacyDate("2/30/2025")).toBeNull(); // calendar overflow
  });
  it("strips a trailing embedded date from a title", () => {
    expect(stripTrailingDate("Series B 11/16")).toBe("Series B");
    expect(stripTrailingDate("No 2")).toBe("No 2");
  });
});

describe("parseRatingCell", () => {
  it("accepts only unambiguous 0-100 integers; flags every other scale", () => {
    expect(parseRatingCell("82")).toMatchObject({ rating: 82, ambiguous: false });
    expect(parseRatingCell("100")).toMatchObject({ rating: 100, ambiguous: false });
    expect(parseRatingCell("9.3")).toMatchObject({ rating: null, ambiguous: true });
    expect(parseRatingCell("8/10")).toMatchObject({ rating: null, ambiguous: true });
    expect(parseRatingCell("10")).toMatchObject({ rating: null, ambiguous: true }); // 10-scale collision
    expect(parseRatingCell("8/*10")).toMatchObject({ rating: null, ambiguous: true });
    expect(parseRatingCell("-")).toMatchObject({ rating: null, ambiguous: false });
    expect(parseRatingCell("N/A")).toMatchObject({ rating: null, ambiguous: false });
  });
});

describe("parseBrandIndexRatings", () => {
  it("maps review filenames to their raw rating cell", () => {
    const ratings = parseBrandIndexRatings(read("nc-reviews/god-of-fire/index.md"));
    expect(ratings.get("series-b.md")).toBe("82");
  });
  it("tolerates prose around the table (davidoff) and reads the last column", () => {
    const ratings = parseBrandIndexRatings(read("nc-reviews/davidoff/index.md"));
    expect(ratings.get("yamasa.md")).toBe("9/10");
  });
});

describe("parseReviewPage", () => {
  it("parses a single-review page with an M/D/YYYY heading date", () => {
    const page = parseReviewPage(read("nc-reviews/god-of-fire/series-b.md"));
    expect(page.pageTitle).toBe("Series B 11/16");
    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0]).toMatchObject({
      reviewNumber: 1,
      vitolaRaw: "Double Robusto",
      dateRaw: "11/16/2025",
      smokedAtIso: "2025-11-16",
    });
    expect(page.reviews[0]!.originalMarkdown).toContain("## Review 1 - Double Robusto - 11/16/2025");
  });

  it("parses an ISO heading date", () => {
    const page = parseReviewPage(read("cc-reviews/montecristo/no-2.md"));
    expect(page.reviews[0]!.smokedAtIso).toBe("2025-11-14");
  });

  it("parses a multi-review page; year-less dates become null (unparseable)", () => {
    const page = parseReviewPage(read("nc-reviews/drew-estate/liga-privada-no-9.md"));
    expect(page.reviews.map((r) => r.reviewNumber)).toEqual([1, 2]);
    expect(page.reviews.every((r) => r.smokedAtIso === null)).toBe(true);
  });

  it("treats a placeholder vitola (??) as-is and leaves the date unparseable", () => {
    const page = parseReviewPage(read("nc-reviews/padron/1926-maduro.md"));
    expect(page.reviews).toHaveLength(2);
    expect(page.reviews[0]!.vitolaRaw).toBe("??");
    expect(page.reviews[0]!.smokedAtIso).toBeNull();
  });

  it("does NOT guess a misspelled '## Rview' heading — flags malformed (LFD quirk)", () => {
    const page = parseReviewPage(read("nc-reviews/la-flor-dominicana/la-nox.md"));
    expect(page.reviews).toHaveLength(0);
    expect(page.emptyReason).toBe("malformed-heading");
    expect(page.malformedHint).toContain("Rview 1");
  });

  it("flags a de-hashed 'Review 1' line (millennium) as malformed, not a review", () => {
    const page = parseReviewPage(read("nc-reviews/davidoff/millennium.md"));
    expect(page.reviews).toHaveLength(0);
    expect(page.emptyReason).toBe("malformed-heading");
  });

  it("classifies a 'Coming Soon' stub as an empty page, not needs-review", () => {
    const page = parseReviewPage(read("nc-reviews/davidoff/yamasa.md"));
    expect(page.reviews).toHaveLength(0);
    expect(page.emptyReason).toBe("stub");
  });
});

describe("buildSmokeInputs", () => {
  it("attaches a clean rating, day-precision date, and promotes the shared vitola to the cigar", () => {
    const built = buildSmokeInputs({
      relpath: "nc-reviews/god-of-fire/series-b.md",
      type: "NC",
      brandDisplay: "God of Fire",
      pageTitle: "Series B 11/16",
      reviews: parseReviewPage(read("nc-reviews/god-of-fire/series-b.md")).reviews,
      ratingRaw: "82",
    });
    expect(built.smokes).toHaveLength(1);
    const input = built.smokes[0]!.input;
    expect(built.smokes[0]!.canonicalName).toBe("God of Fire Series B"); // embedded date stripped
    expect(input.journal).toEqual({ title: "Series B 11/16", narrative: null }); // raw title, null narrative
    expect(input.assessment?.rating).toBe(82);
    expect(input.smokedAt).toEqual({ value: "2025-11-16", source: "legacy-document", precision: "day" });
    expect(input.provenance?.source).toBe("legacy-import");
    expect((input.cigar as { described: { vitola?: { name?: string } } }).described.vitola?.name).toBe("Double Robusto");
    expect(input.context).toEqual({ vitola: "Double Robusto" });
    expect(built.notes).toHaveLength(0);
  });

  it("does not attach an ambiguous-scale rating and does not promote a placeholder vitola", () => {
    const built = buildSmokeInputs({
      relpath: "nc-reviews/padron/1926-maduro.md",
      type: "NC",
      brandDisplay: "Padron",
      pageTitle: "1926 Maduro",
      reviews: parseReviewPage(read("nc-reviews/padron/1926-maduro.md")).reviews,
      ratingRaw: "10",
    });
    expect(built.smokes).toHaveLength(2);
    expect(built.smokes.every((s) => s.input.assessment === undefined)).toBe(true);
    expect(built.smokes.every((s) => s.input.context === undefined)).toBe(true);
    // one rating note + two unparseable-date notes
    expect(built.notes.filter((n) => n.reason.includes("rating"))).toHaveLength(1);
    expect(built.notes.filter((n) => n.reason.includes("smokedAt unknown"))).toHaveLength(2);
  });
});
