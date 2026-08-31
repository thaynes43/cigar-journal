import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// The marca — the top of the Brand → Line → Blend → Vitola taxonomy (ADR-012,
// migration 0026). One row per brand, with a stable slug for URLs and facets and
// an alias list that carries every other spelling the brand answers to.
//
// `slug` COMES IN TWO FLAVORS, and reading it as one rule is the mistake to
// avoid. Migration 0026 minted every seeded row with brandSlug(name) from
// @cj/domain catalog-browse.ts — the same key today's brand URLs and
// `brand_images.brand_slug` resolve through — and that rule does not strip
// accents, so `Padrón` is stored as `padr-n`. Rows minted from TypeScript since
// Wave 3 fold first (`mintRegistrySlug`), so a marca registered today is
// `padron`, not `padr-n`: the accented cohort 0026 transcribed keeps its ugly
// key until the Wave 5 rename+redirect, and new rows do not inherit it.
//
// Consequence for anyone RESOLVING a name to a row: derive both spellings
// (`registrySlugCandidates`) or probe `aliases`, which carries both regardless
// of flavor. A lookup hard-coded to either rule finds only half the registry.
// See 0026 for why agreement outranked prettiness for the seeded rows.
//
// `aliases` is the anchor of matching v2 (Wave 2): a vendor listing resolves to
// a brand by alias before line, blend or vitola are considered at all. It holds
// MATCHING KEYS, NOT DISPLAY TEXT — every entry is already folded and slugged
// (`padron`, `h-upmann`), the exact output of the normalization the matcher runs
// over an incoming string, so the anchor step is one exact-match probe against
// the GIN index. The display spelling lives in `name`; a source-case string
// stored here would never be probed for. Each key resolves to exactly one brand.
export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    // Matching keys, not display spellings — see the note above.
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
