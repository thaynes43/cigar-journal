import { pgTable, uuid, text, jsonb, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { smokes } from "./smokes.js";

// Retry-safety record written inside every mutation's transaction (ADR-003).
// `(user_id, client_request_id)` is UNIQUE — there is no window where the
// effect exists without its key. Replay is detected by matching the stored
// `request_fingerprint`; a different fingerprint for the same key conflicts.
// Keys retained >=90 days; timestamps are never identity.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    clientRequestId: text("client_request_id").notNull(),
    tool: text("tool").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    smokeId: uuid("smoke_id").references(() => smokes.id),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.userId, table.clientRequestId)],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;
