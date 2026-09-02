import { describe, it, expect } from "vitest";
import {
  adapterPosture,
  vendorPostureDrift,
  formatVendorPostureDrift,
  type VendorPostureRow,
} from "./vendor-posture.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import type { VendorAdapter } from "../adapters/types.js";

// The row as the adapter would have seeded it — through the SAME projection
// `resolveVendor` inserts, so each test perturbs exactly one field and the
// assertion names the perturbation.
function rowFor(adapter: VendorAdapter, overrides: Partial<VendorPostureRow> = {}): VendorPostureRow {
  return { ...adapterPosture(adapter), ...overrides };
}

describe("vendorPostureDrift", () => {
  it("reports nothing when the row already matches the adapter", () => {
    expect(vendorPostureDrift(rowFor(twoGuysCigars), twoGuysCigars)).toEqual([]);
  });

  // The exact case #179 and #217 both flagged: 2 Guys has a prod row, so the day
  // someone flips `crawlEnabled` in the adapter the crawl still will not run.
  it("names a crawl_enabled flip the adapter cannot apply", () => {
    const enabledAdapter = { ...twoGuysCigars, crawlEnabled: true };
    const drift = vendorPostureDrift(rowFor(twoGuysCigars), enabledAdapter);
    expect(drift).toEqual([{ field: "crawl_enabled", row: "false", adapter: "true" }]);
  });

  // A DEMOTION THE ADAPTER CANNOT APPLY, which is the tier's version of the same
  // blind spot: 2 Guys ships tier 1, and an admin who moved its prod row to 3
  // would otherwise never learn the two disagree (ADR-015).
  it("names a tier the row and the adapter disagree about", () => {
    const drift = vendorPostureDrift(rowFor(twoGuysCigars, { tier: 3 }), twoGuysCigars);
    expect(drift).toEqual([{ field: "tier", row: "3", adapter: "1" }]);
  });

  // `display_enabled` is DERIVED from the tier, so it is not separately settable
  // on an adapter and the two can never disagree in the seed. Cuban Lou's is the
  // live case: tier 2, so its offers are recorded and not shown, and a prod row
  // that still says `true` is reported rather than overwritten.
  it("seeds display_enabled from the tier, and reports a row that disagrees", () => {
    expect(adapterPosture(twoGuysCigars).displayEnabled).toBe(true);
    expect(adapterPosture(cubanLous).displayEnabled).toBe(false);
    const drift = vendorPostureDrift(rowFor(cubanLous, { displayEnabled: true }), cubanLous);
    expect(drift).toEqual([{ field: "display_enabled", row: "true", adapter: "false" }]);
  });

  it("reports every posture field, and only posture fields", () => {
    const drift = vendorPostureDrift(
      rowFor(twoGuysCigars, {
        kind: "reviewer",
        focus: "CC",
        tier: 4,
        crawlEnabled: true,
        displayEnabled: false,
        approvalStatus: "unapproved",
        purchaseLinkout: false,
      }),
      twoGuysCigars,
    );
    expect(drift.map((d) => d.field)).toEqual([
      "kind",
      "focus",
      "tier",
      "crawl_enabled",
      "display_enabled",
      "approval_status",
      "purchase_linkout",
    ]);
  });

  // A non-vendor adapter carries no focus at all; the column holds NULL for it,
  // and `undefined !== null` would otherwise report drift on every single run.
  it("treats an absent adapter focus as the row's NULL, not as a difference", () => {
    const reference: VendorAdapter = {
      slug: "halfwheel",
      name: "halfwheel",
      url: "https://halfwheel.example",
      sitemapUrl: "https://halfwheel.example/sitemap.xml",
      kind: "reviewer",
      purchaseLinkout: false,
      crawlEnabled: false,
      approvalStatus: "owner-added",
      tier: 2,
      cigarCategoryPattern: /^$/,
      excludePattern: /^$/,
      productPathPrefix: "/review/",
    };
    const row = rowFor(reference, { kind: "reviewer", focus: null, purchaseLinkout: false });
    expect(row.focus).toBeNull();
    expect(vendorPostureDrift(row, reference)).toEqual([]);
  });
});

describe("formatVendorPostureDrift", () => {
  it("prints nothing for a row in agreement", () => {
    expect(formatVendorPostureDrift("2 Guys Cigars", [])).toEqual([]);
  });

  it("names the vendor, the fields, and why the run did not fix it", () => {
    const lines = formatVendorPostureDrift("2 Guys Cigars", [
      { field: "crawl_enabled", row: "false", adapter: "true" },
    ]);
    expect(lines[0]).toContain('"2 Guys Cigars"');
    expect(lines[1]).toBe("  crawl_enabled: row=false adapter=true");
    expect(lines.join("\n")).toContain("insert-if-absent");
  });
});
