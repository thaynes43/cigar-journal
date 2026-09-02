import { pgTable, uuid, text, boolean, smallint, timestamp } from "drizzle-orm/pg-core";

// Admin-managed source registry (Market context). Cuban vendors carry an approval
// status synced from the r/cubancigars wiki; unapproved sources stay labeled.
//
// Since migration 0028 it registers more than shops: `kind` distinguishes a
// vendor from a reviewer or a reference source (ADR-013 §4). One registry with a
// discriminator rather than two tables, because `crawl_enabled`, the approval
// posture and the six tables that hang off `vendors.id` — `crawl_runs` and
// `enrichment_attempts` in particular — are the crawl mechanics of ANY source,
// and a parallel table would fork every one of them.
export const vendors = pgTable("vendors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  url: text("url"),
  // What this source IS (migration 0028, ADR-013 §4). Defaults to 'vendor', so
  // every pre-0028 row keeps meaning exactly what it meant.
  //
  // A CHECK in the migration makes a non-vendor source's `focus` NULL and its
  // `purchase_linkout` false: a reviewer stocks nothing, so any market focus it
  // carried would be a stocking claim from a site with no inventory — and
  // `evidencedMarketSql` infers a cigar's market from exactly that claim.
  kind: text("kind").$type<"vendor" | "reviewer" | "reference">().notNull().default("vendor"),
  focus: text("focus").$type<"NC" | "CC" | "both">(),
  // THE ORDER OF AUTHORITY (ADR-015, migration 0034). 1 is the highest; the
  // migration CHECKs [1, 9]. It orders three things and nothing else: which
  // vendor's offers are DISPLAYED (tier 1 only, through `display_enabled`), who
  // the enrich drain asks FIRST (a lower tier may only take an ask every
  // higher-tier covering vendor has already missed), and who may REPLACE the one
  // catalogue-photo slot. Catalog structure has no tier — every enabled vendor
  // feeds brands, lines and leaves.
  //
  // Admin data, seeded from the adapter's posture on first resolve exactly as
  // `focus` is, and never overwritten by a crawl. Defaults to 2: "nobody has
  // decided" must not mean "price authority".
  tier: smallint("tier").notNull().default(2),
  crawlEnabled: boolean("crawl_enabled").notNull().default(false),
  // May this vendor's offers be SHOWN? True only for tier 1 as seeded (ADR-015);
  // lower tiers' offers are still recorded, so promoting a shop is a flag flip
  // rather than a re-crawl. An admin's value on an existing row always wins.
  //
  // WRITTEN, NOT YET READ (2026-09-02): no offers read path joins on this column —
  // `reads.ts` latestSeries and catalog-browse's OFFER_JOIN gate on the listing
  // match's status alone. So the tier decides what this column says and the column
  // does not yet decide what renders.
  displayEnabled: boolean("display_enabled").notNull().default(false),
  // Is this vendor a place to buy? (owner ruling 2026-08-29, ADR-006, migration
  // 0018). false = offers/photos still ingested and shown, but never as a
  // purchase destination — no listing link-out; the detail page keeps the row
  // plain, unapproved-labeled text (Cuban Lou's). Defaults true.
  purchaseLinkout: boolean("purchase_linkout").notNull().default(true),
  approvalStatus: text("approval_status")
    .$type<"owner-added" | "approved" | "unapproved">()
    .notNull()
    .default("unapproved"),
  approvalNote: text("approval_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VendorRow = typeof vendors.$inferSelect;
export type NewVendorRow = typeof vendors.$inferInsert;
