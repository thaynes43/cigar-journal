import { describe, it, expect } from "vitest";
import { describeError } from "./errors.js";

// The line an operator reads at 02:00. Every case here is one the nightly fleet
// has actually produced or can produce; the first is the one that motivated the
// helper (2026-09-07, 2 Guys, an expired TLS certificate reported as `fetch
// failed`).

describe("describeError", () => {
  it("names the transport fault Node's fetch hides on `cause`", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
    });

    expect(describeError(error)).toBe("fetch failed (CERT_HAS_EXPIRED: certificate has expired)");
  });

  it("falls back to the cause's message when it carries no code", () => {
    expect(describeError(new Error("write failed", { cause: new Error("connection terminated") }))).toBe(
      "write failed (connection terminated)",
    );
  });

  it("chains nested causes inward", () => {
    const inner = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const middle = new Error("socket hang up", { cause: inner });
    expect(describeError(new TypeError("fetch failed", { cause: middle }))).toBe(
      "fetch failed (socket hang up (ECONNRESET: read ECONNRESET))",
    );
  });

  it("stops at the depth cap rather than rendering an unbounded chain", () => {
    // Seven links; the cap admits five causes and drops the rest.
    let error = new Error("c7");
    for (let i = 6; i >= 1; i--) error = new Error(`c${i}`, { cause: error });
    expect(describeError(error)).toBe("c1 (c2 (c3 (c4 (c5 (c6)))))");
  });

  it("terminates on a self-referential cause", () => {
    const error: Error & { cause?: unknown } = new Error("boom");
    error.cause = error;
    expect(describeError(error)).toBe("boom");
  });

  it("terminates on a cause cycle between two errors", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b", { cause: a });
    a.cause = b;
    expect(describeError(a)).toBe("a (b)");
  });

  it("stringifies a non-Error, exactly as the helpers it replaced did", () => {
    expect(describeError("just a string")).toBe("just a string");
    expect(describeError(42)).toBe("42");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("renders a non-object cause and a numeric code", () => {
    expect(describeError(new Error("threw", { cause: "a bare string" }))).toBe("threw (a bare string)");
    expect(describeError(new Error("query failed", { cause: Object.assign(new Error("timeout"), { code: 110 }) }))).toBe(
      "query failed (110: timeout)",
    );
  });

  it("leaves an error with no cause exactly as it was", () => {
    expect(describeError(new Error("robots.txt disallows /"))).toBe("robots.txt disallows /");
  });
});
