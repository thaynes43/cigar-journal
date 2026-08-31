import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { blends } from "./blends.js";
import { blenders } from "./blenders.js";

// Blend ← credited → blender (ADR-012 amendment 2026-08-31, migration 0026).
// A join table rather than a column because both directions are many:
// collaborations put two blenders on one blend, and one blender's work spans
// brands. The composite PK makes a duplicate credit unrepresentable.
//
// No row is not a gap to fill — a Cuban blend crediting no individual is the
// normal case, and blender rollups simply do not include it.
export const blendBlenders = pgTable(
  "blend_blenders",
  {
    blendId: uuid("blend_id")
      .notNull()
      .references(() => blends.id, { onDelete: "cascade" }),
    blenderId: uuid("blender_id")
      .notNull()
      .references(() => blenders.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.blendId, table.blenderId] }),
    // The reverse edge: every blend a blender is credited on. The PK already
    // covers blend → blenders.
    index("blend_blenders_blender_idx").on(table.blenderId),
  ],
);

export type BlendBlenderRow = typeof blendBlenders.$inferSelect;
export type NewBlendBlenderRow = typeof blendBlenders.$inferInsert;
