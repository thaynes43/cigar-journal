import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { cigars } from "./cigars.js";

// The single per-user favorite mark (PRD-003 R-WANT lineage, DESIGN-002) — the
// second cigar-level mark, mirroring `wants`. Favorite = a cigar the user LOVES,
// distinct from Want (a cigar to try/own). Independent of holdings and smokes:
// smoking never sets or clears it, acquisition does not touch it. `(user_id,
// cigar_id)` is UNIQUE so set/clear is a target-state idempotent upsert/delete.
// The authoritative DDL — the FKs, the UNIQUE pair, ON DELETE CASCADE, the user
// index — lives in migration 0010; this carries query types. List-ready: `favorites`
// joins `wants` as a seeded system list when named lists land, with no reshaping
// of this row.
export const favorites = pgTable(
  "favorites",
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

export type FavoriteRow = typeof favorites.$inferSelect;
export type NewFavoriteRow = typeof favorites.$inferInsert;
