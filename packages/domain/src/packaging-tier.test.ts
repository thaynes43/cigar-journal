import { describe, it, expect } from "vitest";
import {
  packagingTier,
  compareOffersByTier,
  TIER_SINGLE,
  TIER_PACK,
  TIER_BOX,
  TIER_NOT_STATED,
  type OfferOrderFields,
} from "./packaging-tier.js";

// DESIGN-005 §Strings is the whole spec here: the labels are fixed text every
// surface renders verbatim, and the order is the order a buyer thinks in.

describe("packagingTier — labels", () => {
  it("names a single, whether the shop said so or the row carries one stick", () => {
    expect(packagingTier("single", 1)).toEqual({ order: TIER_SINGLE, label: "Single" });
    expect(packagingTier("single", null)).toEqual({ order: TIER_SINGLE, label: "Single" });
    expect(packagingTier("loose", 1)).toEqual({ order: TIER_SINGLE, label: "Single" });
  });

  it("keeps a label that already names its count verbatim — it is the shop's word", () => {
    expect(packagingTier("5-pack", 5)).toEqual({ order: TIER_PACK, label: "5-pack" });
    expect(packagingTier("10-pack", 10)).toEqual({ order: TIER_PACK, label: "10-pack" });
  });

  it("adds the count to a bare tier when the row carries one", () => {
    expect(packagingTier("box", 20)).toEqual({ order: TIER_BOX, label: "Box of 20" });
    expect(packagingTier("bundle", 10)).toEqual({ order: TIER_PACK, label: "Bundle of 10" });
  });

  it("stands the bare tier alone when the count is unknown — never an invented number", () => {
    expect(packagingTier("box", null)).toEqual({ order: TIER_BOX, label: "Box" });
    expect(packagingTier("pack", null)).toEqual({ order: TIER_PACK, label: "Pack" });
  });

  it("calls an unrecorded packaging Not stated, last (DESIGN-005 rule 1)", () => {
    expect(packagingTier(null, null)).toEqual({ order: TIER_NOT_STATED, label: "Not stated" });
    expect(packagingTier("  ", 20)).toEqual({ order: TIER_NOT_STATED, label: "Not stated" });
  });
});

function offer(over: Partial<OfferOrderFields>): OfferOrderFields {
  return {
    packaging: null,
    sticksPerPackage: null,
    pricePerStick: null,
    price: null,
    inStock: true,
    seenAt: "2026-09-02T00:00:00.000Z",
    vendor: "Shop",
    ...over,
  };
}

describe("compareOffersByTier — the order a buyer thinks in (DESIGN-005 rule 2)", () => {
  it("orders single → packs → box → not stated, ascending sticks inside a tier", () => {
    const rows = [
      offer({ packaging: null, price: 452.6, vendor: "Cuban Lou's" }),
      offer({ packaging: "box", sticksPerPackage: 25, pricePerStick: 9, vendor: "Box25" }),
      offer({ packaging: "box", sticksPerPackage: 20, pricePerStick: 10.5, vendor: "Box20" }),
      offer({ packaging: "10-pack", sticksPerPackage: 10, pricePerStick: 10.8, vendor: "Ten" }),
      offer({ packaging: "5-pack", sticksPerPackage: 5, pricePerStick: 11, vendor: "Five" }),
      offer({ packaging: "single", sticksPerPackage: 1, pricePerStick: 11.59, vendor: "One" }),
    ];
    expect([...rows].sort(compareOffersByTier).map((r) => r.vendor)).toEqual([
      "One",
      "Five",
      "Ten",
      "Box20",
      "Box25",
      "Cuban Lou's",
    ]);
  });

  it("inside one tier block: best per-stick, then in stock, then most recent", () => {
    const rows = [
      offer({
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStick: 11.2,
        inStock: false,
        vendor: "Dearer",
      }),
      offer({
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStick: 10.5,
        inStock: false,
        seenAt: "2026-08-01T00:00:00.000Z",
        vendor: "Older",
      }),
      offer({
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStick: 10.5,
        inStock: true,
        seenAt: "2026-08-01T00:00:00.000Z",
        vendor: "Stocked",
      }),
      offer({
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStick: 10.5,
        inStock: false,
        seenAt: "2026-09-01T00:00:00.000Z",
        vendor: "Newer",
      }),
    ];
    expect([...rows].sort(compareOffersByTier).map((r) => r.vendor)).toEqual([
      "Stocked",
      "Newer",
      "Older",
      "Dearer",
    ]);
  });

  it("falls back to the package price where no per-stick is derivable — the Not stated figure", () => {
    const rows = [
      offer({ price: 452.6, vendor: "Dear" }),
      offer({ price: null, vendor: "Priceless" }),
      offer({ price: 169.99, vendor: "Cheap" }),
    ];
    expect([...rows].sort(compareOffersByTier).map((r) => r.vendor)).toEqual([
      "Cheap",
      "Dear",
      "Priceless",
    ]);
  });
});
