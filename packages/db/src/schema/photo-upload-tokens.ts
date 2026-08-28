import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { smokes } from "./smokes.js";
import { users } from "./users.js";
import type { SmokePhotoKind } from "./smoke-photos.js";

// A short-lived, single-use upload link bound to (user, smoke, kind?, caption?)
// (ADR-007, issue #44 part 2). Minted by the MCP add_smoke_photo tool when no
// image was attached to the tool call — the fallback that works from a phone
// where in-chat photo attachment is unreliable. Only the SHA-256 hash of the URL
// token is stored, so a database read never yields a usable link (same at-rest
// discipline as the OAuth tokens). Single use is enforced by a conditional UPDATE
// stamping `used_at`; the authoritative DDL (kind CHECK, UNIQUE hash) lives in
// migration 0007.
export const photoUploadTokens = pgTable("photo_upload_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  smokeId: uuid("smoke_id")
    .notNull()
    .references(() => smokes.id, { onDelete: "cascade" }),
  kind: text("kind").$type<SmokePhotoKind>().notNull().default("other"),
  caption: text("caption"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PhotoUploadTokenRow = typeof photoUploadTokens.$inferSelect;
export type NewPhotoUploadTokenRow = typeof photoUploadTokens.$inferInsert;
