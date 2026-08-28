import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { cigars } from "./cigars.js";

// The single per-user want mark (PRD-003 R-WANT-1, DESIGN-002). Independent of
// holdings and smokes: smoking never clears it, acquisition only offers the
// clear. `(user_id, cigar_id)` is UNIQUE so set/clear is a target-state idempotent
// upsert/delete. The authoritative DDL — the FKs, the UNIQUE pair, ON DELETE
// CASCADE, the user index — lives in migration 0009; this carries query types.
// List-ready (R-WANT-4): `wants` becomes the seeded system list when lists land,
// with no reshaping of this row.
export const wants = pgTable(
  "wants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cigarId: uuid("cigar_id")
      .notNull()
      .references(() => cigars.id, { onDelete: "cascade" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.userId, table.cigarId)],
);

export type WantRow = typeof wants.$inferSelect;
export type NewWantRow = typeof wants.$inferInsert;
