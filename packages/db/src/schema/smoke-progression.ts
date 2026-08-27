import { pgTable, uuid, text, integer, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { smokes } from "./smokes.js";

// One row per Progression Entry (ADR-003 — relational because analytics filter
// on descriptors). Append-only through edits; ordinal is unique per smoke.
export const smokeProgression = pgTable("smoke_progression", {
  id: uuid("id").primaryKey().defaultRandom(),
  smokeId: uuid("smoke_id")
    .notNull()
    .references(() => smokes.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  stage: text("stage"),
  approximatePosition: numeric("approximate_position"),
  descriptors: text("descriptors")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  specificDescriptors: text("specific_descriptors")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  verbatim: text("verbatim"),
});

export type SmokeProgressionRow = typeof smokeProgression.$inferSelect;
export type NewSmokeProgressionRow = typeof smokeProgression.$inferInsert;
