import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// The person or team credited with a blend (ADR-012 amendment 2026-08-31,
// migration 0026). Global rather than per-brand, for two reasons the data
// forces: a blender's work spans brands, and collaborations exist — so credit
// is a many-to-many edge (`blend_blenders`), never a column on `blends`.
//
// Cuban blends typically credit no individual blender. That is a fact about the
// industry, not a gap to fill: such a blend simply has no `blend_blenders` row,
// and blender-level rollups cover the NC side only.
export const blenders = pgTable(
  "blenders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("blenders_aliases_gin").using("gin", table.aliases)],
);

export type BlenderRow = typeof blenders.$inferSelect;
export type NewBlenderRow = typeof blenders.$inferInsert;
