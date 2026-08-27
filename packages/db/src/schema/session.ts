import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Better Auth session table (ADR-004). DB-backed sessions — no in-memory auth
// state, so replicas share them. Column names are snake_case (house DDL) but the
// Drizzle property keys are Better Auth's field names, which its adapter indexes
// by. Authoritative DDL lives in migration 0002; `id` defaults to gen_random_uuid.
export const session = pgTable("session", {
  id: uuid("id").primaryKey().defaultRandom(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export type SessionRow = typeof session.$inferSelect;
export type NewSessionRow = typeof session.$inferInsert;
