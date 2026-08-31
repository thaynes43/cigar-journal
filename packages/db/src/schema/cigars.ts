import { pgTable, uuid, text, integer, numeric, jsonb, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { brands } from "./brands.js";
import { lines } from "./lines.js";
import { blends } from "./blends.js";

// Shapeless per domain-model-examples.md — no query filters on it, so it stays
// JSONB (ADR-003). wrapper/binder/filler origins, all optional.
export interface Tobacco {
  wrapper?: { country?: string | null; region?: string | null; varietal?: string | null } | null;
  binder?: { country?: string | null; region?: string | null; varietal?: string | null } | null;
  filler?: { country?: string | null; region?: string | null; varietal?: string | null }[] | null;
}

// How a cigar's `canonicalName` is maintained (ADR-012). `freeform` rows own
// their string; `composed` rows derive it from their structural parts.
export type CigarNameSource = "freeform" | "composed";

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
  // Structural ancestry (ADR-012, migration 0026). Every level is nullable —
  // a cigar with an unknown line hangs directly off its brand, and unknown
  // stays NULL rather than being invented. ON DELETE SET NULL throughout:
  // retiring a registry row must never delete a cigar.
  //
  // Consistency between the three (a `lineId` must belong to `brandId`, a
  // `blendId` to `lineId`) is enforced by `assertCigarAncestry` in @cj/domain,
  // not by the database — see cigar-ancestry.ts and migration 0026.
  //
  // Wave 1 populates `brandId` only, mechanically from the free-text `brand`
  // column; `line`/`blend` are minted by Wave 3 curation. The free-text
  // `brand`/`line` columns above stay authoritative until Wave 5 retires them.
  brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
  lineId: uuid("line_id").references(() => lines.id, { onDelete: "set null" }),
  blendId: uuid("blend_id").references(() => blends.id, { onDelete: "set null" }),
  // Whether `canonicalName` is authoritative or a projection. `freeform` (every
  // row today) means the string is the identity and renameCigar edits it;
  // `composed` means it is recomposed from brand + line + blend + vitola +
  // edition and renameCigar edits the parts. Wave 2 writes the first `composed`
  // row — nothing in Wave 1 does.
  nameSource: text("name_source").$type<CigarNameSource>().notNull().default("freeform"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cigars_brand_id_idx").on(table.brandId),
  index("cigars_line_id_idx").on(table.lineId),
  index("cigars_blend_id_idx").on(table.blendId),
]);

export type CigarRow = typeof cigars.$inferSelect;
export type NewCigarRow = typeof cigars.$inferInsert;
