-- 0034_vendor_tiers — a vendor has a TIER, and the tier is the order of authority
-- (ADR-015, crawl audit #270). 1 is the highest; the column is smallint and
-- CHECKed to [1, 9] because a tier is an ORDINAL an admin reads and types, not a
-- score: nine bands are more than the registry will ever need and a typo outside
-- them is refused rather than silently sorting a shop to the front of the fleet.
--
-- What the number decides, and what it deliberately does not:
--   * PRICES are recorded from every crawled vendor and DISPLAYED from tier 1 —
--     `display_enabled` stays the gate, seeded true only for tier 1 (see the
--     crawler's resolveVendor). A promotion is a flag flip, not a re-crawl.
--   * The enrich drain runs in tier order and a lower tier may only take an ask
--     every higher-tier covering vendor has already looked at and missed
--     (@cj/domain `everyHigherTierLookedSql`).
--   * The one catalogue-photo slot stops being first-writer-forever: a
--     higher-tier capture REPLACES a lower tier's photo (never the reverse, and
--     `rights = 'suppressed'` is final whatever the tier).
--   * Catalog STRUCTURE has no tier — a seed walk from any enabled vendor may
--     create brand/line/leaf rows exactly as before.
--
-- DEFAULT 2, not 1. Every pre-0034 row predates the notion, and the safe reading
-- of "we never decided" is "not the price authority": a default of 1 would
-- promote every registered shop — including the ones `approved-import` mints
-- with no adapter and no probe — into the display gate on deploy.
ALTER TABLE vendors
  ADD COLUMN tier smallint NOT NULL DEFAULT 2,
  ADD CONSTRAINT vendors_tier_check CHECK (tier BETWEEN 1 AND 9);

-- The backfill, and it is only two rows because the fleet is only two vendors
-- deep (#270). Guarded on `tier = 2` — the value the ADD COLUMN just gave every
-- row — so it is idempotent and so a later deliberate re-tiering is never undone
-- by a re-run, the same discipline 0025's vendor correction uses.
--
-- Fox Cigar -> 1: an NC shop the owner buys from and links out to, and today the
-- only vendor with an offers walk, so it is already the de-facto price authority.
-- Cuban Lou's stays at the default 2: it is off the r/cubancigars approved list
-- (`approval_status = 'unapproved'`, `purchase_linkout = false`), so its offers
-- are recorded and never shown and its photos fill only what tier 1 could not.
UPDATE vendors SET tier = 1 WHERE name = 'Fox Cigar' AND tier = 2;
