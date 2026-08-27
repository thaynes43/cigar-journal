import { customType } from "drizzle-orm/pg-core";

// Shared column types not built into Drizzle. The authoritative DDL for these
// (extension requirement, generation expression) lives in the numbered SQL
// migrations; here they only carry the correct TS type for queries (ADR-003).

// Case-insensitive text — requires the `citext` extension.
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

// Full-text search vector; generated in SQL, never written by the application.
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
