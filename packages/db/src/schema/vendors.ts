import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Admin-managed shop registry (Market context). Cuban vendors carry an approval
// status synced from the r/cubancigars wiki; unapproved sources stay labeled.
export const vendors = pgTable("vendors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  url: text("url"),
  focus: text("focus").$type<"NC" | "CC" | "both">(),
  crawlEnabled: boolean("crawl_enabled").notNull().default(false),
  displayEnabled: boolean("display_enabled").notNull().default(false),
  // Is this vendor a place to buy? (owner ruling 2026-08-29, ADR-006, migration
  // 0018). false = offers/photos still ingested and shown, but never as a
  // purchase destination — no listing link-out; the detail page keeps the row
  // plain, unapproved-labeled text (Cuban Lou's). Defaults true.
  purchaseLinkout: boolean("purchase_linkout").notNull().default(true),
  approvalStatus: text("approval_status")
    .$type<"owner-added" | "approved" | "unapproved">()
    .notNull()
    .default("unapproved"),
  approvalNote: text("approval_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VendorRow = typeof vendors.$inferSelect;
export type NewVendorRow = typeof vendors.$inferInsert;
