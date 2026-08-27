import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseCsv } from "./csv.js";
import { parseLedgerCsv, matchKey, type LedgerRow } from "./ledger-parse.js";

const CSV = fileURLToPath(
  new URL("./__fixtures__/archive/ledger/ledger-fixture.csv", import.meta.url),
);
const rows = parseLedgerCsv(readFileSync(CSV, "utf8"));
const byOrdinal = (n: number): LedgerRow => rows.find((r) => r.ordinal === n)!;

describe("parseCsv", () => {
  it("handles quoted fields, doubled-quote inch marks, and embedded commas", () => {
    const parsed = parseCsv('a,"6.0"" x 52","1 Month rest - ""RASS""",z\n');
    expect(parsed).toEqual([["a", '6.0" x 52', '1 Month rest - "RASS"', "z"]]);
  });

  it("flushes a final record with no trailing newline", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseLedgerCsv", () => {
  it("parses every data row with a 1-based ordinal", () => {
    expect(rows).toHaveLength(9);
    expect(rows[0]!.ordinal).toBe(1);
  });

  it("builds `<Brand> <Cigar>` canonical names and coerces size/date/qty", () => {
    const r = byOrdinal(1).purchase;
    expect(r.canonicalName).toBe("Drew Estate Liga Privada No. 9");
    expect(r.lengthInches).toBe(6);
    expect(r.ringGauge).toBe(52);
    expect(r.purchasedAt).toBe("2025-08-06");
    expect(r.quantity).toBe(2);
    expect(r.packaging).toBe("Loose");
  });

  it("keeps the 'Rockey Patel' typo literal and flags it for a curator merge", () => {
    const r = byOrdinal(3);
    expect(r.purchase.brand).toBe("Rockey Patel"); // literal, unchanged
    expect(r.purchase.brandDrift).toBe("Rocky Patel");
    expect(r.reviewNotes.some((n) => n.includes('brand drift "Rockey Patel"'))).toBe(true);
  });

  it("nulls Backordered/Stuck humidor data with a note", () => {
    expect(byOrdinal(4).purchase.humidorAt).toBeNull();
    expect(byOrdinal(4).reviewNotes.some((n) => n.includes("Backordered"))).toBe(true);
    expect(byOrdinal(5).purchase.humidorAt).toBeNull();
    expect(byOrdinal(5).reviewNotes.some((n) => n.includes("Stuck"))).toBe(true);
  });

  it("nulls a present-but-malformed size and flags it — never guesses", () => {
    const r = byOrdinal(6);
    expect(r.purchase.lengthInches).toBeNull();
    expect(r.purchase.ringGauge).toBeNull();
    expect(r.reviewNotes.some((n) => n.includes('malformed size "6.0" 2 52"'))).toBe(true);
  });

  it("nulls blank Vitola/Size on Cuban rows silently (no note)", () => {
    const r = byOrdinal(7);
    expect(r.purchase.vitola).toBeNull();
    expect(r.purchase.lengthInches).toBeNull();
    expect(r.purchase.ringGauge).toBeNull();
    expect(r.reviewNotes.some((n) => n.includes("size") || n.includes("vitola"))).toBe(false);
  });

  it("coerces a $-prefixed PPS to numeric and carries Aging verbatim into notes", () => {
    const r = byOrdinal(7).purchase;
    expect(r.pricePerStick).toBe("45");
    expect(r.notes).toBe('1 Month rest from travel - "RASS"');
  });

  it("treats brand '???' as unknown: brand nulled, cigar kept, flagged", () => {
    const r = byOrdinal(8);
    expect(r.purchase.brand).toBe("");
    expect(r.purchase.canonicalName).toBe("Vega Fina");
    expect(r.skipInsert).toBe(false);
    expect(r.reviewNotes.some((n) => n.includes('brand "???"'))).toBe(true);
  });

  it("flags '???' brand with no cigar name as skipInsert (creates nothing)", () => {
    const r = byOrdinal(9);
    expect(r.purchase.cigar).toBe("");
    expect(r.purchase.brand).toBe("");
    expect(r.skipInsert).toBe(true);
    expect(r.reviewNotes.some((n) => n.includes("no cigar name"))).toBe(true);
  });

  it("match key ignores fields outside name/date/qty/packaging (same cigar, diff date)", () => {
    const a = byOrdinal(1);
    const b = byOrdinal(2);
    expect(a.matchKey).not.toBe(b.matchKey); // same cigar, different date/qty/packaging
    expect(a.matchKey).toBe(
      matchKey("Drew Estate", "Liga Privada No. 9", "2025-08-06", 2, "Loose"),
    );
  });

  it("match key tolerates the brand/cigar column swap (Cuban half) but nothing else", () => {
    // Archive: cigar "No 3" / brand "Ramon Allones"; raw CSV swaps the columns.
    expect(matchKey("Ramon Allones", "No 3", "2025-10-17", 3, "Loose")).toBe(
      matchKey("No 3", "Ramon Allones", "2025-10-17", 3, "Loose"),
    );
    // A different mark is still a different purchase.
    expect(matchKey("Ramon Allones", "No 3", "2025-10-17", 3, "Loose")).not.toBe(
      matchKey("Ramon Allones", "No 2", "2025-10-17", 3, "Loose"),
    );
  });
});
