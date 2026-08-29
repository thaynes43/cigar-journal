-- 0017_listing_match_decided_by — record WHO last decided a listing→cigar link
-- (ADR-006 curator-outranks-crawler). Before this, upsertListingMatch protected
-- only a `confirmed` row from a re-crawl; a curator/agent who set a link
-- `unmatched` (or re-`auto`'d it) was silently flipped back to the crawler's
-- guess on the next run. `decided_by` makes the provenance explicit so the
-- crawler preserves ANY non-crawler decision, not just `confirmed`.
--   crawler — the resolver's own guess (auto|unmatched); freely re-writable.
--   curator — a human verdict via setListingMatchStatus (web console).
--   agent   — an operations-agent verdict via setListingMatchStatus (MCP).
-- Backfilled to 'crawler' for every existing row by the column DEFAULT; the
-- guard also keeps honoring status='confirmed' so legacy curator confirms stay
-- protected regardless of the backfilled provenance (see match.ts).
ALTER TABLE listing_matches
  ADD COLUMN decided_by text NOT NULL DEFAULT 'crawler'
    CHECK (decided_by IN ('crawler', 'curator', 'agent'));
