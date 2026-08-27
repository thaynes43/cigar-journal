// Run report (flow 006): imported / skipped / needs-review with reasons, in
// terse tabular text. Structured entries are exposed for tests; the formatter
// aggregates them for the operator.

export type NeedsReviewKind = "smoke" | "purchase";

export interface NeedsReview {
  kind: NeedsReviewKind;
  ref: string; // source ref, e.g. "nc-reviews/god-of-fire/series-b.md#1"
  reason: string;
}

export interface SectionCounts {
  imported: number;
  skipped: number;
  replayed: number;
}

export interface ImportReport {
  dryRun: boolean;
  userEmail: string;
  userId: string;
  archiveDir: string;
  smokes: SectionCounts;
  purchases: SectionCounts;
  cigarsCreated: number;
  vendorsCreated: number;
  needsReview: NeedsReview[];
  // Dry-run plan lines (empty on apply).
  plan: string[];
}

export function emptyReport(base: Pick<ImportReport, "dryRun" | "userEmail" | "userId" | "archiveDir">): ImportReport {
  return {
    ...base,
    smokes: { imported: 0, skipped: 0, replayed: 0 },
    purchases: { imported: 0, skipped: 0, replayed: 0 },
    cigarsCreated: 0,
    vendorsCreated: 0,
    needsReview: [],
    plan: [],
  };
}

function pad(value: string, width: number): string {
  // Always leave at least one space so an over-long column never abuts the next.
  return value + " ".repeat(Math.max(1, width - value.length));
}

export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(`LEGACY IMPORT — ${report.dryRun ? "dry-run (no writes)" : "apply"}`);
  lines.push(`user      ${report.userEmail} (${report.userId})`);
  lines.push(`archive   ${report.archiveDir}`);
  lines.push("");

  const section = (name: string, c: SectionCounts): void => {
    lines.push(name);
    lines.push(`  imported   ${c.imported}`);
    lines.push(`  replayed   ${c.replayed}`);
    lines.push(`  skipped    ${c.skipped}`);
  };
  section("SMOKES", report.smokes);
  section("PURCHASES", report.purchases);
  lines.push("");
  lines.push(`cigars-created   ${report.cigarsCreated}`);
  lines.push(`vendors-created  ${report.vendorsCreated}`);
  lines.push("");

  if (report.dryRun && report.plan.length > 0) {
    lines.push(`PLAN (${report.plan.length})`);
    for (const p of report.plan) lines.push(`  ${p}`);
    lines.push("");
  }

  lines.push(`NEEDS-REVIEW (${report.needsReview.length})`);
  for (const n of report.needsReview) {
    lines.push(`  ${pad(n.kind, 9)}${pad(n.ref, 46)}${n.reason}`);
  }
  return lines.join("\n");
}
