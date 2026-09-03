import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CigarHolding, CigarHoldingLot } from "@cj/domain";
import { HoldingPanel } from "./holding-panel";

// The humidor panel's mini-ledger owns no rule of its own any more: it reads the
// shared absent-when-empty predicate (#219). These pin the behavior it had.

const LOT: CigarHoldingLot = {
  purchaseId: "lot-1",
  purchasedAt: null,
  boxDate: null,
  humidorAt: null,
  quantity: null,
  packaging: null,
  pricePerStick: null,
  vendor: null,
};

function panel(lots: CigarHoldingLot[]): string {
  const holding: CigarHolding = {
    cigarId: "cig-1",
    hasHolding: lots.length > 0,
    totalAcquired: 5,
    remaining: 4,
    overConsumed: 0,
    agingSince: null,
    lots,
  };
  return renderToStaticMarkup(<HoldingPanel holding={holding} />);
}

function headers(html: string): string[] {
  return [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]!);
}

describe("the humidor panel's lots ledger", () => {
  it("renders no table when every column is empty", () => {
    const html = panel([LOT]);
    expect(html).not.toContain("<table");
    expect(html).toContain("Smoke one");
  });

  it("renders only the columns a lot carries", () => {
    expect(headers(panel([{ ...LOT, quantity: 5, vendor: "Cigars Direct" }]))).toEqual([
      "Qty",
      "Vendor",
    ]);
  });

  it("keeps the design's column order across lots", () => {
    const html = panel([
      { ...LOT, quantity: 5, boxDate: "2023-06-01" },
      { ...LOT, purchaseId: "lot-2", vendor: "Cigars Direct", pricePerStick: 8.4 },
    ]);
    expect(headers(html)).toEqual(["Qty", "Vendor", "Per stick", "Box date"]);
    expect(html).toContain("$8.40");
  });
});
