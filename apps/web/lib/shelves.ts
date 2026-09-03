// The rule that decides whether a root shelf renders (DESIGN-003 §Shelves).
//
// A shelf is a lens on the grid beneath it. Two ways a lens fails to be one: it
// holds nothing (the Whiskybase rule — absent, never an empty strip), or it holds
// the entire grid, in which case the strip and the grid are the same rows twice
// (#219). Both are absence; neither is a placeholder.
//
// `rowCount` is the shelf's rows, `gridTotal` the unfiltered catalog total the
// grid renders. A shelf is capped (12), so the equality can only bite on a
// catalog small enough for the strip to be the whole grid.
export function shelfEarnsItsPlace(rowCount: number, gridTotal: number): boolean {
  return rowCount > 0 && rowCount !== gridTotal;
}
