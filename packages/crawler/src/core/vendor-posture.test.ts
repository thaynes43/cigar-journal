import { describe, it, expect } from "vitest";
import {
  adapterPosture,
  vendorPostureDrift,
  formatVendorPostureDrift,
  type VendorPostureRow,
} from "./vendor-posture.js";
import { twoGuysCigars } from "../adapters/two-guys-cigars.js";
import { cubanLous } from "../adapters/cuban-lous.js";
import { getAdapter } from "../adapters/index.js";
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

  // The exact case #179 and #217 both flagged: 2 Guys has a prod row, so a
  // `crawlEnabled` that disagrees with it changes nothing about whether the crawl
  // runs — it only gets reported. Written from the DISABLED side now that the
  // adapters carry the operator's enabled rows (#270).
  it("names a crawl_enabled flip the adapter cannot apply", () => {
    const disabledAdapter = { ...twoGuysCigars, crawlEnabled: false };
    const drift = vendorPostureDrift(rowFor(twoGuysCigars), disabledAdapter);
    expect(drift).toEqual([{ field: "crawl_enabled", row: "true", adapter: "false" }]);
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
        crawlEnabled: false,
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
  //
  // Spelled with `kind: "reference"` — the OTHER non-vendor kind — because it is
  // the one that carries no review walk either, so the case stays about the focus
  // column alone. A reviewer's posture is asserted against the real halfwheel
  // adapter in `reviews.test.ts`.
  it("treats an absent adapter focus as the row's NULL, not as a difference", () => {
    const reference: VendorAdapter = {
      slug: "reference-source",
      name: "Reference Source",
      url: "https://reference.example",
      sitemapUrl: "https://reference.example/sitemap.xml",
      kind: "reference",
      purchaseLinkout: false,
      crawlEnabled: false,
      approvalStatus: "owner-added",
      tier: 2,
      cigarCategoryPattern: /^$/,
      excludePattern: /^$/,
      productPathPrefix: "/review/",
    };
    const row = rowFor(reference, { kind: "reference", focus: null, purchaseLinkout: false });
    expect(row.focus).toBeNull();
    expect(vendorPostureDrift(row, reference)).toEqual([]);
  });
});

// THE REGISTRY AS THE OPERATOR LEFT IT, and the reason this block exists.
//
// The first unattended fleet run (2026-09-03 02:00 UTC, #270) printed a
// six-line `vendor posture drift` paragraph for SEVEN of its eight vendors. Not
// one was a fault: the operator had probed and enabled every row through
// 2026-09-02 while the adapters' `crawlEnabled` constants sat at their pre-probe
// `false`. A report that fires on every vendor every night reports nothing, and
// the next real drift would have gone unread underneath it.
//
// So the rows below are the prod `vendors` table read on 2026-09-03, and the
// assertion is that the adapters agree with it — i.e. that a fleet run prints
// NOTHING for these eight. It is deliberately a transcript and not a loop over
// the adapters: a test that derived the expected row from the adapter would
// agree with any value the adapter happened to hold, which is precisely the
// blind spot `vendorPostureDrift` was written to close one level up.
const PROD_REGISTRY: Array<{ name: string; slug: string; row: VendorPostureRow }> = [
  {
    name: "Fox Cigar",
    slug: "fox-cigar",
    row: row("vendor", "NC", 1, true, true, "owner-added", true),
  },
  {
    name: "2 Guys Cigars",
    slug: "two-guys-cigars",
    row: row("vendor", "NC", 1, true, true, "owner-added", true),
  },
  {
    name: "Small Batch Cigar",
    slug: "small-batch-cigar",
    row: row("vendor", "NC", 1, true, true, "owner-added", true),
  },
  {
    name: "Montefortuna Cigars",
    slug: "montefortuna",
    row: row("vendor", "both", 2, true, false, "unapproved", false),
  },
  {
    name: "EGM Cigars",
    slug: "egm-cigars",
    row: row("vendor", "both", 3, true, false, "unapproved", false),
  },
  {
    name: "Cigarworld.de",
    slug: "cigarworld-de",
    row: row("vendor", "both", 4, true, false, "unapproved", false),
  },
  {
    name: "J.J. Fox",
    slug: "jj-fox",
    row: row("vendor", "both", 5, true, false, "unapproved", false),
  },
];

function row(
  kind: string,
  focus: string | null,
  tier: number,
  crawlEnabled: boolean,
  displayEnabled: boolean,
  approvalStatus: string,
  purchaseLinkout: boolean,
): VendorPostureRow {
  return { kind, focus, tier, crawlEnabled, displayEnabled, approvalStatus, purchaseLinkout };
}

describe("the fleet's posture against the operator's registry (#270)", () => {
  it.each(PROD_REGISTRY)("prints nothing for $name", ({ slug, row: registryRow }) => {
    const adapter = getAdapter(slug)!;
    expect(adapter).toBeDefined();
    expect(vendorPostureDrift(registryRow, adapter)).toEqual([]);
  });

  // CUBAN LOU'S IS THE ONE DRIFT LEFT, AND IT IS LEFT ON PURPOSE — it is the
  // report doing its job rather than making noise.
  //
  // Its prod row says `display_enabled = true` at tier 2. ADR-015 rules that
  // prices are recorded from every crawled vendor and DISPLAYED only from tier 1,
  // which is why `display_enabled` is derived from the tier in `adapterPosture`
  // and is not an adapter field at all. The row predates the tier column (the
  // column's default is true) and contradicts the accepted decision, so this is a
  // stale ROW, not a stale constant: there is no constant to align, and aligning
  // one would mean giving a tier-2 shop a second, independently-settable way onto
  // the price line — the exact thing `adapterPosture`'s comment forbids.
  //
  // The crawler never writes the registry (registration is insert-if-absent), so
  // the fix is an operator's `UPDATE`. Until then this one line prints, and it
  // SHOULD.
  it("still reports Cuban Lou's stale display_enabled, and nothing else about it", () => {
    const cubanLousRow = row("vendor", "both", 2, true, true, "unapproved", false);
    expect(vendorPostureDrift(cubanLousRow, cubanLous)).toEqual([
      { field: "display_enabled", row: "true", adapter: "false" },
    ]);
    // Everything else about the row agrees, so the line is readable on its own.
    expect(vendorPostureDrift(row("vendor", "both", 2, true, false, "unapproved", false), cubanLous)).toEqual([]);
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
