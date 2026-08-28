import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { cigars } from "./cigars.js";
import { users } from "./users.js";

// The gap-fill queue (owner, 2026-08-28): conversational tools enqueue a
// cigar whose facts/photo are missing; the crawler's enrich runs drain it —
// targeted vendor lookups, not full crawls. `exhausted` means every enabled
// vendor was tried without a match; curation takes it from there.
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
