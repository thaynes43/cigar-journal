import { pgTable, uuid, text, integer, numeric, date, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { cigars } from "./cigars.js";
import { vendors } from "./vendors.js";

// A user's acquisition record (its own root — deliberately not folded into
// Smoke; a purchase is not an experience). No invariants beyond ownership.
export const purchases = pgTable("purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  cigarId: uuid("cigar_id")
    .notNull()
    .references(() => cigars.id),
  purchasedAt: date("purchased_at"),
  quantity: integer("quantity"),
  packaging: text("packaging"),
  boxDate: date("box_date"),
  humidorAt: date("humidor_at"),
  pricePerStick: numeric("price_per_stick"),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  notes: text("notes"),
  // Provenance: null for the legacy ledger import, 'llm-conversation' for
  // conversational rows (including negative-quantity corrections), 'manual'
  // for web entry. The ledger is append-only; holdings stay derived.
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PurchaseRow = typeof purchases.$inferSelect;
export type NewPurchaseRow = typeof purchases.$inferInsert;
