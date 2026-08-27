// Drizzle table schemas, one file per table (ADR-003), re-exported from here.
// The authoritative DDL — extensions, generated columns, GIN/trigram indexes,
// CHECK constraints — lives in the numbered SQL migrations; these definitions
// carry the query-time types. drizzle-kit is generation/inspection only.
export * from "./_columns.js";
export * from "./users.js";
export * from "./cigars.js";
export * from "./smokes.js";
export * from "./smoke-progression.js";
export * from "./vendors.js";
export * from "./listing-matches.js";
export * from "./offers.js";
export * from "./purchases.js";
export * from "./idempotency-keys.js";
export * from "./audit-log.js";
