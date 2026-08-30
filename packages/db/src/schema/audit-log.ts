import { pgTable, uuid, text, real, jsonb, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { smokes } from "./smokes.js";

// Every mutation writes an audit row in the same transaction (house pattern,
// ADR-002/003). `before`/`after` are JSONB snapshots; `actor` records which
// adapter drove the change. `agent` is the curate batch role (DESIGN-003 wave 4);
// `runId`/`confidence`/`reverts` are the attribution + reversibility substrate
// (DESIGN-003 §Curation, migration 0012) — all nullable, so human-driven callers
// leave them null and stay unchanged.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  actor: text("actor").$type<"web" | "mcp" | "import" | "system" | "agent">().notNull(),
  action: text("action").notNull(),
  smokeId: uuid("smoke_id").references(() => smokes.id),
  before: jsonb("before"),
  after: jsonb("after"),
  correlationId: text("correlation_id"),
  // The OAuth client whose credential drove this write (migration 0023,
  // ADR-011); NULL for a session-driven web call, which has no client. Recorded
  // from the server-derived Principal, never from a tool argument — it is what
  // makes an elevated service token's writes separable from the lane's own.
  clientId: text("client_id"),
  // The batch run this action belongs to ("Recent agent runs" groups on it); no
  // FK — there is no runs table. Text, not uuid: a run's identity is the
  // dev-env-ops work-order key ("wo-cigar-curate-20260829"), migration 0016.
  runId: text("run_id"),
  // The agent's score for an auto-applied proposal (0..1); null for human work.
  confidence: real("confidence"),
  // Self-link to the audit row this action undoes (restore reverts an exclude);
  // the spine of a real Undo. The audit log is append-only, so no ON DELETE rule.
  reverts: uuid("reverts").references((): AnyPgColumn => auditLog.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
