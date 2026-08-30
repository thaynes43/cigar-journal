import { pgTable, uuid, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { enrichmentRequests } from "./enrichment-requests.js";
import { vendors } from "./vendors.js";

// The per-vendor enrichment ledger (ADR-006 amendment 2026-08-30, issue #158).
// One row per (ask, vendor): the budget a single vendor has spent against a
// single enrichment_request, and what its last look concluded.
//
// It exists because a vendor's catalogue is PARTIAL. "No match at Fox" is
// evidence about Fox — never about the cigar, the canonical name, or any other
// vendor — so a budget shared across the fleet retires a request after one look
// from each vendor. Red Anchor is stocked by 2 Guys and not by Fox; both are NC
// US retailers in good standing, and `vendors.focus` cannot tell them apart.
//
// The rollup over these rows (plus the lanes that actually run) is the AUTHORITY
// for whether a request is exhausted; enrichment_requests.status is a cache of
// that verdict. `attempts` and `errors` are NOT interchangeable there: only a
// completed look is evidence about a catalogue, so a vendor retired on `errors`
// alone leaves the request blocked rather than exhausted. See @cj/domain
// enrichment-coverage.ts.
export const enrichmentAttempts = pgTable(
  "enrichment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => enrichmentRequests.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    // Completed looks — the budget. A look completes when the vendor's product
    // enumeration was non-empty AND some ranked candidate yielded a parseable
    // product: only then did we actually read the catalogue, so only then is the
    // vendor's silence evidence about the cigar rather than about the adapter.
    attempts: integer("attempts").notNull().default(0),
    // Looks that could not complete. Bounded separately so a broken vendor cannot
    // pin a request open forever, and reset by any completed look.
    errors: integer("errors").notNull().default(0),
    lastOutcome: text("last_outcome").$type<"miss" | "match" | "error">().notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (table) => [
    unique("enrichment_attempts_request_id_vendor_id_key").on(table.requestId, table.vendorId),
    index("enrichment_attempts_vendor_idx").on(table.vendorId, table.requestId),
  ],
);

export type EnrichmentAttemptRow = typeof enrichmentAttempts.$inferSelect;
export type NewEnrichmentAttemptRow = typeof enrichmentAttempts.$inferInsert;
