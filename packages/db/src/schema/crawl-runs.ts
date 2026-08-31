import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { vendors } from "./vendors.js";

// Durable audit of crawler executions (ADR-006): one row per run, stats in
// JSONB (pages fetched, listings parsed, offers written, photos captured).
export const crawlRuns = pgTable(
  "crawl_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    kind: text("kind").$type<"seed" | "offers" | "enrich">().notNull(),
    status: text("status").$type<"running" | "succeeded" | "failed">().notNull().default("running"),
    stats: jsonb("stats"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // Two reads share this index (migration 0025): per-vendor enrich LIVENESS —
    // when did this lane last start a run that succeeded (#185) — and the
    // stranded-run sweep's "any row still `running` for this (vendor, kind)?"
    // (#155).
    index("crawl_runs_vendor_kind_started_idx").on(
      table.vendorId,
      table.kind,
      table.status,
      table.startedAt.desc(),
    ),
  ],
);

export type CrawlRunRow = typeof crawlRuns.$inferSelect;
export type NewCrawlRunRow = typeof crawlRuns.$inferInsert;
