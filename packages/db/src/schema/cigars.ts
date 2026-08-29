import { pgTable, uuid, text, integer, numeric, jsonb, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";

// Shapeless per domain-model-examples.md — no query filters on it, so it stays
// JSONB (ADR-003). wrapper/binder/filler origins, all optional.
export interface Tobacco {
  wrapper?: { country?: string | null; region?: string | null; varietal?: string | null } | null;
  binder?: { country?: string | null; region?: string | null; varietal?: string | null } | null;
  filler?: { country?: string | null; region?: string | null; varietal?: string | null }[] | null;
}

// Catalog product (ADR-002 catalog invariant). `canonicalName` is the required
// identity; every other fact is nullable and never invented to satisfy
// taxonomy. Uniqueness is trigram-fuzzy, not a constraint — duplicates are
// reconciled by curator merge, not rejected at write time.
export const cigars = pgTable("cigars", {
  id: uuid("id").primaryKey().defaultRandom(),
  canonicalName: text("canonical_name").notNull(),
  brand: text("brand"),
  line: text("line"),
  edition: text("edition"),
  vitolaName: text("vitola_name"),
  lengthInches: numeric("length_inches"),
  ringGauge: integer("ring_gauge"),
  type: text("type").$type<"NC" | "CC">(),
  manufacturer: text("manufacturer"),
  factory: text("factory"),
  productionCountry: text("production_country"),
  tobacco: jsonb("tobacco").$type<Tobacco>(),
  blendNotes: text("blend_notes"),
  releaseYear: integer("release_year"),
  verification: text("verification").$type<"verified" | "unverified">().notNull().default("unverified"),
  // Catalog lifecycle gate (DESIGN-003 §Curation, migration 0013). `active` shows
  // everywhere; `excluded` hides from browse/search/queue but stays reachable by
  // direct id; `merged` is a tombstone folded into `mergedInto` by mergeCigars.
  // Every catalog-facing read filters to `active`.
  catalogStatus: text("catalog_status").$type<"active" | "excluded" | "merged">().notNull().default("active"),
  // The survivor a `merged` tombstone was folded into (self-FK; null otherwise).
  mergedInto: uuid("merged_into").references((): AnyPgColumn => cigars.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CigarRow = typeof cigars.$inferSelect;
export type NewCigarRow = typeof cigars.$inferInsert;
