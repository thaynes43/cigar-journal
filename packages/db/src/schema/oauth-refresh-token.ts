import { pgTable, uuid, text, jsonb, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { oauthClient } from "./oauth-client.js";
import { users } from "./users.js";

// Rotating refresh tokens (offline_access), ADR-004/005. Stored as a SHA-256
// hash. A rotation chain shares `familyId`; `rotatedAt` marks a token already
// spent — presenting it again is reuse, which revokes the whole family (theft
// detection). `revokedAt` kills an individual token; revoking every token in a
// family kills the chain (connector disconnect / connected-apps page).
export const oauthRefreshToken = pgTable("oauth_refresh_token", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  familyId: uuid("family_id").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => oauthRefreshToken.id, {
    onDelete: "set null",
  }),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  resource: text("resource").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OAuthRefreshTokenRow = typeof oauthRefreshToken.$inferSelect;
export type NewOAuthRefreshTokenRow = typeof oauthRefreshToken.$inferInsert;
