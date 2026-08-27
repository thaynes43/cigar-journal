import { pgTable, uuid, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";
import { cigars } from "./cigars.js";
import { tsvector } from "./_columns.js";

// Setting of a Smoke — all optional, no query filters on it (ADR-003 JSONB).
export interface SmokeContext {
  location?: string | null;
  pairing?: string[] | null;
  occasion?: string | null;
  [key: string]: unknown;
}

// The central aggregate (ADR-002). `cigar_id` is NOT NULL — the catalog
// invariant. `smoked_at` carries its own provenance/precision. `original_markdown`
// is immutable once set (enforced in @cj/domain, not by a DB trigger). `search`
// is a generated tsvector over the narrative + impression for FTS.
export const smokes = pgTable("smokes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  cigarId: uuid("cigar_id")
    .notNull()
    .references(() => cigars.id),
  smokedAt: timestamp("smoked_at", { withTimezone: true }),
  smokedAtSource: text("smoked_at_source")
    .$type<"user" | "system-finalized" | "legacy-document" | "unknown">()
    .notNull()
    .default("unknown"),
  smokedAtPrecision: text("smoked_at_precision").$type<"minute" | "approximate" | "day">(),
  context: jsonb("context").$type<SmokeContext>(),
  overallDescriptors: text("overall_descriptors")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  draw: text("draw").$type<"excellent" | "good" | "fair" | "poor">(),
  burn: text("burn").$type<"excellent" | "good" | "fair" | "poor">(),
  smokeOutput: text("smoke_output").$type<"low" | "medium" | "high">(),
  constructionNotes: text("construction_notes"),
  strength: text("strength"),
  body: text("body"),
  liked: boolean("liked"),
  rating: integer("rating"),
  impression: text("impression"),
  journalTitle: text("journal_title"),
  journalNarrative: text("journal_narrative"),
  provenanceSource: text("provenance_source")
    .$type<"llm-conversation" | "manual" | "legacy-import">()
    .notNull(),
  provenanceClient: text("provenance_client"),
  originalMarkdown: text("original_markdown"),
  version: integer("version").notNull().default(1),
  search: tsvector("search").generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(journal_narrative, '') || ' ' || coalesce(impression, ''))`,
  ),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SmokeRow = typeof smokes.$inferSelect;
export type NewSmokeRow = typeof smokes.$inferInsert;
