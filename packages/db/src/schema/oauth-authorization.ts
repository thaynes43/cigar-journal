import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { oauthClient } from "./oauth-client.js";
import { users } from "./users.js";

// A pending authorization request awaiting consent (ADR-004/005). Created by
// /oauth/authorize only for an authenticated session — `userId` is captured
// server-side, never from an argument — and consumed by the consent decision.
// Short-lived; the consent page reads it to render client name + scopes.
export const oauthAuthorization = pgTable("oauth_authorization", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  resource: text("resource").notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OAuthAuthorizationRow = typeof oauthAuthorization.$inferSelect;
export type NewOAuthAuthorizationRow = typeof oauthAuthorization.$inferInsert;
