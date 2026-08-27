import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

// Better Auth verification table (ADR-004): short-lived tokens for email
// verification and password reset. Unused until those flows land, but Better
// Auth requires the table. DDL is authoritative in migration 0002.
export const verification = pgTable("verification", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VerificationRow = typeof verification.$inferSelect;
export type NewVerificationRow = typeof verification.$inferInsert;
