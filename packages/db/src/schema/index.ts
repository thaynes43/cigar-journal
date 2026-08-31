// Drizzle table schemas, one file per table (ADR-003), re-exported from here.
// The authoritative DDL — extensions, generated columns, GIN/trigram indexes,
// CHECK constraints — lives in the numbered SQL migrations; these definitions
// carry the query-time types. drizzle-kit is generation/inspection only.
export * from "./_columns.js";
export * from "./users.js";
export * from "./session.js";
export * from "./account.js";
export * from "./verification.js";
export * from "./rate-limit.js";
// The catalog taxonomy above the leaf (ADR-012): brands → lines → blends, plus
// blenders and the credit join. Exported before ./cigars.js, which points at them.
export * from "./brands.js";
export * from "./lines.js";
export * from "./blends.js";
export * from "./blenders.js";
export * from "./blend-blenders.js";
export * from "./cigars.js";
export * from "./duplicate-dismissals.js";
export * from "./smokes.js";
export * from "./smoke-progression.js";
export * from "./smoke-photos.js";
export * from "./smoke-consumptions.js";
export * from "./photo-upload-tokens.js";
export * from "./invites.js";
export * from "./vendors.js";
export * from "./listing-matches.js";
export * from "./offers.js";
export * from "./purchases.js";
export * from "./wants.js";
export * from "./favorites.js";
export * from "./idempotency-keys.js";
export * from "./audit-log.js";
export * from "./cigar-merges.js";
export * from "./product-photos.js";
export * from "./brand-images.js";
export * from "./crawl-runs.js";
// External review scores (ADR-013, migration 0028). After ./cigars.js, ./blends.js
// and ./vendors.js, which it points at.
export * from "./review-observations.js";
export * from "./enrichment-requests.js";
export * from "./enrichment-attempts.js";
export * from "./oauth-client.js";
export * from "./oauth-authorization.js";
export * from "./oauth-authorization-code.js";
export * from "./oauth-refresh-token.js";
export * from "./oauth-access-token.js";
