import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys } from "@cj/db";
import type { Deps, Principal } from "@cj/domain";
import { parseLedgerCsv, matchKey, type LedgerRow } from "./ledger-parse.js";
import { parsePurchaseHistory } from "./purchases-parse.js";
import { writePurchase } from "./purchase-writer.js";
import { ledgerPurchaseRequestId } from "./keys.js";
import { emptyLedgerReport, type LedgerReport } from "./ledger-report.js";

// Reconcile a ledger snapshot against the purchases already imported from the
// archive and insert only what is missing (flow 006). A ledger row MATCHES an
// existing purchase when the normalized cigar name+brand, purchase date,
// quantity, and packaging all line up — matched rows are skipped. Unmatched rows
// are inserted through the shared purchase writer under deterministic
// `ledger-2026-08-27#<ordinal>` keys, so a re-run replays instead of
// duplicating. Existing rows are never updated or deleted.
//
// Matching is against the archive `purchase-history.md` SOURCE rows, not the DB
// purchase→cigar links: the importer's trigram cigar resolution deliberately
// collapses near-identical names (ADR-002), so two different archived purchases
// can point at one merged cigar — the DB link can no longer tell them apart. The
// source table is the faithful, per-row record of what was imported, so it is
// the sound thing to reconcile against. A prior ledger run is still recognized
// via its idempotency key, so both import paths are covered.

export interface LedgerOptions {
  csvPath: string;
  archiveDocsDir: string; // holds purchase-history.md (the archive-imported set)
  deps: Deps;
  principal: Principal;
  userEmail: string;
  dryRun: boolean;
}

// Multiset of already-imported match keys from the archive purchase table: a
// count per key so a single archived purchase satisfies at most one ledger row
// (two ledger rows with the same key don't both collapse onto one archived buy).
async function archiveMatchCounts(archiveDocsDir: string): Promise<Map<string, number>> {
  const markdown = await readFile(join(archiveDocsDir, "purchase-history.md"), "utf8").catch(
    () => "",
  );
  const counts = new Map<string, number>();
  for (const row of parsePurchaseHistory(markdown)) {
    const key = matchKey(row.brand, row.cigar, row.purchasedAt, row.quantity, row.packaging);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

async function isKeyPresent(
  deps: Deps,
  principal: Principal,
  clientRequestId: string,
): Promise<boolean> {
  const rows = await deps.db
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, principal.userId),
        eq(idempotencyKeys.clientRequestId, clientRequestId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function summarize(row: LedgerRow): string {
  const p = row.purchase;
  return `${p.canonicalName}   qty=${p.quantity ?? "-"} date=${p.purchasedAt ?? "unknown"} pkg=${p.packaging ?? "-"}`;
}

export async function reconcileLedger(options: LedgerOptions): Promise<LedgerReport> {
  const { csvPath, archiveDocsDir, deps, principal, userEmail, dryRun } = options;
  const report = emptyLedgerReport({ dryRun, userEmail, userId: principal.userId, csvPath });

  const text = await readFile(csvPath, "utf8");
  const rows = parseLedgerCsv(text);
  report.totalRows = rows.length;

  const matchCounts = await archiveMatchCounts(archiveDocsDir);

  for (const row of rows) {
    const ref = `ledger-2026-08-27#${row.ordinal}`;
    const clientRequestId = ledgerPurchaseRequestId(row.ordinal);

    // A prior ledger run already inserted this row — replay via the idempotency
    // key, never re-match it against the purchase it created itself. Checked
    // before content matching so a re-run is a clean replay, not a self-match.
    if (await isKeyPresent(deps, principal, clientRequestId)) {
      report.counts.replayed += 1;
      report.plan.push(`skip   ${ref}   already imported`);
      continue;
    }

    // Matched: an existing (archive-imported) purchase covers this row. Consume
    // it and skip — never re-flag quirks the archive import already handled.
    const available = matchCounts.get(row.matchKey) ?? 0;
    if (available > 0) {
      matchCounts.set(row.matchKey, available - 1);
      report.counts.matched += 1;
      report.plan.push(`match  ${ref}   ${summarize(row)}`);
      continue;
    }

    // Unmatched: surface this row's own needs-review reasons for the curator.
    for (const reason of row.reviewNotes) {
      report.needsReview.push({ kind: "purchase", ref, reason });
    }

    if (row.skipInsert) {
      report.counts.skipped += 1;
      report.plan.push(`skip   ${ref}   no cigar name → nothing created`);
      continue;
    }

    if (dryRun) {
      report.counts.inserted += 1;
      report.plan.push(`insert ${ref}   ${summarize(row)}`);
      continue;
    }

    const result = await writePurchase(deps, principal, row.purchase, { clientRequestId, ref });
    if (result.status === "imported") report.counts.inserted += 1;
    else if (result.status === "replayed") report.counts.replayed += 1;
    else report.counts.skipped += 1;
    if (result.cigarCreated) report.cigarsCreated += 1;
    if (result.vendorCreated) report.vendorsCreated += 1;
    if (result.note) report.needsReview.push(result.note);
  }

  return report;
}
