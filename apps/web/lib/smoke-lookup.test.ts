import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { isUnresolvableSmoke } from "./smoke-lookup";

// Both smoke pages route their lookup failure through this predicate to decide
// notFound(). It has to be exactly wide enough: too narrow and a malformed id is
// a 500 again, too wide and a real fault is disguised as a missing page.

describe("isUnresolvableSmoke", () => {
  it("is true for BAD_REQUEST", () => {
    // The malformed-id case, and the reason the predicate exists: `.uuid()` on the
    // procedure input turns a non-uuid path segment into BAD_REQUEST, which
    // previously escaped the not-found path and surfaced as a 500.
    expect(isUnresolvableSmoke(new TRPCError({ code: "BAD_REQUEST" }))).toBe(true);
  });

  it("is true for NOT_FOUND", () => {
    expect(isUnresolvableSmoke(new TRPCError({ code: "NOT_FOUND" }))).toBe(true);
  });

  it("is false for a real fault", () => {
    // A failing database or an authorization refusal must keep its status; turning
    // either into a 404 would hide an outage behind a plausible-looking page.
    expect(isUnresolvableSmoke(new TRPCError({ code: "INTERNAL_SERVER_ERROR" }))).toBe(false);
    expect(isUnresolvableSmoke(new TRPCError({ code: "UNAUTHORIZED" }))).toBe(false);
  });

  it("is false for anything that is not a TRPCError", () => {
    expect(isUnresolvableSmoke(new Error("boom"))).toBe(false);
    expect(isUnresolvableSmoke(null)).toBe(false);
  });
});
