import { describe, expect, it } from "vitest";
import { columnIsPresent, presentColumns } from "./table-columns";

interface Lot {
  vendor: string | null;
  boxDate: string | null;
}

const VENDOR = { header: "Vendor", value: (lot: Lot) => lot.vendor };
const BOX_DATE = { header: "Box date", value: (lot: Lot) => lot.boxDate };
const QTY = { header: "Qty", always: true, value: () => null };

describe("the absent-when-empty column predicate", () => {
  it("drops a column no row carries a value for", () => {
    const rows: Lot[] = [
      { vendor: null, boxDate: null },
      { vendor: null, boxDate: "2024-03-01" },
    ];
    expect(columnIsPresent(VENDOR, rows)).toBe(false);
    expect(columnIsPresent(BOX_DATE, rows)).toBe(true);
  });

  it("keeps a column one row carries a value for", () => {
    expect(columnIsPresent(VENDOR, [{ vendor: "Cigars Direct", boxDate: null }])).toBe(true);
  });

  it("drops every value-bearing column when there are no rows at all", () => {
    expect(columnIsPresent(VENDOR, [])).toBe(false);
    expect(columnIsPresent(QTY, [])).toBe(true);
  });

  it("keeps an `always` column whatever the rows say", () => {
    expect(columnIsPresent(QTY, [{ vendor: null, boxDate: null }])).toBe(true);
  });

  it("returns the present columns in declaration order", () => {
    const rows: Lot[] = [{ vendor: null, boxDate: "2024-03-01" }];
    expect(presentColumns([QTY, VENDOR, BOX_DATE], rows).map((c) => c.header)).toEqual([
      "Qty",
      "Box date",
    ]);
  });

  it("reads zero and the empty string as values, only null and undefined as absent", () => {
    const identity = { value: (v: unknown) => v };
    expect(columnIsPresent(identity, [0])).toBe(true);
    expect(columnIsPresent(identity, [""])).toBe(true);
    expect(columnIsPresent(identity, [null])).toBe(false);
    expect(columnIsPresent(identity, [undefined])).toBe(false);
  });
});
