import { pgTable, uuid, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { cigars } from "./cigars.js";
import { users } from "./users.js";

// Curator "not duplicates" verdict for a surfaced candidate pair (ADR-006).
// Stored id-ordered (cigarAId < cigarBId, CHECK in 0008) to match the curation
// queue's c1.id < c2.id pairing; rows cascade with either cigar, so a merge or
// delete clears the now-moot verdict.
export const duplicateDismissals = pgTable(
  "duplicate_dismissals",
  {
    cigarAId: uuid("cigar_a_id")
      .notNull()
      .references(() => cigars.id, { onDelete: "cascade" }),
    cigarBId: uuid("cigar_b_id")
      .notNull()
      .references(() => cigars.id, { onDelete: "cascade" }),
    dismissedBy: uuid("dismissed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.cigarAId, table.cigarBId] })],
);

export type DuplicateDismissalRow = typeof duplicateDismissals.$inferSelect;
export type NewDuplicateDismissalRow = typeof duplicateDismissals.$inferInsert;
