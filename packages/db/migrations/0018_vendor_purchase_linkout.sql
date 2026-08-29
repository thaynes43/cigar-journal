-- 0018_vendor_purchase_linkout — per-vendor "is this a place to buy?" flag
-- (owner ruling 2026-08-29, ADR-006). A crawled vendor whose offers feed
-- price-at-a-glance/history and whose images feed product photos is NOT
-- automatically a purchase destination: Cuban Lou's is crawled for inventory
-- depth but, off the r/cubancigars approved list, is never presented as a place
-- to buy. `purchase_linkout=false` drops the listing link-out on the detail page
-- and keeps the row plain, unapproved-labeled text. Defaults true so every
-- existing vendor (Fox, ad-hoc sources) keeps its link-out unchanged.
ALTER TABLE vendors
  ADD COLUMN purchase_linkout boolean NOT NULL DEFAULT true;
