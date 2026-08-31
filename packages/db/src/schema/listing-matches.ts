import { pgTable, uuid, text, timestamp, unique, index, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vendors } from "./vendors.js";
import { cigars } from "./cigars.js";

// The structured parse matching v2 computed for a listing (ADR-012 Wave 2,
// migration 0027). Written on a row the resolver could NOT settle to one leaf,
// so a curator inherits the parse instead of redoing it by eye. Ids are the
// registry rows the title anchored to; names ride alongside so the triage read
// needs no joins. `residue` is what was left over after brand, line, blend,
// vitola and packaging were accounted for — the part nobody could explain, and
// the most useful field on the row.
//
// EVIDENCE, NOT IDENTITY. Nothing reads this back to make a match; identity
// lives on `cigars`. That is why it is one jsonb blob and not columns.
export interface SuggestedParse {
  brandId: string | null;
  brandName: string | null;
  lineId: string | null;
  lineName: string | null;
  blendId: string | null;
  blendName: string | null;
  vitolaName: string | null;
  lengthInches: number | null;
  ringGauge: number | null;
  // The title with packaging tokens removed — what the leaf would be called if
  // this listing were minted. Packaging describes the OFFER and never survives
  // into identity (ADR-012), so it is stripped here and lives on the offer.
  cleanedName: string;
  packaging: string | null;
  sticksPerPackage: number | null;
  residue: string;
  // Why the resolver landed where it did, in the order it decided. Free text for
  // a human; never parsed.
  notes: string[];
  // WHERE THE RESOLVER STOPPED, on a row that is still linked.
  //
  // Under the positive-evidence rule a crawl that cannot re-derive an existing
  // crawler-owned link does NOT break it: registry silence is not a reason to
  // unlink, so the row keeps `status='auto'` and its `cigar_id` and carries this
  // instead. The verdict cannot go in `unmatched_reason`, which would be a lie
  // about a row that is matched — and would surface a reason on an `auto` row to
  // every reader of the triage queue. So it rides the evidence blob, which is
  // where a curator already looks.
  //
  // Absent on a row whose parse resolved cleanly, and on every row written before
  // this field existed.
  reason?: "no_anchor" | "ambiguous" | "no_match";
}

// Mapping from a vendor SKU/listing to a catalog Cigar (Market context). The
// mutable half of the Offer/Match pair; `auto` → `confirmed`/`unmatched` via
// the curation queue.
export const listingMatches = pgTable(
  "listing_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    listingKey: text("listing_key").notNull(),
    cigarId: uuid("cigar_id").references(() => cigars.id),
    status: text("status").$type<"auto" | "confirmed" | "unmatched">().notNull().default("unmatched"),
    // Who last decided this link (ADR-006, migration 0017): `crawler` guesses are
    // freely re-writable; a `curator`/`agent` verdict (setListingMatchStatus) is
    // preserved by the crawler on re-crawl. Backfilled 'crawler'.
    decidedBy: text("decided_by").$type<"crawler" | "curator" | "agent">().notNull().default("crawler"),
    // WHY a crawler-unmatched row is unmatched (migration 0025, #170). Set only by
    // the resolver, and only on a row it decided:
    //   market_refusal — a candidate cleared the similarity floor and was DECLINED
    //                    because this vendor's focus contradicts the cigar's
    //                    evidenced market. The actionable one.
    //   no_match       — nothing cleared the floor.
    //   null           — nobody's guess: an 'auto'/'confirmed' link, a
    //                    curator/agent verdict, or the excludeCigar cascade (#126),
    //                    which the triage read must keep excluded.
    // Always written by upsertListingMatch, so a re-matched row cannot keep a
    // stale reason.
    //   no_anchor      — matching v2 found no brand alias in the title at all
    //                    (0027). Seed mode used to MINT from exactly this state,
    //                    which is how every new vendor grew a parallel catalog;
    //                    it now goes to triage with `suggested_parse` attached.
    //   ambiguous      — a brand anchored and more than one of its leaves fit.
    unmatchedReason: text("unmatched_reason").$type<"market_refusal" | "no_match" | "no_anchor" | "ambiguous">(),
    // The structured parse behind an unresolved row (0027). Written on the same
    // always-write terms as `unmatched_reason` — including as null on an `auto`
    // upsert — so a row that becomes a clean link cannot keep the parse from when
    // it was an open question.
    suggestedParse: jsonb("suggested_parse").$type<SuggestedParse>(),
    // The vendor's own breadcrumb trail (0027). Parsed since the crawler was
    // written, used for one boolean category gate and discarded ever since; it is
    // the one structured taxonomy signal vendors publish (ADR-012), so it is kept
    // as parse evidence. NULL means never captured (every pre-0027 row); `{}`
    // means the page offered none.
    categoryPath: text("category_path").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.vendorId, table.listingKey),
    // The EVIDENCED MARKET's read path (migration 0025, #170): "which
    // single-market vendors already stock this cigar?" is a correlated subquery
    // keyed here, evaluated per candidate row on every drain and backlog press.
    // Partial because an unmatched listing is evidence about nothing.
    index("listing_matches_cigar_idx").on(table.cigarId).where(sql`${table.cigarId} IS NOT NULL`),
  ],
);

export type ListingMatchRow = typeof listingMatches.$inferSelect;
export type NewListingMatchRow = typeof listingMatches.$inferInsert;
