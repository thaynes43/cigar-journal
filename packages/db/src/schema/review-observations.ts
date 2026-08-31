import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  jsonb,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { cigars } from "./cigars.js";
import { blends } from "./blends.js";
import { vendors } from "./vendors.js";

// One external review's score (ADR-013 §2, migration 0028) — the ADR-009
// price-observation pattern applied to reviews, with one difference in shape:
// `offers` is an append-only series, while a review is one verdict at one URL, so
// the idempotency key is a real UNIQUE (source, url) and a re-crawl updates in
// place rather than appending.
//
// SCORES, LINKS AND SHORT EXCERPTS ONLY. Reviewer prose is copyrighted; the
// aggregate is our product, not theirs. The excerpt's length bound lives in the
// migration as a CHECK and in @cj/domain as a refusal — see review-scores.ts and
// review-observations.ts.
//
// The CHECK constraints (the scale enum, the length bounds, and the
// exactly-one-target rule) are in the migration, which is the authoritative DDL;
// this definition carries the query-time types.
export const reviewObservations = pgTable(
  "review_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The stable ingestion key — the crawler's adapter slug, lowercased. Half of
    // the idempotency key, so it deliberately outlives registry churn: a renamed
    // or re-added `vendors` row must not make every review re-ingest as new.
    source: text("source").notNull(),
    // The registry link when the source is registered. Nullable because ADR-013
    // expects agents to bring scores from sites the registry does not carry, the
    // way ADR-009 opened `offers` to named ad-hoc sources.
    sourceId: uuid("source_id").references(() => vendors.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    reviewer: text("reviewer"),
    // The native scale and the score as the source wrote it, kept beside the
    // normalized number so the normalization convention can be restated later and
    // the corpus recomputed without a re-crawl.
    nativeScale: text("native_scale").$type<"0-100" | "0-10" | "0-5-stars" | "letter">().notNull(),
    nativeScore: text("native_score").notNull(),
    // numeric(5,2) — Drizzle hands numerics back as strings, like `offers.price`.
    normalizedScore: numeric("normalized_score").notNull(),
    // Day precision, as reviewers state it; `date`, not timestamptz, so no
    // timezone is invented for a publication day.
    reviewedAt: date("reviewed_at"),
    excerpt: text("excerpt"),
    // Exactly one is set — the most specific level the SOURCE stated (ADR-013 §2).
    // A cigar-linked observation's blend is DERIVED through `cigars.blend_id` by
    // the `review_observation_scope` view, never stored twice: curation re-parents
    // leaves, and a stored copy would go stale silently.
    cigarId: uuid("cigar_id").references(() => cigars.id, { onDelete: "cascade" }),
    blendId: uuid("blend_id").references(() => blends.id, { onDelete: "no action" }),
    raw: jsonb("raw"),
    // Liveness vs change: a re-crawl that finds the review unchanged bumps
    // `lastSeenAt` and leaves `updatedAt` alone.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The index shapes match migration 0028 exactly, partial predicates and sort
  // order included. The migration is the authoritative DDL and drizzle-kit is
  // generation/inspection only, so nothing here creates an index — but a
  // definition that quietly disagreed would mislead the next `drizzle-kit
  // generate` into proposing a "fix" that undoes the real ones.
  (table) => [
    unique("review_observations_source_url_key").on(table.source, table.url),
    index("review_observations_cigar_idx")
      .on(table.cigarId)
      .where(sql`${table.cigarId} IS NOT NULL`),
    index("review_observations_blend_idx")
      .on(table.blendId)
      .where(sql`${table.blendId} IS NOT NULL`),
    index("review_observations_source_idx").on(table.source, table.lastSeenAt.desc()),
  ],
);

export type ReviewObservationRow = typeof reviewObservations.$inferSelect;
export type NewReviewObservationRow = typeof reviewObservations.$inferInsert;
