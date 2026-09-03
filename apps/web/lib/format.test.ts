import { describe, it, expect } from "vitest";
import { formatDuration } from "./format";

// ADR-016 fixes the rendered shapes of a smoke's length ("1h 16m", "45m", "2h")
// and, just as firmly, what must never appear: "0m", a raw minute count, or a
// span the derivation could not vouch for. The derivation itself already refuses
// a bad pair by handing over null, so this function's whole job is the seam
// between "a length exists" and "say nothing" — which is what these cases pin.

describe("formatDuration", () => {
  it("renders hours and minutes together", () => {
    // The ADR's worked example: the 2026-09-02 Padrón session, 01:04Z to 02:20Z.
    expect(formatDuration(76)).toBe("1h 16m");
  });

  it("drops the hours under an hour", () => {
    // "0h 45m" would read as a stopwatch reading rather than a smoke's length.
    expect(formatDuration(45)).toBe("45m");
  });

  it("drops the minutes on a whole hour", () => {
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(120)).toBe("2h");
  });

  it("floors a fractional value to whole minutes", () => {
    // Seconds are noise at this granularity, and rounding up could claim a minute
    // the two instants do not support.
    expect(formatDuration(45.9)).toBe("45m");
    expect(formatDuration(119.5)).toBe("1h 59m");
  });

  it("says nothing when there is no duration to state", () => {
    // Null in, null out: an unknown bound is unknown, and the header renders the
    // date alone rather than an empty separator.
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
  });

  it("says nothing for a non-positive span", () => {
    // A zero or inverted span is a contradiction, not a short smoke; "0m" would
    // assert a length the data disproves.
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(-30)).toBeNull();
  });

  it("says nothing for a sub-minute span", () => {
    // Positive but flooring to zero — the case that would otherwise slip past the
    // <= 0 guard and render the forbidden "0m".
    expect(formatDuration(0.5)).toBeNull();
  });

  it("says nothing for a non-finite value", () => {
    // Arithmetic on a bad instant yields NaN rather than throwing, so the guard
    // has to catch it here instead of letting "NaNm" reach the header.
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});
