import { pgTable, uuid, text, jsonb, boolean, timestamp } from "drizzle-orm/pg-core";

// DCR-registered OAuth clients (RFC 7591), ADR-004/005. `clientId` is the public
// handle returned to the client; `clientSecretHash` is present only for
// confidential clients (public PKCE clients register with auth method 'none' and
// carry no secret). `redirectUris` are exact-match validated at /oauth/authorize.
// `isService` (migration 0021, ADR-011) marks an operator-minted service client:
// DCR never sets it, so it partitions "registered by a browser flow" from
// "created by the service-token CLI" without inspecting redirect URIs.
// Authoritative DDL lives in migrations 0003 and 0021.
export const oauthClient = pgTable("oauth_client", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name"),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  grantTypes: jsonb("grant_types").$type<string[]>().notNull(),
  responseTypes: jsonb("response_types").$type<string[]>().notNull(),
  scope: text("scope"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  isService: boolean("is_service").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OAuthClientRow = typeof oauthClient.$inferSelect;
export type NewOAuthClientRow = typeof oauthClient.$inferInsert;
