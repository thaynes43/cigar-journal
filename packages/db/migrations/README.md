# Migrations

Numbered raw-SQL migrations, applied in order by the advisory-locked `migrate`
init container at startup (ADR-003).

- `0001_init.sql` — extensions, core tables, indexes for the Cigar Journal.
- `0002_auth.sql` — Better Auth identity substrate (ADR-004): session, account,
  verification, and rate-limit tables, plus the columns Better Auth adds to
  `users`.
- `0003_oauth.sql` — OAuth 2.1 authorization-server storage (ADR-004/005): DCR
  clients, authorization transactions + single-use PKCE codes, audience-bound
  access tokens, and rotating refresh tokens with revocation chains. Tokens are
  stored only as SHA-256 hashes so the out-of-process MCP resource server can
  validate via `@cj/db` alone.
- `0008_smoke_consumptions.sql` — explicit consumption link (ADR-008): a smoke
  deducts from the humidor only via a `smoke_consumptions` row (unique per smoke,
  cascade on delete, optional lot `purchase_id`). Includes the one-time
  heuristic backfill, `source = 'heuristic-backfill'`, that seeds existing smokes
  using the retired derivation rule; the heuristic path is deleted from
  `@cj/domain` in the same slice.
- `0011_price_observations.sql` — `offers` becomes the full price-observation
  store (ADR-009): `packaging`, `sticks_per_package`, `price_per_stick_cents`,
  `price_type` (retail|msrp|sale, default retail), `source_name`/`source_url`, and
  a direct `cigar_id` link for chat-submitted observations with no vendor listing.
  `vendor_id` becomes nullable, guarded by a vendor-or-source CHECK so every
  observation still carries a source (a registry vendor OR a named ad-hoc source).
- `0017_listing_match_decided_by.sql` — `listing_matches.decided_by`
  (crawler|curator|agent, default crawler): the crawler preserves ANY
  non-crawler decision on re-crawl, not just `confirmed` (ADR-006 curator
  outranks crawler). Backfilled 'crawler'.
- `0018_vendor_purchase_linkout.sql` — `vendors.purchase_linkout` (boolean,
  default true): a crawled vendor whose offers/photos are ingested but which is
  never presented as a place to buy (owner ruling 2026-08-29 — Cuban Lou's).
