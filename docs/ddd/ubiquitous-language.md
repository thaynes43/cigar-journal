# Ubiquitous Language

Terms used in code, docs, and conversation. Singular, capitalized when used as
a domain term.

| Term | Meaning |
|---|---|
| **User** | An account holder. Owns Smokes and Purchases; has a journal visibility setting (`private`/`public`). |
| **Identity** | One way a User authenticates: local credentials or a linked OIDC account (Authentik). Many Identities → one User. |
| **Cigar** | A catalog product that can be smoked repeatedly. Identity is the required **canonical name** ("Atabey Divinos"); brand, line, edition, vitola, dimensions, and blend metadata (manufacturer, wrapper/binder/filler origins) are optional facts, never invented to satisfy taxonomy. Shared across all users. |
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
| **Provenance** | How a Smoke came to exist: `conversational` (via MCP), `manual` (web form), `imported` (legacy archive). Imported Smokes retain original markdown. |
| **Personal Profile** | Derived, per-User-per-Cigar view over that User's Smokes: count, recurring Descriptors, rating stats, typical strength. Computed on read, never stored. |
| **Purchase** | A User's acquisition record: Cigar, date, quantity, packaging, price/PPS, box date, humidor-entry date, Vendor. |
| **Vendor** | An admin-managed registry entry for a shop: crawl and price-display toggles, CC/NC focus. Cuban Vendors carry an approval status synced (with credit, via admin-reviewed diffs) from the r/cubancigars online-stores wiki; unapproved crawl sources are labeled. |
| **Offer** | A Vendor's listing of a Cigar observed by a crawl at a point in time: price, stock state, URL. Time-series. |
| **Listing Match** | Mapping from a Vendor's SKU/product page to a catalog Cigar: `auto`, `confirmed`, or `unmatched` (manual queue). |
| **Mutation Envelope** | The retry-safety wrapper on every MCP mutation: a Client Request Id plus an optional expected version. |
| **Client Request Id** | Idempotency key minted by a client once per intent (one smoke, one correction). Same key + same payload replays the original result; same key + different payload is a conflict. |
