import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { vendors } from "./vendors.js";
import { cigars } from "./cigars.js";

// Mapping from a vendor SKU/listing to a catalog Cigar (Market context). The
// mutable half of the Offer/Match pair; `auto` → `confirmed`/`unmatched` via
// the curation queue.
export const listingMatches = pgTable(
  "listing_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    listingKey: text("listing_key").notNull(),
    cigarId: uuid("cigar_id").references(() => cigars.id),
    status: text("status").$type<"auto" | "confirmed" | "unmatched">().notNull().default("unmatched"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.vendorId, table.listingKey)],
);

export type ListingMatchRow = typeof listingMatches.$inferSelect;
export type NewListingMatchRow = typeof listingMatches.$inferInsert;
