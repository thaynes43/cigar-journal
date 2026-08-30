# ADR-007: Photo storage substrate — one store, two bindings

- **Status:** accepted
- **Date:** 2026-08-28

## Context

Two owner-approved photo features arrive together (issues #43, #44): product
photos captured by the vendor crawler (one good shot per vitola, the cigar's
visual identity across the site) and session photos attached to individual
smokes (user or agent uploads mid-conversation, plus a web upload). They need
shared infrastructure — storage, an image pipeline, an authenticated serving
path — but different ownership, lifecycle, and display surfaces. The cluster
runs a ready Ceph RGW object store with ObjectBucketClaim provisioning
(precedent: vexa's recordings bucket).

## Decision

- **One substrate, two bindings.** A single `photos` object bucket (Ceph RGW
  via ObjectBucketClaim, claimed in the app's namespace) and one image
  pipeline serve both tiers. Binding is a property of the database row, not
  the storage layout:
  - **ProductPhoto** — bound to a catalog cigar + vitola, at most one
    displayed per vitola, sourced by the crawler (store-at-crawl), subject to
    the per-vendor rights posture in ADR-006/vendor-sources before public
    display. Curators may replace or suppress it.
  - **SmokePhoto** — bound to a smoke, 1→N with `kind`
    (cigar/band/construction/burn/other) and optional caption, owned by the
    smoke's user, sourced from web upload or the MCP `add_smoke_photo` tool
    (dual-mode contract lives in issue #44 and lands as a docs/mcp fact
    sheet with the implementation).
- **Pipeline before persistence:** decode (JPEG/PNG/HEIC), apply EXIF
  orientation, strip all EXIF/GPS metadata, normalize to web-friendly
  encodings, generate a thumbnail. Only pipeline output reaches the bucket;
  originals are not retained.
- **Serving is app-mediated.** The bucket stays private; the web app serves
  photos through an authed proxy route with cache headers (haynesnetwork
  poster-proxy pattern). Object keys are unguessable
  (`product/<cigarId>/<vitola-slug>/<uuid>.<ext>`,
  `smoke/<smokeId>/<uuid>.<ext>`) but authorization is enforced at the route,
  not by key secrecy: SmokePhotos are owner-only until public journal pages
  exist; ProductPhotos are public once their vendor rights flag allows.
- **Failure isolation:** photo ingestion never touches `save_smoke` or the
  crawler's offer writes. A failed upload or pipeline error leaves the smoke
  and the listing intact (separate tool, own envelope, own audit rows).

## Consequences

- Catalog pages and BandTile can fade to real product imagery with no schema
  rework later; smoke pages get a photo strip fed by the same proxy route.
- The OBC couples deploys to rook-ceph availability for photo features only;
  the journal core keeps working if RGW is down (photos degrade to absent —
  the null-tolerant rendering already in place).
- Stripping EXIF loses capture timestamps that could have auto-dated smokes;
  accepted for the GPS-privacy win.
- Follow-ups: bucket claim + secret wiring in haynes-ops; `photos[]` on
  `get_smoke` and `photoCount` on summaries; curation-queue surface for
  product-photo replacement; rights flag on the vendor registry.

## Alternatives considered

- PVC + authed proxy only — the researched fallback; rejected since RGW is
  ready in-cluster and OBC precedent exists (kept as documented fallback if
  RGW is retired).
- Two buckets (product/smoke) — no isolation benefit the row binding doesn't
  already give; doubles the claim/secret wiring.
- Public bucket with signed URLs — leaks lifetime-of-URL access, complicates
  rights gating; the proxy route keeps authorization in one place.
- Retain originals alongside normalized output — storage cost and GPS
  liability for no product need.

## Amendments

- **2026-08-29 — a third binding: BrandImage (issue #127).** Binding is a
  property of the row, so a brand-level image needs no new substrate: same
  bucket, same pipeline, same authed proxy route. **BrandImage** is bound to
  a brand *slug* (`brandSlug(brand)` — brand is free text and there is no
  brands table), at most one per slug, sourced from Wikimedia Commons via the
  crawl pod, and used ONLY as a cover where no member cigar has a servable
  product photo. Keys extend the convention with a third prefix,
  `brand/<brand_slug>/<uuid>.jpg` + `.thumb.jpg`. `product_photos` is
  untouched: a brand image is never written there and never substitutes for a
  member product photo.
  - **Attribution is part of the row, enforced by shape.** The attribution
    columns (`source_url` — the Commons file description page —
    `license_code`/`license_name`/`license_url`, `artist`, `credit_line`,
    `attribution_required`) sit alongside the keys, and a CHECK
    (`brand_images_servable_complete`) makes stored bytes without them
    unrepresentable. The rule that follows: **a Wikimedia-sourced image is
    rendered only where its credit renders with it** — the brand page hero
    shows the full linked credit; the wall tile shows the same credit as one
    muted line of plain text (the tile body is already a link, and nested
    anchors are invalid HTML). Because the invariant is *bytes and credit
    together*, the cover URL's `?v=` fingerprint is derived from the stored
    object key, not the row id: one row per slug means the id survives a
    replacement that the year-long immutable cache would otherwise miss,
    pairing old bytes with a new credit line.
  - **Licence gate before bytes.** Only `cc0` / `cc-by-*` / `cc-by-sa-*` /
    `pd-*` / public domain are downloaded; anything else, or absent licence
    metadata, records `status='blocked'` and requests nothing.
    `extmetadata.Restrictions` (e.g. `trademarked`) is recorded in `note`, not
    treated as a blocker — trademark is not copyright and a brand cover is
    nominative use. **This trademark posture is a deliberate owner-facing
    call, recorded here so it is reviewable rather than implicit.**
  - **Two axes, kept separate.** `status` is the lookup outcome (and the
    negative cache); `rights` is the display gate, with the same three values
    and semantics as `product_photos`. `suppressed` is both a takedown and a
    tombstone — never served, and never re-resolved by a later crawl.
