import { describe, expect, it } from "vitest";
import { shelfEarnsItsPlace } from "./shelves";

// DESIGN-003 §Shelves: a shelf is a lens on the grid, so it is absent both when
// it holds nothing and when it holds the whole grid (#219).
describe("the root shelf rule", () => {
  it("drops a shelf whose rows are the entire grid", () => {
    expect(shelfEarnsItsPlace(4, 4)).toBe(false);
  });

  it("keeps a shelf that narrows the grid", () => {
    expect(shelfEarnsItsPlace(3, 4)).toBe(true);
    expect(shelfEarnsItsPlace(12, 300)).toBe(true);
  });

  it("drops an empty shelf, including over an empty catalog", () => {
    expect(shelfEarnsItsPlace(0, 40)).toBe(false);
    expect(shelfEarnsItsPlace(0, 0)).toBe(false);
  });

  it("keeps a one-row lens on a catalog of more than one", () => {
    expect(shelfEarnsItsPlace(1, 2)).toBe(true);
    expect(shelfEarnsItsPlace(1, 1)).toBe(false);
  });
});
