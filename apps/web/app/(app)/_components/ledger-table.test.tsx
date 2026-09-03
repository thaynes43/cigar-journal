import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { InventoryHolding, InventoryLot } from "@cj/domain";
import { LedgerTable } from "./ledger-table";

// The Ledger column rule (DESIGN-002 §IA, ruled on #219): identity and count
// columns hold position; the descriptive ones follow the humidor panel's
// absent-when-empty rule, so the desk surface never carries a column of dashes.

const CORE = ["Cigar", "Brand", "QTY", "Consumed", "Left", "Purchased", "Vendor", "PPS"];
const DESCRIPTIVE = ["Packaging", "Vitola", "Type", "Size", "Humidor", "Box date", "Aging"];

const EMPTY_LOT: InventoryLot = {
  purchaseId: "lot-1",
  purchasedAt: "2025-01-04",
  quantity: 5,
  packaging: null,
  boxDate: null,
  humidorAt: null,
  pricePerStick: 8.4,
  vendor: "Cigars Direct",
  notes: null,
};

function holding(lots: InventoryLot[], cigar: Partial<InventoryHolding["cigar"]> = {}): InventoryHolding {
  return {
    cigar: {
      cigarId: "cig-1",
      canonicalName: "Bolivar Belicosos Finos",
      brand: "Bolivar",
      line: null,
      vitola: { name: null, lengthInches: null, ringGauge: null },
      type: null,
      ...cigar,
    },
    lots,
    totalAcquired: 5,
    smokedCount: 1,
    consumedCount: 1,
    remaining: 4,
    overConsumed: 0,
    agingSince: null,
    myRating: null,
  };
}

function headers(holdings: InventoryHolding[]): string[] {
  const html = renderToStaticMarkup(<LedgerTable holdings={holdings} />);
  return [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]!);
}

describe("the ledger column rule", () => {
  it("drops every descriptive column no row carries a value for", () => {
    expect(headers([holding([EMPTY_LOT])])).toEqual(CORE);
  });

  it("renders a descriptive column as soon as one row carries its value", () => {
    const rows = [
      holding([EMPTY_LOT]),
      holding([{ ...EMPTY_LOT, purchaseId: "lot-2", packaging: "Box of 25" }]),
    ];
    expect(headers(rows)).toEqual(["Cigar", "Brand", "Packaging", "QTY", ...CORE.slice(3)]);
  });

  it("keeps the identity and count columns with no rows at all", () => {
    expect(headers([])).toEqual(CORE);
    expect(headers([holding([])])).toEqual(CORE);
  });

  it("renders every column, in the design's order, when the data is complete", () => {
    const full = holding(
      [
        {
          ...EMPTY_LOT,
          packaging: "Box of 25",
          boxDate: "2023-06-01",
          humidorAt: "2024-02-10",
        },
      ],
      { vitola: { name: "Robusto", lengthInches: 5, ringGauge: 50 }, type: "CC" },
    );
    expect(headers([full])).toEqual([
      "Cigar",
      "Brand",
      "Packaging",
      "QTY",
      "Consumed",
      "Left",
      "Vitola",
      "Type",
      "Size",
      "Purchased",
      "Humidor",
      "Box date",
      "Vendor",
      "PPS",
      "Aging",
    ]);
  });

  it("keeps the cells the surviving columns own, and the over-consumption tone", () => {
    const over = { ...holding([EMPTY_LOT]), consumedCount: 9, remaining: 0, overConsumed: 4 };
    const html = renderToStaticMarkup(<LedgerTable holdings={[over]} />);
    expect(html).toContain("4 over");
    expect(html).toContain('title="Consumption exceeds recorded purchases"');
    expect(html).toContain("$8.40");
    expect(html).toContain("Cigars Direct");
    for (const header of DESCRIPTIVE) expect(html).not.toContain(`>${header}<`);
  });

  it("blanks the per-holding counts on a holding's second lot", () => {
    const two = holding([EMPTY_LOT, { ...EMPTY_LOT, purchaseId: "lot-2" }]);
    const html = renderToStaticMarkup(<LedgerTable holdings={[two]} />);
    expect([...html.matchAll(/>4<\/span>/g)]).toHaveLength(1);
  });
});
