import type { VendorAdapter } from "../adapters/types.js";

// `resolveVendor` is INSERT-IF-ABSENT: an existing `vendors` row is returned
// untouched, and that is deliberate — the registry is admin-managed data (ADR-006)
// and a crawl must not silently overwrite a decision an admin made in the row.
//
// The cost of that rule is a blind spot, called out on #179 and again on the
// 2026-08-31 #217 re-probe: flipping `crawlEnabled` (or any other posture field)
// in an adapter changes NOTHING for a vendor that already has a row. Every vendor
// we ship has one. So the constant reads like a switch and is not one, and the
// only way to notice is to query the database.
//
// This closes the blind spot without breaking the rule: on every run that
// resolves an existing row we COMPARE the adapter's posture against it and print
// what differs. Reconcile by REPORT, not by write — the operator still performs
// the row change, but they are told it is outstanding instead of discovering it
// from a crawl that did nothing.

// The subset of the row this compares. Structural, not `VendorRow`, so the
// crawler's core does not take a schema dependency for a formatting function.
export interface VendorPostureRow {
  kind: string;
  focus: string | null;
  crawlEnabled: boolean;
  displayEnabled: boolean;
  approvalStatus: string;
  purchaseLinkout: boolean;
}

export interface VendorPostureDrift {
  field: string;
  row: string;
  adapter: string;
}

// Every field `resolveVendor` would have written on an INSERT, so what is
// compared and what is seeded cannot drift apart. `name`/`url` are excluded: the
// row is looked up BY name, and an admin editing the display URL is not a posture
// change.
export function vendorPostureDrift(row: VendorPostureRow, adapter: VendorAdapter): VendorPostureDrift[] {
  const pairs: Array<[string, unknown, unknown]> = [
    ["kind", row.kind, adapter.kind],
    ["focus", row.focus, adapter.focus ?? null],
    ["crawl_enabled", row.crawlEnabled, adapter.crawlEnabled],
    ["display_enabled", row.displayEnabled, adapter.displayEnabled],
    ["approval_status", row.approvalStatus, adapter.approvalStatus],
    ["purchase_linkout", row.purchaseLinkout, adapter.purchaseLinkout],
  ];
  return pairs
    .filter(([, rowValue, adapterValue]) => rowValue !== adapterValue)
    .map(([field, rowValue, adapterValue]) => ({
      field,
      row: String(rowValue),
      adapter: String(adapterValue),
    }));
}

// One line per drifted field, plus the reason the run did not fix it itself.
// Empty when the row already agrees, so a healthy run prints nothing.
export function formatVendorPostureDrift(vendorName: string, drift: VendorPostureDrift[]): string[] {
  if (drift.length === 0) return [];
  return [
    `vendor posture drift: the "${vendorName}" registry row differs from its adapter.`,
    ...drift.map((d) => `  ${d.field}: row=${d.row} adapter=${d.adapter}`),
    "  The row wins — registration is insert-if-absent and never overwrites an",
    "  admin-owned row. Change it in the database to adopt the adapter's value.",
  ];
}
