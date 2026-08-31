import { pgTable, uuid, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
    // Who last decided this link (ADR-006, migration 0017): `crawler` guesses are
    // freely re-writable; a `curator`/`agent` verdict (setListingMatchStatus) is
    // preserved by the crawler on re-crawl. Backfilled 'crawler'.
    decidedBy: text("decided_by").$type<"crawler" | "curator" | "agent">().notNull().default("crawler"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.vendorId, table.listingKey),
    // The EVIDENCED MARKET's read path (migration 0025, #170): "which
    // single-market vendors already stock this cigar?" is a correlated subquery
    // keyed here, evaluated per candidate row on every drain and backlog press.
    // Partial because an unmatched listing is evidence about nothing.
    index("listing_matches_cigar_idx").on(table.cigarId).where(sql`${table.cigarId} IS NOT NULL`),
  ],
);

export type ListingMatchRow = typeof listingMatches.$inferSelect;
export type NewListingMatchRow = typeof listingMatches.$inferInsert;
