import { describe, it, expect, expectTypeOf } from "vitest";

// Placeholder proving the vitest wiring — replaced by real aggregate tests in
// the domain-model slice. The type assertion exercises `expectTypeOf` so the
// type-level test surface is confirmed available too.
describe("@cj/domain scaffold", () => {
  it("runs under vitest", () => {
    expect(true).toBe(true);
  });

  it("exposes vitest's type assertions", () => {
    expectTypeOf<string>().toEqualTypeOf<string>();
  });
});
