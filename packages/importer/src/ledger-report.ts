import type { NeedsReview } from "./report.js";

// Ledger-reconciliation report (flow 006): matched (already present, skipped) /
// inserted / needs-review, in the same terse tabular style as the archive
// import report. Structured fields are exposed for tests; the formatter
// aggregates them for the operator.

export interface LedgerCounts {
  matched: number; // lines up with an existing purchase → skipped, never written
  inserted: number; // newly written (apply) or planned (dry-run)
  replayed: number; // a prior ledger run already wrote it (idempotency key present)
  skipped: number; // nothing created (e.g. "???" brand with no cigar name)
}

export interface LedgerReport {
  dryRun: boolean;
  userEmail: string;
  userId: string;
  csvPath: string;
  totalRows: number;
  counts: LedgerCounts;
  cigarsCreated: number;
  vendorsCreated: number;
  needsReview: NeedsReview[];
  plan: string[];
}

export function emptyLedgerReport(
  base: Pick<LedgerReport, "dryRun" | "userEmail" | "userId" | "csvPath">,
): LedgerReport {
  return {
    ...base,
    totalRows: 0,
    counts: { matched: 0, inserted: 0, replayed: 0, skipped: 0 },
    cigarsCreated: 0,
    vendorsCreated: 0,
    needsReview: [],
    plan: [],
  };
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(1, width - value.length));
}

export function formatLedgerReport(report: LedgerReport): string {
  const lines: string[] = [];
  lines.push(`LEDGER RECONCILE — ${report.dryRun ? "dry-run (no writes)" : "apply"}`);
  lines.push(`user      ${report.userEmail} (${report.userId})`);
  lines.push(`csv       ${report.csvPath}`);
  lines.push(`rows      ${report.totalRows}`);
  lines.push("");

  const c = report.counts;
  lines.push("PURCHASES");
  lines.push(`  matched    ${c.matched}`);
  lines.push(`  inserted   ${c.inserted}`);
  lines.push(`  replayed   ${c.replayed}`);
  lines.push(`  skipped    ${c.skipped}`);
  lines.push("");
  lines.push(`cigars-created   ${report.cigarsCreated}`);
  lines.push(`vendors-created  ${report.vendorsCreated}`);
  lines.push("");

  if (report.plan.length > 0) {
    lines.push(`PLAN (${report.plan.length})`);
    for (const p of report.plan) lines.push(`  ${p}`);
    lines.push("");
  }

  lines.push(`NEEDS-REVIEW (${report.needsReview.length})`);
  for (const n of report.needsReview) {
    lines.push(`  ${pad(n.kind, 9)}${pad(n.ref, 24)}${n.reason}`);
  }
  return lines.join("\n");
}
