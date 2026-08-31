import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { brands } from "./brands.js";

// A family within a brand — Drew Estate → Liga Privada (ADR-012, migration
// 0026). The middle level of the taxonomy: a line groups blends the way a brand
// groups lines.
//
// `slug` is unique per BRAND, not globally: two brands may each have a `reserva`
// and neither should have to yield the name.
//
// `brandId` is ON DELETE NO ACTION, and that is the deliberate part: deleting a
// brand that still has lines is REFUSED. Retiring a marca must not silently take
// its lines — and through them its blends — with it; emptying a brand is a
// curation decision with an audit trail, not a side effect of a stray DELETE.
// NO ACTION rather than RESTRICT because it is checked at the end of the
// statement, so it gives the same protection while still allowing a deliberate
// single-statement curation move that clears the lines and the brand together.
// A `cigars` row pointing here is unaffected either way — it is ON DELETE SET
// NULL, so a cigar never dies with its taxonomy.
//
// `lines_id_brand_id_key` is the support key a composite FK from
// `cigars (brand_id, line_id)` would need. Minted while the table is empty and
// the index is free; 0026 explains why that FK is not actually declared.
export const lines = pgTable(
  "lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "no action" }),
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
    unique("lines_id_brand_id_key").on(table.id, table.brandId),
    index("lines_aliases_gin").using("gin", table.aliases),
  ],
);

export type LineRow = typeof lines.$inferSelect;
export type NewLineRow = typeof lines.$inferInsert;
