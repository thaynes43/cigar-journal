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
  approvalStatus: text("approval_status")
    .$type<"owner-added" | "approved" | "unapproved">()
    .notNull()
    .default("unapproved"),
  approvalNote: text("approval_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VendorRow = typeof vendors.$inferSelect;
export type NewVendorRow = typeof vendors.$inferInsert;
