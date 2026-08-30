import { describe, it, expect } from "vitest";
import { spreadIndices } from "./spread.js";

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
