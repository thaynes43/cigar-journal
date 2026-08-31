import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { brands } from "./brands.js";

// The brand tier of ADR-007 (issue #127): one Wikidata/Wikimedia Commons image
// per brand slug, used as a wall cover ONLY where no member cigar has a servable
// product photo. Keyed on brandSlug(brand) — there is no brands table; the slug
// is the join key the URL contract already resolves through.
//
// `status` is the lookup outcome and `rights` the display gate; they are
// independent (a resolved image still waits on the rights gate). One row per
// slug also serves as the negative cache — see migration 0019.

// The lookup outcome. `resolved` means one qualified entity; `ambiguous` parks
// the candidates for a curator; `no_image` (entity found, no P18) is deliberately
// distinct from `no_match` so a cheap later re-check can pick it up; `blocked` is
// a licence/media refusal, recorded so the job never re-downloads it blindly.
export type BrandImageStatus = "resolved" | "ambiguous" | "no_match" | "no_image" | "blocked" | "error";

// The same three values and semantics as ProductPhotoRights: `suppressed` is a
// takedown that is never served and never re-resolved.
export type BrandImageRights = "pending" | "approved" | "suppressed";

// One candidate entity considered during disambiguation, persisted verbatim when
// the lookup was ambiguous so a curator can choose without a second crawl.
export interface BrandImageCandidate {
  qid: string;
  label: string | null;
  description: string | null;
  imageFile: string | null;
  score: number;
  reasons: string[];
}

export const brandImages = pgTable(
  "brand_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandSlug: text("brand_slug").notNull().unique(),
    // The registry row this image belongs to (ADR-012, migration 0026).
    // Nullable: an image may resolve for a slug with no catalog cigar behind it
    // yet. `brandSlug` above stays the working key and every current reader is
    // unchanged — Wave 5 retires it once this column carries the joins.
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
    brandName: text("brand_name").notNull(),
    status: text("status").$type<BrandImageStatus>().notNull().default("no_match"),
    rights: text("rights").$type<BrandImageRights>().notNull().default("pending"),
    wikidataQid: text("wikidata_qid"),
    entityUrl: text("entity_url"),
    commonsFile: text("commons_file"),
    // The Commons file description page — the link the credit points at.
    sourceUrl: text("source_url"),
    licenseCode: text("license_code"),
    licenseName: text("license_name"),
    licenseUrl: text("license_url"),
    artist: text("artist"),
    creditLine: text("credit_line"),
    attributionRequired: boolean("attribution_required").notNull().default(true),
    objectKey: text("object_key").unique(),
    thumbKey: text("thumb_key").unique(),
    contentType: text("content_type"),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    candidates: jsonb("candidates").$type<BrandImageCandidate[]>(),
    note: text("note"),
    runId: text("run_id"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("brand_images_status_idx").on(table.status, table.checkedAt),
    index("brand_images_brand_id_idx").on(table.brandId),
  ],
);

export type BrandImageRow = typeof brandImages.$inferSelect;
export type NewBrandImageRow = typeof brandImages.$inferInsert;
