import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parsePurchaseHistory, type ParsedPurchase } from "./purchases-parse.js";

const DOCS = fileURLToPath(new URL("./__fixtures__/archive/docs/", import.meta.url));
const rows = parsePurchaseHistory(readFileSync(DOCS + "purchase-history.md", "utf8"));
const byCigar = (name: string): ParsedPurchase => rows.find((r) => r.cigar === name)!;

describe("parsePurchaseHistory", () => {
  it("parses every data row", () => {
    expect(rows).toHaveLength(12);
    expect(rows[0]!.rowNumber).toBe(1);
  });

  it("builds `<Brand> <Cigar>` canonical names and parses size / price / dates", () => {
    const r = byCigar("Siglo VI");
    expect(r.canonicalName).toBe("Cohiba Siglo VI");
    expect(r.lengthInches).toBe(5.9);
    expect(r.ringGauge).toBe(52);
    expect(r.pricePerStick).toBe("15.00");
    expect(r.purchasedAt).toBe("2025-08-23");
    expect(r.boxDate).toBe("2024-12-01");
    expect(r.retailer).toBe("RSVP");
  });

  it("nulls the plain empty marker (-) silently — no note", () => {
    const r = byCigar("Liga Privada No. 9");
    expect(r.retailer).toBe("Fox");
    expect(r.pricePerStick).toBeNull();
    expect(r.boxDate).toBeNull();
    expect(r.placeholderNotes).toHaveLength(0);
  });

  it("nulls flagged placeholders (Backordered/Stuck/TBD/Misc) with a note", () => {
    expect(byCigar("Eastern Standard Sungrown").humidorAt).toBeNull();
    expect(byCigar("Eastern Standard Sungrown").placeholderNotes).toEqual([
      { field: "humidorAt", raw: "Backordered" },
    ]);
    expect(byCigar("Trinidad Reyes").placeholderNotes).toEqual([{ field: "humidorAt", raw: "Stuck" }]);
    const punch = byCigar("Short de Punch 2022");
    expect(punch.vitola).toBeNull();
    expect(punch.lengthInches).toBeNull();
    expect(punch.placeholderNotes.map((n) => n.field).sort()).toEqual(["size", "vitola"]);
  });

  it("flags known brand drift but keeps the literal brand (never rewrites)", () => {
    const lfd = byCigar("La Nox");
    expect(lfd.brand).toBe("LFD"); // literal, unchanged
    expect(lfd.canonicalName).toBe("LFD La Nox");
    expect(lfd.brandDrift).toBe("La Flor Dominicana");

    expect(byCigar("Rocky Patel Edge").brandDrift).toBe("Rocky Patel");
    expect(byCigar("Divinos").brandDrift).toBe("unknown brand (placeholder)");
    expect(byCigar("Siglo VI").brandDrift).toBeNull();
  });

  it("nulls the vendor for the '-' retailer placeholder", () => {
    expect(byCigar("Short de Punch 2022").retailer).toBeNull();
    expect(byCigar("Divinos").retailer).toBeNull();
  });
});
