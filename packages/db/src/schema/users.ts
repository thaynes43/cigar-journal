import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { citext } from "./_columns.js";

// User identity. The auth slice (ADR-004) aligns Better Auth onto this table —
// Better Auth runs with `generateId: false` so Postgres keeps owning `id` — and
// adds the session/account/verification tables (see ./session.ts etc.). Better
// Auth's `name` maps to `display_name`; `email_verified` and `updated_at` are
// the columns it additionally requires (added in migration 0002). Keep the
// original column names stable so identity linking needs no rename.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  displayName: text("display_name"),
  role: text("role").$type<"user" | "admin">().notNull().default("user"),
  journalVisibility: text("journal_visibility")
    .$type<"private" | "public">()
    .notNull()
    .default("private"),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
