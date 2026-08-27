import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Better Auth account table (ADR-004): one row per linked identity. Local
// email+password stores its hash here (providerId `credential`); future
// Authentik/OAuth links reuse the same table. `(issuer, account_id)` is unique.
// Property keys are Better Auth field names; DDL is authoritative in 0002.
export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.issuer, table.accountId)],
);

export type AccountRow = typeof account.$inferSelect;
export type NewAccountRow = typeof account.$inferInsert;
