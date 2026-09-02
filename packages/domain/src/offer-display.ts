import { sql, type SQL } from "drizzle-orm";

// THE DISPLAY GATE (ADR-015, issue #270). "Prices are recorded from every
// crawled vendor and displayed only from tier 1; `display_enabled` stays the
// display gate" — this module is the half of that sentence the read paths were
// missing. `display_enabled` has existed since migration 0001 and is written by
// three paths (the crawler's `resolveVendor`, `--import-approved`, the importer),
// but until this module NOTHING read it: every offers read gated on
// `listing_matches.status IN ('auto','confirmed')` alone, so a tier-2 shop's
// prices rendered on every price surface the moment its listings matched.
//
// Recording is deliberately untouched. Lower tiers' offers are still WRITTEN and
// still count as stocking evidence for the evidenced market and the stockist
// facts (`enrichment-coverage.ts`) — a vendor's inventory is a fact about the
// cigar whether or not its price is shown, and gating those predicates would
// change which market a cigar is inferred to be in. Only display is gated, which
// is what makes a promotion a flag flip rather than a re-crawl.
//
// Two shapes, because `offers` carries two paths to a cigar (ADR-009) and they
// differ in whether a vendor is even present.

// The crawler/registry path: the row NAMES a registry vendor (reached through an
// auto|confirmed listing match), so the vendor is what the gate is asked about.
// `kind = 'vendor'` for the reason `everyHigherTierLookedSql` states: the
// registry also holds reviewers and reference sources, and a price surface is
// about shops. Use with an INNER `JOIN vendors v ON v.id = o.vendor_id`.
export function vendorDisplaysPricesSql(vendor: SQL): SQL {
  return sql`(${vendor}.display_enabled AND ${vendor}.kind = 'vendor')`;
}

// The direct path (`offers.cigar_id`, no listing match): a chat-submitted
// observation, which may or may not name a registry vendor. With no vendor there
// is nothing to gate on — `source_name` is the owner's own word for where the
// price came from (ADR-009), it belongs to no tier, and hiding it would delete a
// fact the tiers say nothing about. Where record_price DID resolve a registry
// vendor, the row is that vendor's price and gets that vendor's gate: the same
// shop is not display-grade through chat and hidden through the crawl. Use with
// a `LEFT JOIN vendors v ON v.id = o.vendor_id`.
export function offerIsDisplayableSql(vendorId: SQL, vendor: SQL): SQL {
  return sql`(${vendorId} IS NULL OR ${vendorDisplaysPricesSql(vendor)})`;
}
