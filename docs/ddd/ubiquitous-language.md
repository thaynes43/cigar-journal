# Ubiquitous Language

Terms used in code, docs, and conversation. Singular, capitalized when used as
a domain term. Trade vocabulary the catalog must speak but does not model as
types — marca, vitola de galera, Edición Limitada, wrapper varietals — is in
[`cigar-industry-vocabulary.md`](cigar-industry-vocabulary.md).

| Term | Meaning |
|---|---|
| **User** | An account holder. Owns Smokes and Purchases; has a journal visibility setting (`private`/`public`). |
| **Identity** | One way a User authenticates: local credentials or a linked OIDC account (Authentik). Many Identities → one User. |
| **Cigar** | The catalog leaf: **one Blend in one Vitola** — the thing you light (ADR-012). Carries the required **canonical name** ("Atabey Divinos"), nullable Brand/Line/Blend references, and vitola name, dimensions, and edition. Every level is nullable; structure holds known facts and never invents them. Shared across all users. |
| **Brand** | The marque a cigar is sold under (Drew Estate, Padrón, Hoyo de Monterrey; *marca* on the Cuban side). A reference entity with a canonical name, stable slug, and aliases (`Padrón`/`Padron`, `RYJ`). |
| **Line** | A named family of Blends within one Brand (Liga Privada, 1964 Anniversary Series, Acid). Optional — a Cigar whose line is unknown hangs directly off its Brand. |
| **Blend** | One recipe within a Line (No. 9, T52), sold across several sizes. Owns wrapper/binder/filler, strength, blend notes, and the marketing photo. Wrapper variants sold as distinct products (Natural vs Maduro) are distinct Blends, because that is how they are sold. |
| **Blender** | The person or team credited with a Blend — a master blender on the non-Cuban side. Many-to-many with Blends: collaborations exist and a blender's work spans brands. Null for Cuban blends, which are credited institutionally; blender-level views roll up NC-side only. |
| **Vitola** | The size and shape a Blend is rolled in (Toro, Robusto, Belicoso), with length and ring gauge. A label *within* a Blend, not an entity — it lives on the Cigar leaf, and there is no global vitola registry. |
| **Name Source** | How a Cigar's canonical name is maintained: `freeform` (the string is authoritative — today's rows) or `composed` (recomposed from Brand + Line + Blend + Vitola + edition, so renaming edits the parts). |
| **Verification** | Catalog lifecycle: `verified` (curated or crawl-confirmed) vs `unverified` (created mid-conversation from LLM-supplied attributes, pending curation). |
| **Smoke** | One User's experience smoking one physical cigar at a point in time. The central aggregate. A Smoke always references exactly one Cigar. |
| **Progression Entry** | A temporal slice of a Smoke: free-form stage label ("opening", "halfway"), optional approximate position (0–1), Descriptors, and verbatim observation text. Progression is optional — sparse Smokes carry only overall Descriptors. |
| **Descriptor** | A normalized kebab-case tasting tag (`baking-spice`, `tangerine`). Always stored alongside the user's original wording; the vocabulary grows organically, no ontology. |
| **Construction** | Physical performance of a Smoke: draw, burn, smoke output, touch-ups. |
| **Context** | Setting of a Smoke: location, pairing, occasion. All optional. |
| **Assessment** | The Smoke's summary judgment: strength, body, overall impression, optional `liked` boolean, optional 100-point Rating. |
| **Smoked-At Provenance** | How a Smoke's timestamp is known: `user` (stated), `system-finalized` (server stamped at save — an observation, not a hallucination), `legacy-document`, or `unknown`; with precision (minute/approximate/day). |
| **Rating** | 0–100, optional. Never fabricated; null when the user didn't state one. |
| **Journal Entry** | The narrative representation of a Smoke (title + prose). Not an aggregate — a component of Smoke. Preserves the user's own language. |
| **Smoke Photo** | A review-bound photo of one Smoke (ADR-007): owner-authored, 1→N per Smoke with a kind (`cigar`/`band`/`construction`/`burn`/`other`) and optional caption. Never promoted into the catalog's product photo. |
| **Photo Drop** | A User's link for the smoke in progress (ADR-014): opened before the Smoke exists, multi-use for 48 hours, holding **staged** photos until a `save_smoke` names it and claims them onto the new Smoke. One open Drop per User; reopening rotates its token. Nothing is claimed that a caller did not name. |
| **Provenance** | How a Smoke came to exist: `conversational` (via MCP), `manual` (web form), `imported` (legacy archive). Imported Smokes retain original markdown. |
| **Personal Profile** | Derived, per-User-per-Cigar view over that User's Smokes: count, recurring Descriptors, rating stats, typical strength. Computed on read, never stored. |
| **Purchase** | A User's acquisition record: Cigar, date, quantity, packaging, price/PPS, box date, humidor-entry date, Vendor. |
| **Vendor** | An admin-managed registry entry for a shop: crawl and price-display toggles, CC/NC focus. Cuban Vendors carry an approval status synced (with credit, via admin-reviewed diffs) from the r/cubancigars online-stores wiki; unapproved crawl sources are labeled. |
| **Offer** | A Vendor's listing of a Cigar observed by a crawl at a point in time: price, stock state, URL. Time-series. |
| **Listing Match** | Mapping from a Vendor's SKU/product page to a catalog Cigar: `auto`, `confirmed`, or `unmatched` (manual queue). |
| **Mutation Envelope** | The retry-safety wrapper on every MCP mutation: a Client Request Id plus an optional expected version. |
| **Client Request Id** | Idempotency key minted by a client once per intent (one smoke, one correction). Same key + same payload replays the original result; same key + different payload is a conflict. |
