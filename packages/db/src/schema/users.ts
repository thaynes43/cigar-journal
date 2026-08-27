import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { citext } from "./_columns.js";

// Minimal user identity for this slice. The auth slice (ADR-004) aligns Better
// Auth onto this table — Better Auth runs with `generateId: false` so Postgres
// keeps owning `id` — and adds the `identities`, session, and OAuth tables.
// Keep these column names/shape stable so that linking needs no migration.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  displayName: text("display_name"),
  role: text("role").$type<"user" | "admin">().notNull().default("user"),
  journalVisibility: text("journal_visibility")
    .$type<"private" | "public">()
    .notNull()
    .default("private"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
