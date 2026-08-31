import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { lines } from "./lines.js";

// The recipe within a line — Liga Privada → No. 9 (ADR-012, migration 0026).
// The level where the flat model failed worst: trigram similarity ranks
// `No. 9` and `T52` as near-duplicates while true sibling vitolas score below
// 0.5, so blend identity has to be a key rather than a string comparison.
//
// Wrapper variants marketed as separate products (Padron Maduro / Natural) are
// DISTINCT blends, because that is how they are sold.
//
// There is no photo column here: blend-level imagery is a later wave. Vitola is
// not a column either — a vitola is a size label within a blend, carried on the
// leaf `cigars` row, not an entity (ADR-012 rejects a global vitolas table).
//
// `lineId` is ON DELETE NO ACTION for the same reason as `lines.brandId`: a line
// that still has blends cannot be deleted by accident, while a deliberate
// single-statement curation move that clears both still works. See lines.ts.
export const blends = pgTable(
  "blends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => lines.id, { onDelete: "no action" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Filler, binder and wrapper are a required DOCUMENTATION TARGET on every
    // blend (owner ruling 2026-08-31, ADR-012): they are what lets similar
    // blends correlate to similar tasting notes. Required-target means
    // enrichment pursues them and a worklist tracks the gaps — never that a
    // value is invented, so NULL keeps meaning "not yet known".
    wrapper: text("wrapper"),
    binder: text("binder"),
    filler: text("filler"),
    strength: text("strength"),
    blendNotes: text("blend_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("blends_line_id_slug_key").on(table.lineId, table.slug),
    unique("blends_id_line_id_key").on(table.id, table.lineId),
    index("blends_aliases_gin").using("gin", table.aliases),
  ],
);

export type BlendRow = typeof blends.$inferSelect;
export type NewBlendRow = typeof blends.$inferInsert;
