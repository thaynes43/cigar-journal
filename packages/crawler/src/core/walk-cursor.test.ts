import { describe, it, expect } from "vitest";
import { isWalkMode, mergeWalkCursor, readWalkCursor, walkCursorWrap, walkResume } from "./walk-cursor.js";

// The seed/offers resume position (#270). These are the two things the module is
// for: reading a column an operator can type into, and merging into a column two
// other lanes also write.
describe("the seed/offers walk cursor", () => {
  const A = "https://shop.test/a";
  const B = "https://shop.test/b";
  const C = "https://shop.test/c";
  const urls = [A, B, C];

  describe("reading a stored value", () => {
    it("reads this mode's entry and nothing else", () => {
      const stored = {
        archivePage: 87,
        seed: { lastUrl: A, total: 3, finishedAt: "2026-09-06T08:00:00.000Z" },
        offers: { lastUrl: B, total: 3, finishedAt: "2026-09-06T09:00:00.000Z" },
      };
      expect(readWalkCursor(stored, "offers")?.lastUrl).toBe(B);
      expect(readWalkCursor(stored, "seed")?.lastUrl).toBe(A);
    });

    it("treats an absent, unreadable or hand-mangled entry as the top", () => {
      // PARSED RATHER THAN CAST: seeding a lane by hand is how Small Batch gets
      // past its landing pages, and nothing a human can type may crash a run.
      expect(readWalkCursor(null, "offers")).toBeNull();
      expect(readWalkCursor({ archivePage: 87 }, "offers")).toBeNull();
      expect(readWalkCursor({ offers: 2124 }, "offers")).toBeNull();
      expect(readWalkCursor({ offers: { lastUrl: 2124 } }, "offers")).toBeNull();
      expect(readWalkCursor("offers", "offers")).toBeNull();
      // A wrap: the position is explicitly nothing, which is the top.
      expect(readWalkCursor({ offers: { lastUrl: null, total: 3 } }, "offers")).toEqual({
        lastUrl: null,
        total: 3,
        finishedAt: "",
      });
    });
  });

  describe("resolving the position against a fresh enumeration", () => {
    it("starts after the stored URL", () => {
      expect(walkResume(urls, { lastUrl: A, total: 3, finishedAt: "" })).toEqual({ index: 1, cursorUrl: A });
    });

    it("starts at the top with nothing stored, or after a completed pass", () => {
      expect(walkResume(urls, null)).toEqual({ index: 0 });
      expect(walkResume(urls, { lastUrl: null, total: 3, finishedAt: "" })).toEqual({ index: 0 });
    });

    it("starts over when the vendor has retired the stored URL", () => {
      // The whole reason the position is a URL and not an index: an index cannot
      // be checked against a sitemap that changed, and would silently walk past
      // whatever moved into its slot.
      expect(walkResume(urls, { lastUrl: "https://shop.test/gone", total: 3, finishedAt: "" })).toEqual({
        index: 0,
        cursorUrl: "https://shop.test/gone",
        missing: true,
      });
    });

    it("starts over when the stored URL is the last one there is", () => {
      // A completed pass writes a wrap rather than this, so it takes a hand-edited
      // value or a shrunken sitemap to get here. There is nothing after it either
      // way.
      expect(walkResume(urls, { lastUrl: C, total: 3, finishedAt: "" })).toEqual({ index: 0, cursorUrl: C });
    });
  });

  describe("writing it back", () => {
    it("merges into the stored value rather than replacing it", () => {
      const next = { lastUrl: C, total: 3, finishedAt: "2026-09-06T09:00:00.000Z" };
      expect(mergeWalkCursor({ archivePage: 87, seed: { lastUrl: A } }, "offers", next)).toEqual({
        archivePage: 87,
        seed: { lastUrl: A },
        offers: next,
      });
    });

    it("has nothing to preserve in a value nothing wrote", () => {
      const next = walkCursorWrap(3, "2026-09-06T09:00:00.000Z");
      expect(mergeWalkCursor(null, "offers", next)).toEqual({ offers: next });
      expect(next.lastUrl).toBeNull();
    });
  });

  it("names the two modes that walk an enumeration", () => {
    // `enrich` drains the gap-fill queue with targeted lookups; it has no position
    // and must never write one.
    expect(isWalkMode("seed")).toBe(true);
    expect(isWalkMode("offers")).toBe(true);
    expect(isWalkMode("enrich")).toBe(false);
  });
});
