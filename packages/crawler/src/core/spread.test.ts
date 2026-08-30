import { describe, it, expect } from "vitest";
import { spreadIndices, edgeSpreadIndices } from "./spread.js";

describe("spreadIndices", () => {
  it("returns nothing for an empty list or a zero request", () => {
    expect(spreadIndices(0, 3)).toEqual([]);
    expect(spreadIndices(10, 0)).toEqual([]);
    expect(spreadIndices(-1, 3)).toEqual([]);
  });

  it("dedupes when it is asked for more picks than there are entries", () => {
    expect(spreadIndices(1, 3)).toEqual([0]);
    expect(spreadIndices(2, 3)).toEqual([0, 1]);
    expect(spreadIndices(3, 3)).toEqual([0, 1, 2]);
  });

  it("spreads across a large list", () => {
    // 1,462 is 2 Guys' live /store/ loc count (2026-08-29).
    expect(spreadIndices(1462, 3)).toEqual([243, 731, 1218]);
    expect(spreadIndices(5, 2)).toEqual([1, 3]);
  });

  it("never picks index 0 once the list is at least twice the sample count", () => {
    for (const total of [6, 7, 20, 100, 985, 1462, 6356]) {
      const picks = spreadIndices(total, 3);
      expect(picks[0]).toBeGreaterThan(0);
    }
  });

  it("returns unique ascending in-range indices", () => {
    for (const [total, want] of [
      [1462, 3],
      [7, 3],
      [4, 3],
      [50, 8],
      [9, 4],
    ] as const) {
      const picks = spreadIndices(total, want);
      expect(picks.length).toBeLessThanOrEqual(want);
      expect(new Set(picks).size).toBe(picks.length);
      expect([...picks].sort((a, b) => a - b)).toEqual(picks);
      for (const index of picks) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(total);
      }
    }
  });
});

describe("edgeSpreadIndices", () => {
  it("returns nothing for an empty list or a zero request", () => {
    expect(edgeSpreadIndices(0, 3)).toEqual([]);
    expect(edgeSpreadIndices(10, 0)).toEqual([]);
    expect(edgeSpreadIndices(-1, 3)).toEqual([]);
  });

  // The regression this exists for: the midpoint spread cannot reach either end
  // of a sitemapindex once it has a handful of children, so a vendor whose
  // products live in the first or last child probes as needs-attention.
  it("reaches the ends the midpoint spread cannot", () => {
    expect(spreadIndices(7, 3)).toEqual([1, 3, 5]); // child 0 and child 6 unreachable
    expect(edgeSpreadIndices(7, 3)).toEqual([0, 3, 6]);
    expect(spreadIndices(8, 3)).toEqual([1, 4, 6]);
    expect(edgeSpreadIndices(8, 3)).toEqual([0, 4, 7]);
    expect(edgeSpreadIndices(20, 3)).toEqual([0, 10, 19]);
  });

  // Stated for two or more picks only: with one there is no second end to
  // include, and edgeSpreadIndices(n, 1) is [0]. Callers that need both ends
  // regardless of budget have to reserve the slots themselves — selectIndexChildren
  // does, and pins the guarantee in its own tests.
  it("includes the first and last entry whenever it is asked for two or more", () => {
    for (const total of [2, 4, 6, 7, 8, 20, 100, 985]) {
      for (const want of [2, 3, 4]) {
        const picks = edgeSpreadIndices(total, want);
        expect(picks[0]).toBe(0);
        expect(picks[picks.length - 1]).toBe(total - 1);
      }
    }
  });

  it("dedupes when it is asked for more picks than there are entries", () => {
    expect(edgeSpreadIndices(1, 3)).toEqual([0]);
    expect(edgeSpreadIndices(2, 3)).toEqual([0, 1]);
    expect(edgeSpreadIndices(3, 3)).toEqual([0, 1, 2]);
    expect(edgeSpreadIndices(4, 3)).toEqual([0, 2, 3]);
    // A single pick takes the head — there is no second end to include.
    expect(edgeSpreadIndices(5, 1)).toEqual([0]);
  });

  it("returns unique ascending in-range indices", () => {
    for (const [total, want] of [
      [1462, 3],
      [7, 3],
      [4, 3],
      [50, 8],
      [9, 4],
    ] as const) {
      const picks = edgeSpreadIndices(total, want);
      expect(picks.length).toBeLessThanOrEqual(want);
      expect(new Set(picks).size).toBe(picks.length);
      expect([...picks].sort((a, b) => a - b)).toEqual(picks);
      for (const index of picks) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(total);
      }
    }
  });
});
