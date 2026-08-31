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
- `0019_brand_images.sql` — `brand_images` (ADR-007 third binding, issue #127):
  one Wikidata/Commons image per `brand_slug`, the wall-cover fallback where no
  member cigar has a product photo. `status` is the lookup outcome (also the
  negative cache), `rights` the display gate; a CHECK makes stored bytes without
  their attribution unrepresentable.
- `0020_cigar_merges.sql` — per-merge bookkeeping (#45): one `cigar_merges` row
  per merge, written in the merge's transaction, holding the exact row ids that
  moved and full payloads of the want/favorite de-dupe deletes. Unmerge claims it
  with a conditional `undone_at` UPDATE (single-use, like `photo_upload_tokens`).
  Merges audited before this migration have no ledger and report non-reversible.
- `0021_oauth_service_client.sql` — `oauth_client.is_service` (boolean, default
  false) plus a partial unique index on `client_name WHERE is_service`
  (ADR-011): marks a client an operator created to carry a long-lived service
  token, and makes "one service client per consumer" a database invariant. DCR
  never sets the flag, so every flow-registered client stays false.
- `0022_invites.sql` — invite-gated registration (ADR-010, issue #46): `invites`
  binds one email to a SHA-256-hashed link token with a 7-day expiry, revocation,
  and two-phase redemption (`redeemed_at` is the atomic burn, `redeemed_by` the
  claim once sign-up succeeded — the in-flight state a stateless auth hook reads
  as its authorization). No role column, deliberately: an invite has no role
  field to escalate. A partial unique index keeps at most one open invite per
  address.
- `0023_enrichment_attempts.sql` — `enrichment_attempts`, one row per
  (enrichment_request, vendor) (ADR-006 amendment 2026-08-30, issue #158). A
  vendor's catalogue is PARTIAL, so "no match at Fox" is evidence about Fox and
  nothing else; the pre-0023 budget was one counter per REQUEST shared across the
  whole fleet, which retired a request after a single look from each vendor. Each
  vendor now gets its own `attempts` (completed looks) and `errors` (looks that
  could not complete, reset by any completed look), and the rollup over this
  table plus the lanes that actually run (crawl-enabled, focus covers the market,
  has completed an `enrich` run) — not `enrichment_requests.status` — is the
  authority on `exhausted`. Burning the error budget retires a (request, vendor)
  without exhausting the request: zero completed looks is not a catalogue fact. The UNIQUE
  `(request_id, vendor_id)` doubles as the ON CONFLICT target that makes the
  increment atomic. **The ledger starts empty and that is deliberate:** the old
  counter is vendor-blind, so splitting it would mean inventing which vendor
  spent it, and the only inference available (overlapping succeeded `enrich`
  runs) credits a run that may have drained a different request entirely. It
  costs at most `ATTEMPTS_PER_VENDOR` extra looks per open request per live
  vendor, once. `enrichment_requests.attempts` is left as-is (a still-true count
  of looks); existing `exhausted` rows are not reset — they read as not-exhausted
  against an empty ledger and re-retire per vendor, which is the intended
  semantics, since the original retirement was vendor-blind. The backfill only
  normalizes legacy `in_progress` rows to `pending`: the drain no longer writes
  that state and nothing would re-select them.
- `0024_audit_log_client_id.sql` — `audit_log.client_id` (nullable text, plus a
  partial index on `(client_id, created_at desc)`): which OAuth client's
  credential drove the write (ADR-011). The table already answered who
  (`user_id`), from where (`actor`) and in which batch (`run_id`), but every
  token a user holds looked identical in it — so "one client per consumer, and
  therefore a leak is attributable" was untrue on the write side. Curation
  writes stamp it from the server-derived `Principal`; the web console has no
  OAuth client and stays null. No FK: the audit log is append-only history that
  must outlive the client row it names.
- `0026_taxonomy_registries.sql` — the reference entities above the leaf
  (ADR-012, issue #196 Wave 1): `brands` → `lines` → `blends`, plus `blenders`
  and the `blend_blenders` credit join, each with a canonical name, a stable
  slug and an alias list. `cigars` gains nullable `brand_id`/`line_id`/`blend_id`
  (ON DELETE SET NULL — retiring a registry row must never delete a cigar) and
  `name_source` (`freeform`|`composed`), the switch that makes `canonical_name` a
  maintained projection in Wave 2. `brand_images` gains a nullable `brand_id`;
  `brand_slug` keeps working untouched until Wave 5 retires it.
  **Ancestry consistency is NOT enforced in SQL.** A cigar's line must belong to
  its brand and its blend to its line, but that rule lives in `@cj/domain`
  (`assertCigarAncestry`, `packages/domain/src/cigar-ancestry.ts`) — it has to
  report which level disagrees as a field-level error, and Wave 3 curation
  re-parents all three columns in one statement.
  The backfill is **mechanical only**: one `brands` row per distinct non-blank
  trimmed `cigars.brand` (36 in production), slugged with the SAME rule as
  `brandSlug()` so the result equals the key existing brand URLs and
  `brand_images.brand_slug` already resolve through — which is why `Padrón`
  slugs to `padr-n` and the accent-folded `Padron` is seeded as an *alias*
  instead (the stored key never folds; folding is for matching, as `fold()` in
  the crawler already establishes). Spellings that collapse onto one slug
  (`Davidoff`/`davidoff`, `H Upmann`/`H. Upmann`) become one brand: the most-used
  spelling wins the name, the rest become aliases. It mints no lines, no blends
  and no blenders, attaches none of the 565 unbranded rows, and edits no names —
  all of that is Wave 3 curation, which needs evidence and an audit trail. Both
  statements are idempotent.
