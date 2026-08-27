import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys } from "@cj/db";
import {
  saveSmoke,
  ValidationError,
  IdempotencyConflictError,
  CigarAmbiguousError,
  type Deps,
  type Principal,
} from "@cj/domain";
import { parseReviewPage } from "./reviews.js";
import { parseBrandIndexRatings } from "./ratings.js";
import { parsePurchaseHistory } from "./purchases-parse.js";
import { buildSmokeInputs, type ReviewPagePlan } from "./smoke-input.js";
import { writePurchase } from "./purchase-writer.js";
import { purchaseRequestId } from "./keys.js";
import { emptyReport, type ImportReport } from "./report.js";

// Orchestrates a full archive import: scan review pages + purchase history,
// build the plan, and either print it (dry-run) or apply it through the domain.
// Everything is deterministic (sorted traversal, deterministic request ids) so a
// re-run replays instead of duplicating (flow 006).

export interface RunOptions {
  docsDir: string;
  deps: Deps;
  principal: Principal;
  userEmail: string;
  dryRun: boolean;
}

const SECTIONS: { dir: string; type: "NC" | "CC" }[] = [
  { dir: "nc-reviews", type: "NC" },
  { dir: "cc-reviews", type: "CC" },
];

async function listDirs(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function listMarkdown(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "index.md")
    .map((e) => e.name)
    .sort();
}

function titleFromMarkdown(markdown: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(markdown);
  return m ? m[1]! : null;
}

function titlecase(folder: string): string {
  return folder
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function isKeyPresent(deps: Deps, principal: Principal, clientRequestId: string): Promise<boolean> {
  const rows = await deps.db
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, principal.userId), eq(idempotencyKeys.clientRequestId, clientRequestId)))
    .limit(1);
  return rows.length > 0;
}

interface ScannedPage extends ReviewPagePlan {
  emptyReason: "stub" | "malformed-heading" | null;
  malformedHint: string | null;
}

// Scan the archive into deterministic review-page plans (rating attached).
async function scanReviewPages(docsDir: string): Promise<ScannedPage[]> {
  const plans: ScannedPage[] = [];
  for (const section of SECTIONS) {
    const sectionDir = join(docsDir, section.dir);
    for (const brandFolder of await listDirs(sectionDir)) {
      const brandDir = join(sectionDir, brandFolder);
      const indexMd = await readFile(join(brandDir, "index.md"), "utf8").catch(() => "");
      const brandDisplay = titleFromMarkdown(indexMd) ?? titlecase(brandFolder);
      const ratings = parseBrandIndexRatings(indexMd);
      for (const file of await listMarkdown(brandDir)) {
        const markdown = await readFile(join(brandDir, file), "utf8");
        const parsed = parseReviewPage(markdown);
        plans.push({
          relpath: `${section.dir}/${brandFolder}/${file}`,
          type: section.type,
          brandDisplay,
          pageTitle: parsed.pageTitle,
          reviews: parsed.reviews,
          ratingRaw: ratings.get(file) ?? null,
          emptyReason: parsed.emptyReason,
          malformedHint: parsed.malformedHint,
        });
      }
    }
  }
  return plans;
}

export async function runImport(options: RunOptions): Promise<ImportReport> {
  const { docsDir, deps, principal, userEmail, dryRun } = options;
  const report = emptyReport({ dryRun, userEmail, userId: principal.userId, archiveDir: docsDir });

  // --- Smokes ---------------------------------------------------------------
  for (const page of await scanReviewPages(docsDir)) {
    if (page.reviews.length === 0) {
      report.smokes.skipped += 1;
      if (page.emptyReason === "malformed-heading") {
        report.needsReview.push({
          kind: "smoke",
          ref: page.relpath,
          reason: `no parseable "## Review N - Vitola - Date" heading (found "${page.malformedHint}")`,
        });
      } else {
        report.plan.push(`skip   ${page.relpath}   stub / no reviews`);
      }
      continue;
    }

    const built = buildSmokeInputs(page);
    report.needsReview.push(...built.notes);

    for (const s of built.smokes) {
      if (dryRun) {
        if (await isKeyPresent(deps, principal, s.requestId)) {
          report.smokes.replayed += 1;
          report.plan.push(`skip   ${page.relpath}#${s.reviewNumber}   already imported`);
        } else {
          report.smokes.imported += 1;
          const date = s.input.smokedAt?.value ?? "unknown";
          const rating = s.input.assessment?.rating ?? "-";
          report.plan.push(`smoke  ${page.relpath}#${s.reviewNumber}   ${s.canonicalName}   date=${date} rating=${rating}`);
        }
        continue;
      }

      try {
        const result = await saveSmoke(deps, principal, s.input);
        if (result.replayed) report.smokes.replayed += 1;
        else report.smokes.imported += 1;
        if (result.cigarCreated) report.cigarsCreated += 1;
      } catch (error) {
        report.smokes.skipped += 1;
        if (error instanceof ValidationError) {
          report.needsReview.push({ kind: "smoke", ref: `${page.relpath}#${s.reviewNumber}`, reason: `validation: ${error.fields.map((f) => f.path).join(",")}` });
        } else if (error instanceof IdempotencyConflictError) {
          report.needsReview.push({ kind: "smoke", ref: `${page.relpath}#${s.reviewNumber}`, reason: `changed since first import → not updated` });
        } else if (error instanceof CigarAmbiguousError) {
          report.needsReview.push({ kind: "smoke", ref: `${page.relpath}#${s.reviewNumber}`, reason: `ambiguous cigar match → skipped` });
        } else {
          throw error;
        }
      }
    }
  }

  // --- Purchases ------------------------------------------------------------
  const purchaseMd = await readFile(join(docsDir, "purchase-history.md"), "utf8").catch(() => "");
  for (const row of parsePurchaseHistory(purchaseMd)) {
    const ref = `purchase-history.md#${row.rowNumber}`;
    for (const note of row.placeholderNotes) {
      report.needsReview.push({ kind: "purchase", ref, reason: `${note.field} placeholder "${note.raw}" → null` });
    }
    if (row.brandDrift) {
      report.needsReview.push({
        kind: "purchase",
        ref,
        reason: `brand drift "${row.brand}" → ${row.brandDrift}; created literal, curator to merge`,
      });
    }

    if (dryRun) {
      if (await isKeyPresent(deps, principal, purchaseRequestId(row.rowNumber))) {
        report.purchases.replayed += 1;
        report.plan.push(`skip   ${ref}   already imported`);
      } else {
        report.purchases.imported += 1;
        report.plan.push(
          `buy    ${ref}   ${row.canonicalName}   vendor=${row.retailer ?? "-"} qty=${row.quantity ?? "-"} date=${row.purchasedAt ?? "unknown"}`,
        );
      }
      continue;
    }

    const result = await writePurchase(deps, principal, row, {
      clientRequestId: purchaseRequestId(row.rowNumber),
      ref,
    });
    if (result.status === "imported") report.purchases.imported += 1;
    else if (result.status === "replayed") report.purchases.replayed += 1;
    else report.purchases.skipped += 1;
    if (result.cigarCreated) report.cigarsCreated += 1;
    if (result.vendorCreated) report.vendorsCreated += 1;
    if (result.note) report.needsReview.push(result.note);
  }

  return report;
}
