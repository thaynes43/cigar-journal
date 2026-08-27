import { pgTable, uuid, text, boolean, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";
import { vendors } from "./vendors.js";
import { listingMatches } from "./listing-matches.js";

// A vendor's listing of a cigar observed by a crawl at a point in time
// (Market context). Append-only by convention — a price/stock time series,
// never updated in place. `raw` holds the shapeless crawl payload (ADR-003).
export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => vendors.id),
  listingUrl: text("listing_url"),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  price: numeric("price"),
  currency: text("currency"),
  inStock: boolean("in_stock"),
  listingMatchId: uuid("listing_match_id").references(() => listingMatches.id),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OfferRow = typeof offers.$inferSelect;
export type NewOfferRow = typeof offers.$inferInsert;
