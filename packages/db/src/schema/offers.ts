import { pgTable, uuid, text, boolean, integer, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";
import { vendors } from "./vendors.js";
import { cigars } from "./cigars.js";
import { listingMatches } from "./listing-matches.js";

// A price/stock observation for a cigar at a point in time (Market context) —
// the single price-observation store (ADR-009). Append-only by convention: a
// timestamped series, never updated in place. Every row carries a source — a
// registry `vendorId` OR a named ad-hoc `sourceName` (the vendor-or-source CHECK,
// migration 0011) — never neither. Crawler rows reach their cigar through
// `listingMatchId` (the curator-re-pointable link); ad-hoc/chat rows record the
// catalog cigar directly in `cigarId`. Each packaging tier is its own series on
// the same cigar (owner ruling); `pricePerStickCents` is the comparison axis,
// stored (not derived) so sorting/history read cheap. `raw` holds the shapeless
// crawl payload (ADR-003).
export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable since 0011 — a registry vendor OR a named ad-hoc source, never both null.
  vendorId: uuid("vendor_id").references(() => vendors.id),
  // Direct catalog link for observations with no vendor listing (chat-submitted).
  cigarId: uuid("cigar_id").references(() => cigars.id, { onDelete: "cascade" }),
  listingUrl: text("listing_url"),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  price: numeric("price"),
  currency: text("currency"),
  inStock: boolean("in_stock"),
  // Packaging tier + per-stick economics (ADR-009). packaging is free text
  // (single / 5-pack / box / …); pricePerStickCents is computed when derivable.
  packaging: text("packaging"),
  sticksPerPackage: integer("sticks_per_package"),
  pricePerStickCents: integer("price_per_stick_cents"),
  priceType: text("price_type").$type<"retail" | "msrp" | "sale">().notNull().default("retail"),
  // Named ad-hoc source (not a registry vendor); required by CHECK when vendorId is null.
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  listingMatchId: uuid("listing_match_id").references(() => listingMatches.id),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OfferRow = typeof offers.$inferSelect;
export type NewOfferRow = typeof offers.$inferInsert;
