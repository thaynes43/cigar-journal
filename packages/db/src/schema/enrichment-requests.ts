import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { cigars } from "./cigars.js";
import { users } from "./users.js";

// The gap-fill queue (owner, 2026-08-28): conversational tools enqueue a
// cigar whose facts/photo are missing; the crawler's enrich runs drain it —
// targeted vendor lookups, not full crawls. One row per ASK ("fill this cigar"),
// never per vendor: the vendor dimension lives in `enrichment_attempts`
// (migration 0023, ADR-006 amendment 2026-08-30, issue #158).
//
// Three fields changed meaning with 0023, and reading them the old way misreports:
//
//   `status`  — a CACHE of the rollup, not the authority. `exhausted` means
//     "every LANE THAT RUNS has completed its own budget of looks on this cigar,
//     and there is at least one such lane". Since that is evaluated at rollup
//     time, a lane going live silently makes a cached `exhausted` stale until the
//     next finalize. Every read surface must go through @cj/domain's
//     enrichmentCoverageForCigar / -ForRequest, which recompute from the ledger.
//     Two states are NOT exhausted and the column cannot express either: no lane
//     counts at all, and every counted lane burned its error budget without
//     finishing a look. Both stay `pending` here — "nobody could look" is a
//     different fact from "we looked and found nothing".
//
//   `attempts` — total COMPLETED looks across all vendors. Reporting only; it is
//     never a budget again (the budget is per (request, vendor) in the ledger).
//     Rows predating 0023 keep their vendor-blind count, which is still true as a
//     count of looks — that is why the migration leaves it alone.
//
//   `in_progress` — no longer written by the drain. It was a request-level lock
//     on a per-vendor operation: with two lanes it let one vendor skip a row
//     another was looking at, and a crash stranded the row where nothing
//     re-selected it (#157 defect 2). The value stays in the enum for legacy rows
//     and for a future per-vendor claim; the drain treats it as open.
export const enrichmentRequests = pgTable(
  "enrichment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cigarId: uuid("cigar_id")
      .notNull()
      .references(() => cigars.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id),
    status: text("status")
      .$type<"pending" | "in_progress" | "fulfilled" | "exhausted">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    note: text("note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("enrichment_requests_status_idx").on(table.status, table.createdAt)],
);

export type EnrichmentRequestRow = typeof enrichmentRequests.$inferSelect;
export type NewEnrichmentRequestRow = typeof enrichmentRequests.$inferInsert;
