import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// The marca — the top of the Brand → Line → Blend → Vitola taxonomy (ADR-012,
// migration 0026). One row per brand, with a stable slug for URLs and facets and
// an alias list that carries every other spelling the brand answers to.
//
// `slug` is brandSlug(name) from @cj/domain catalog-browse.ts, unchanged: the
// same key today's brand URLs and `brand_images.brand_slug` already resolve
// through. That rule does not strip accents (`Padrón` → `padr-n`); the folded
// spelling lives in `aliases`, which is what matching reads. This is the split
// `fold()` in packages/crawler/src/core/wikidata.ts already codifies — the
// stored key never folds, the matching key does — applied to the registry. See
// 0026 for why agreement outranks prettiness here.
//
// `aliases` is the anchor of matching v2 (Wave 2): a vendor listing resolves to
// a brand by alias before line, blend or vitola are considered at all.
export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    country: text("country"),
    website: text("website"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("brands_aliases_gin").using("gin", table.aliases)],
);

export type BrandRow = typeof brands.$inferSelect;
export type NewBrandRow = typeof brands.$inferInsert;
