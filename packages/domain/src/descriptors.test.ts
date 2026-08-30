import { describe, expect, it } from "vitest";
import { normalizeDescriptor, normalizeDescriptors, verbatimDescriptors } from "./descriptors.js";

// The stored form is the contract for search, analytics and the MCP payloads.
// The web `Chips` component reads a stored slug back as words for display
// (issue #49); these pin that the transform is presentation-only and that the
// round trip through storage is unchanged, so a label tweak can never leak into
// what the tools return.

describe("normalizeDescriptor", () => {
  it("kebab-cases multi-word descriptors", () => {
    expect(normalizeDescriptor("dark chocolate")).toBe("dark-chocolate");
    expect(normalizeDescriptor("white pepper")).toBe("white-pepper");
    expect(normalizeDescriptor("Graham Cracker")).toBe("graham-cracker");
  });

  it("round-trips the display form back to the stored form", () => {
    // Chips render `dark-chocolate` as "dark chocolate"; re-normalizing that
    // label must land on the identical stored value, or a chip read back into a
    // tool call would fork the vocabulary.
    for (const stored of ["dark-chocolate", "white-pepper", "toasted-almond", "leather"]) {
      expect(normalizeDescriptor(stored.replace(/-/g, " "))).toBe(stored);
    }
  });

  it("folds accents and drops what reduces to nothing", () => {
    expect(normalizeDescriptor("Café")).toBe("cafe");
    expect(normalizeDescriptor("  ---  ")).toBeNull();
  });
});

describe("normalizeDescriptors", () => {
  it("normalizes, dedupes and keeps order", () => {
    expect(normalizeDescriptors(["Dark Chocolate", "cedar", "dark-chocolate"])).toEqual([
      "dark-chocolate",
      "cedar",
    ]);
  });

  it("treats absence as empty", () => {
    expect(normalizeDescriptors(null)).toEqual([]);
    expect(normalizeDescriptors(undefined)).toEqual([]);
  });
});

describe("verbatimDescriptors", () => {
  it("keeps the user's exact words, hyphens included", () => {
    expect(verbatimDescriptors(["wet slate", " sun-dried hay ", "wet slate"])).toEqual([
      "wet slate",
      "sun-dried hay",
    ]);
  });
});
