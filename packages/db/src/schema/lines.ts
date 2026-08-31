import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { brands } from "./brands.js";

// A family within a brand — Drew Estate → Liga Privada (ADR-012, migration
// 0026). The middle level of the taxonomy: a line groups blends the way a brand
// groups lines.
//
// `slug` is unique per BRAND, not globally: two brands may each have a `reserva`
// and neither should have to yield the name. The cascade is deliberate — a line
// cannot outlive its brand, while a `cigars` row pointing at it only has its
// `line_id` nulled (ON DELETE SET NULL there).
export const lines = pgTable(
  "lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("lines_brand_id_slug_key").on(table.brandId, table.slug),
    index("lines_aliases_gin").using("gin", table.aliases),
  ],
);

export type LineRow = typeof lines.$inferSelect;
export type NewLineRow = typeof lines.$inferInsert;
