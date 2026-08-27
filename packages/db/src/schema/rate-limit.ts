import { pgTable, uuid, text, integer, bigint } from "drizzle-orm/pg-core";

// Better Auth rate-limit storage (ADR-004). DB-backed so limits are shared
// across replicas (no in-memory auth state). `last_request` is epoch millis.
// DDL is authoritative in migration 0002.
export const rateLimit = pgTable("rate_limit", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export type RateLimitRow = typeof rateLimit.$inferSelect;
export type NewRateLimitRow = typeof rateLimit.$inferInsert;
