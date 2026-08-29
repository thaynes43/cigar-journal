-- 0011_price_observations — offers becomes the full price-observation store
-- (ADR-009). The `offers` table was already an append-only, timestamped,
-- vendor-attributed price/stock series (ADR-006); this migration adds the
-- columns the owner's price-comparison + price-history requirements assumed and
-- opens the series to conversational, non-registry sources.
--
-- New columns:
--   packaging            — the SKU tier this observation priced (single / 5-pack
--                          / box / …); each packaging is its OWN series on the
--                          same cigar, never averaged (owner ruling, 2026-08-29).
--   sticks_per_package   — count backing the packaging, when known.
--   price_per_stick_cents— the comparison axis, STORED (not a view) so sorting
--                          and history read cheap; computed when derivable
--                          (price / sticks), null when not — never guessed.
--   price_type           — retail | msrp | sale, default retail.
--   source_name/url      — a named ad-hoc source for observations whose source is
--                          NOT a registry vendor (chat-submitted prices). Ad-hoc
--                          sources never mint vendor rows (registry stays
--                          admin-curated, ADR-006).
--   cigar_id             — a DIRECT catalog link. Crawler offers reach their cigar
--                          through listing_matches (the authoritative, curator-
--                          re-pointable link); an ad-hoc observation has no vendor
--                          listing, so it records the cigar here. This is the
--                          column the ADR's dedupe key "(cigar, source, packaging)"
--                          needs first-class for the non-registry path. ON DELETE
--                          CASCADE mirrors listing_matches / product_photos.
--
-- vendor_id becomes NULLABLE: every observation still carries a source, but it is
-- a registry vendor OR a named ad-hoc source — never neither. The source-presence
-- rule is a CHECK (vendor-or-source), the one FK guarantee ADR-009 trades away for
-- honest ad-hoc sourcing.

ALTER TABLE offers
  ADD COLUMN packaging             text,
  ADD COLUMN sticks_per_package    integer,
  ADD COLUMN price_per_stick_cents integer,
  ADD COLUMN price_type            text NOT NULL DEFAULT 'retail'
                                     CHECK (price_type IN ('retail', 'msrp', 'sale')),
  ADD COLUMN source_name           text,
  ADD COLUMN source_url            text,
  ADD COLUMN cigar_id              uuid REFERENCES cigars (id) ON DELETE CASCADE;

ALTER TABLE offers ALTER COLUMN vendor_id DROP NOT NULL;

-- Vendor-or-source: an observation is attributed to a registry vendor OR a named
-- ad-hoc source, never neither (ADR-009 domain rule).
ALTER TABLE offers
  ADD CONSTRAINT offers_vendor_or_source_chk
    CHECK (vendor_id IS NOT NULL OR source_name IS NOT NULL);

-- The ad-hoc/chat read path (get_cigar pricing summary, the cigar-page Prices
-- panel) resolves observations by their direct cigar link; the crawler path still
-- reads through listing_matches. Partial — only ad-hoc rows carry cigar_id.
CREATE INDEX offers_cigar_idx ON offers (cigar_id, seen_at DESC) WHERE cigar_id IS NOT NULL;
