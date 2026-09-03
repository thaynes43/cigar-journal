import { describe, it, expect } from "vitest";
import {
  deriveDurationMinutes,
  withinSmokeWindow,
  stampSmokeTiming,
  MAX_SMOKE_DURATION_HOURS,
} from "./mapping.js";

// The pure half of ADR-016. `deriveDurationMinutes` is the SINGLE derivation
// behind every read — get_smoke, the journal summaries, the public detail and
// the save result all call it — so its edges are pinned here rather than
// re-asserted through Postgres in each read's test.

const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-02T02:20:00.000Z");
const now = () => NOW;

describe("deriveDurationMinutes", () => {
  it("is the whole minutes between two present bounds", () => {
    // The session ADR-016 was written from: drop opened 01:04Z, saved at 02:20Z.
    expect(deriveDurationMinutes(at("2026-09-02T01:04:00Z"), at("2026-09-02T02:20:00Z"))).toBe(76);
  });

  it("accepts ISO strings as readily as Dates", () => {
    expect(deriveDurationMinutes("2026-09-02T01:04:00Z", "2026-09-02T02:20:00Z")).toBe(76);
  });

  it("is null when either bound is missing", () => {
    expect(deriveDurationMinutes(null, at("2026-09-02T02:20:00Z"))).toBeNull();
    expect(deriveDurationMinutes(at("2026-09-02T01:04:00Z"), null)).toBeNull();
    expect(deriveDurationMinutes(null, null)).toBeNull();
    expect(deriveDurationMinutes(undefined, undefined)).toBeNull();
  });

  it("is null when either bound is unparseable", () => {
    expect(deriveDurationMinutes("not a date", at("2026-09-02T02:20:00Z"))).toBeNull();
    expect(deriveDurationMinutes(at("2026-09-02T01:04:00Z"), "not a date")).toBeNull();
  });

  it("is null when the span is negative — an end before its start vouches for nothing", () => {
    expect(deriveDurationMinutes(at("2026-09-02T02:20:00Z"), at("2026-09-02T01:04:00Z"))).toBeNull();
  });

  it("allows exactly twelve hours and refuses a minute more", () => {
    const start = at("2026-09-02T00:00:00Z");
    const twelve = at("2026-09-02T12:00:00Z");
    const over = at("2026-09-02T12:01:00Z");
    expect(MAX_SMOKE_DURATION_HOURS).toBe(12);
    expect(deriveDurationMinutes(start, twelve)).toBe(12 * 60);
    expect(deriveDurationMinutes(start, over)).toBeNull();
  });

  it("is null under a minute — never 0m", () => {
    const start = at("2026-09-02T01:04:00Z");
    expect(deriveDurationMinutes(start, start)).toBeNull();
    expect(deriveDurationMinutes(start, at("2026-09-02T01:04:59Z"))).toBeNull();
    expect(deriveDurationMinutes(start, at("2026-09-02T01:05:00Z"))).toBe(1);
  });
});

describe("withinSmokeWindow", () => {
  it("admits an observation inside the window and refuses one outside it", () => {
    const end = at("2026-09-02T02:20:00Z");
    expect(withinSmokeWindow(at("2026-09-02T01:04:00Z"), end)).toBe(true);
    expect(withinSmokeWindow(at("2026-09-01T14:20:00Z"), end)).toBe(true); // exactly 12h
    expect(withinSmokeWindow(at("2026-09-01T14:19:00Z"), end)).toBe(false); // 12h 1m
    // A reused, day-old drop is the case the guard exists for.
    expect(withinSmokeWindow(at("2026-09-01T02:50:00Z"), end)).toBe(false);
  });

  it("refuses when there is no end to judge the observation against", () => {
    expect(withinSmokeWindow(at("2026-09-02T01:04:00Z"), null)).toBe(false);
  });
});

describe("stampSmokeTiming", () => {
  it("stamps the end and files the entry under the observed start", () => {
    const observed = at("2026-09-02T01:04:00Z");
    const stamp = stampSmokeTiming({}, "llm-conversation", now, observed);

    expect(stamp.startedAt).toEqual({ value: observed.toISOString(), source: "photo-drop" });
    expect(stamp.endedAt).toEqual({ value: NOW.toISOString(), source: "system-finalized" });
    // ADR-002 as amended: the journal date is when it was lit, and the stamp
    // stays system-finalized because the server is the one observing it.
    expect(stamp.smokedAt).toEqual({
      value: observed.toISOString(),
      source: "system-finalized",
      precision: "approximate",
    });
  });

  it("takes a user-stated start as the smoked-at, with user provenance", () => {
    const stamp = stampSmokeTiming(
      { startedAt: { value: "2026-09-02T01:04:00Z" } },
      "llm-conversation",
      now,
    );
    expect(stamp.startedAt).toEqual({ value: "2026-09-02T01:04:00.000Z", source: "user" });
    expect(stamp.smokedAt).toEqual({
      value: "2026-09-02T01:04:00.000Z",
      source: "user",
      precision: "minute",
    });
    expect(stamp.endedAt).toEqual({ value: NOW.toISOString(), source: "system-finalized" });
  });

  it("gives no end to a save that states when the smoke happened", () => {
    const stamp = stampSmokeTiming(
      { smokedAt: { value: "2026-08-30T20:00:00Z" } },
      "llm-conversation",
      now,
      at("2026-08-30T19:30:00Z"),
    );
    expect(stamp.endedAt).toBeNull();
    expect(stamp.smokedAt.value).toBe("2026-08-30T20:00:00.000Z");
    // The observation still lands: it is inside the window from the stated time.
    expect(stamp.startedAt).toEqual({ value: "2026-08-30T19:30:00.000Z", source: "photo-drop" });
  });

  it("never lets an observation overwrite what the user stated", () => {
    const stamp = stampSmokeTiming(
      { startedAt: { value: "2026-09-02T01:30:00Z" }, endedAt: { value: "2026-09-02T02:10:00Z" } },
      "llm-conversation",
      now,
      at("2026-09-02T01:04:00Z"),
    );
    expect(stamp.startedAt).toEqual({ value: "2026-09-02T01:30:00.000Z", source: "user" });
    expect(stamp.endedAt).toEqual({ value: "2026-09-02T02:10:00.000Z", source: "user" });
  });

  it("drops an observation more than twelve hours before the end", () => {
    // The drop the 2026-09-02 save claimed was created 23 hours earlier; if the
    // session stamp were ever that stale, it is not this smoke's start.
    const stamp = stampSmokeTiming({}, "llm-conversation", now, at("2026-09-01T02:50:00Z"));
    expect(stamp.startedAt).toBeNull();
    expect(stamp.smokedAt.value).toBe(NOW.toISOString());
  });

  it("leaves an import's absent time unknown and takes no bounds", () => {
    const stamp = stampSmokeTiming({}, "legacy-import", now, at("2026-09-02T01:04:00Z"));
    expect(stamp.smokedAt).toEqual({ value: null, source: "unknown", precision: null });
    expect(stamp.startedAt).toBeNull();
    expect(stamp.endedAt).toBeNull();
  });
});
