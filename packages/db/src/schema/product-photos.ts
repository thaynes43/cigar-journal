import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { cigars } from "./cigars.js";
import { vendors } from "./vendors.js";

// The product tier of ADR-007: at most one displayed photo per catalog cigar,
// captured at crawl (store-at-crawl) or curated. `rights` gates future public
// display; the authed catalog may show pending photos.
export type ProductPhotoRights = "pending" | "approved" | "suppressed";

export const productPhotos = pgTable("product_photos", {
  id: uuid("id").primaryKey().defaultRandom(),
  cigarId: uuid("cigar_id")
    .notNull()
    .unique()
    .references(() => cigars.id, { onDelete: "cascade" }),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  sourceUrl: text("source_url"),
  objectKey: text("object_key").notNull().unique(),
  thumbKey: text("thumb_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  bytes: integer("bytes").notNull(),
  rights: text("rights").$type<ProductPhotoRights>().notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProductPhotoRow = typeof productPhotos.$inferSelect;
export type NewProductPhotoRow = typeof productPhotos.$inferInsert;
