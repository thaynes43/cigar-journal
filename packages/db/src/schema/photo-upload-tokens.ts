import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { smokes } from "./smokes.js";
import { users } from "./users.js";
import { cigars } from "./cigars.js";
import type { SmokePhotoKind } from "./smoke-photos.js";

// A single-use, time-boxed upload link (ADR-007, issue #44 part 2; extended for
// product photos in DESIGN-003 §Images, issue #127). Two kinds share the table:
// a `smoke` link binds (user, smoke, kind?, caption?) — minted by the MCP
// add_smoke_photo tool for a phone upload; a `product` link binds (user, cigar) —
// minted by an admin to attach a catalog cigar's product photo. Only the SHA-256
// hash of the URL token is stored, never the raw token (same at-rest discipline
// as OAuth tokens in 0003). Single use is enforced by a conditional UPDATE
// stamping `used_at`; the authoritative DDL (target CHECK, UNIQUE hash) lives in
// migrations 0007 (smoke) and 0015 (product target + nullable smoke_id).
export type UploadTokenTargetKind = "smoke" | "product";

export const photoUploadTokens = pgTable("photo_upload_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Nullable since 0015: set on a `smoke` token, null on a `product` token. The
  // migration's CHECK keeps exactly one of smoke_id/cigar_id set per target_kind.
  smokeId: uuid("smoke_id").references(() => smokes.id, { onDelete: "cascade" }),
  // Set on a `product` token (the catalog cigar the upload photographs), null on
  // a `smoke` token. Cascades with the cigar.
  cigarId: uuid("cigar_id").references(() => cigars.id, { onDelete: "cascade" }),
  targetKind: text("target_kind").$type<UploadTokenTargetKind>().notNull().default("smoke"),
  kind: text("kind").$type<SmokePhotoKind>().notNull().default("other"),
  caption: text("caption"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PhotoUploadTokenRow = typeof photoUploadTokens.$inferSelect;
export type NewPhotoUploadTokenRow = typeof photoUploadTokens.$inferInsert;
