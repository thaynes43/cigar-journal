import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { smokes } from "./smokes.js";
import { purchases } from "./purchases.js";

// Explicit consumption link (ADR-008): one row means this Smoke consumed one
// stick from the caller's holdings. No row means the stick came from elsewhere
// (lounge, gift, sample) or predates this model. User and cigar derive through
// the smoke — nothing denormalized to drift. A Smoke is one physical cigar
// (ADR-002), so quantity is structural, never a column. The authoritative DDL —
// the unique/cascade constraints and CHECK — lives in migration 0008.
export const smokeConsumptions = pgTable("smoke_consumptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  smokeId: uuid("smoke_id")
    .notNull()
    .unique()
    .references(() => smokes.id, { onDelete: "cascade" }),
  // Lot attribution when stated or picked (nullable — an unattributed stick).
  purchaseId: uuid("purchase_id").references(() => purchases.id),
  // 'user' for an explicit capture; 'heuristic-backfill' for the one-time seed.
  source: text("source").$type<"user" | "heuristic-backfill">().notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SmokeConsumptionRow = typeof smokeConsumptions.$inferSelect;
export type NewSmokeConsumptionRow = typeof smokeConsumptions.$inferInsert;
