import { describe, it, expect } from "vitest";
import { isUniqueViolation } from "./idempotency.js";

describe("isUniqueViolation", () => {
  it("matches a bare driver error", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  // The shape drizzle actually throws: DrizzleQueryError carries the query and
  // params, and only its `cause` is the pg error with the code. Reading the top
  // level alone left every concurrent-first-writer replay branch dead.
  it("matches the pg error through a drizzle wrapper", () => {
    const wrapped = new Error("Failed query: insert into ...", { cause: { code: "23505" } });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("matches through several cause hops", () => {
    const inner = new Error("insert failed", { cause: { code: "23505" } });
    expect(isUniqueViolation(new Error("outer", { cause: inner }))).toBe(true);
  });

  it("rejects other errors, wrapped or not", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("boom", { cause: { code: "23503" } }))).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
