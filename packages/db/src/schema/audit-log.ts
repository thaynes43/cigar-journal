import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { smokes } from "./smokes.js";

// Every mutation writes an audit row in the same transaction (house pattern,
// ADR-002/003). `before`/`after` are JSONB snapshots; `actor` records which
// adapter drove the change.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  actor: text("actor").$type<"web" | "mcp" | "import" | "system">().notNull(),
  action: text("action").notNull(),
  smokeId: uuid("smoke_id").references(() => smokes.id),
  before: jsonb("before"),
  after: jsonb("after"),
  correlationId: text("correlation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
