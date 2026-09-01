import { describe, it, expect } from "vitest";
import { vendorPostureDrift, formatVendorPostureDrift, type VendorPostureRow } from "./vendor-posture.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import type { VendorAdapter } from "../adapters/types.js";

// The row as the adapter would have seeded it, so each test perturbs exactly one
// field and the assertion names the perturbation.
function rowFor(adapter: VendorAdapter, overrides: Partial<VendorPostureRow> = {}): VendorPostureRow {
  return {
    kind: adapter.kind,
    focus: adapter.focus ?? null,
    crawlEnabled: adapter.crawlEnabled,
    displayEnabled: adapter.displayEnabled,
    approvalStatus: adapter.approvalStatus,
    purchaseLinkout: adapter.purchaseLinkout,
    ...overrides,
  };
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

  it("reports every posture field, and only posture fields", () => {
    const drift = vendorPostureDrift(
      rowFor(twoGuysCigars, {
        kind: "reviewer",
        focus: "CC",
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
      displayEnabled: false,
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
