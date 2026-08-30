import { pgTable, uuid, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { cigars } from "./cigars.js";
import { auditLog } from "./audit-log.js";

// One row per merge — the bookkeeping that makes unmerge an inverse rather than
// a guess (#45, migration 0020). Written in the merge's own transaction; claimed
// by a conditional `undone_at` UPDATE on unmerge, so a merge is undone at most
// once. The authoritative DDL (FKs, UNIQUE audit_id, the source<>target CHECK,
// the partial live-target index) lives in migration 0020; this carries the query
// types.

// The `moves` ledger, versioned so a future shape change can be read alongside
// v1 rows rather than rewriting them. `moved` holds the exact row ids the merge
// re-pointed, captured from its own RETURNING clauses — an explicit list, so
// rows created on the survivor AFTER the merge are structurally excluded from
// any restore. `dropped` holds FULL payloads of the want/favorite de-dupe
// DELETEs (the merge's only destructive step), because restoring a deleted mark
// means re-inserting its identity, not re-pointing a surviving row.
export interface CigarMergeMovedIds {
  smokes: string[];
  purchases: string[];
  listingMatches: string[];
  offers: string[];
  enrichmentRequests: string[];
  productPhotos: string[];
  wants: string[];
  favorites: string[];
}

// A want/favorite row the merge de-duped away, verbatim enough to re-create it.
export interface CigarMergeDroppedMark {
  id: string;
  userId: string;
  note: string | null;
  createdAt: string; // ISO
}

export interface CigarMergeLedgerV1 {
  version: 1;
  // The source's lifecycle columns before the merge tombstoned it — restored
  // verbatim, so unmerging a cigar that was `excluded` before does not silently
  // promote it to `active`.
  sourceBefore: { catalogStatus: "active" | "excluded" | "merged"; mergedInto: string | null };
  moved: CigarMergeMovedIds;
  dropped: { wants: CigarMergeDroppedMark[]; favorites: CigarMergeDroppedMark[] };
}

export const cigarMerges = pgTable(
  "cigar_merges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceCigarId: uuid("source_cigar_id")
      .notNull()
      .references(() => cigars.id, { onDelete: "cascade" }),
    targetCigarId: uuid("target_cigar_id")
      .notNull()
      .references(() => cigars.id, { onDelete: "cascade" }),
    // The `cigar.merge` audit row; UNIQUE, so Undo resolves an audit id to one ledger.
    auditId: uuid("audit_id")
      .notNull()
      .unique()
      .references(() => auditLog.id),
    moves: jsonb("moves").$type<CigarMergeLedgerV1>().notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
    // Stamped by the unmerge's single-use claim; the undo audit id follows once
    // that audit row exists (hence no cross-column CHECK — see migration 0020).
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoAuditId: uuid("undo_audit_id").references(() => auditLog.id),
  },
  (table) => [
    index("cigar_merges_source_idx").on(table.sourceCigarId),
    index("cigar_merges_merged_at_idx").on(table.mergedAt),
  ],
);

export type CigarMergeRow = typeof cigarMerges.$inferSelect;
export type NewCigarMergeRow = typeof cigarMerges.$inferInsert;
