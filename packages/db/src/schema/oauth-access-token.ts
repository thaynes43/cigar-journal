import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { oauthClient } from "./oauth-client.js";
import { users } from "./users.js";

// Short-lived (~1h) audience-bound access tokens (RFC 8707), ADR-004/005. Opaque
// to clients and stored as a SHA-256 hash, so any process — notably the
// out-of-process MCP resource server — validates a bearer token by hash lookup
// via @cj/db alone. `familyId` links a token to its refresh chain so revoking
// the chain invalidates outstanding access tokens too.
export const oauthAccessToken = pgTable("oauth_access_token", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  familyId: uuid("family_id"),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  resource: text("resource").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OAuthAccessTokenRow = typeof oauthAccessToken.$inferSelect;
export type NewOAuthAccessTokenRow = typeof oauthAccessToken.$inferInsert;
