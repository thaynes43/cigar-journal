import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { oauthClient } from "./oauth-client.js";
import { users } from "./users.js";

// Single-use authorization codes (RFC 6749 + PKCE S256), ADR-004/005. Stored as
// a SHA-256 hash — never plaintext. Consumed exactly once at /oauth/token;
// `consumedAt` is set on first exchange so a replayed code is detected and the
// whole grant can be treated as compromised.
export const oauthAuthorizationCode = pgTable("oauth_authorization_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull().unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  resource: text("resource").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OAuthAuthorizationCodeRow = typeof oauthAuthorizationCode.$inferSelect;
export type NewOAuthAuthorizationCodeRow = typeof oauthAuthorizationCode.$inferInsert;
