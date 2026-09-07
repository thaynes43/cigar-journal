import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { photoDrops } from "./photo-drops.js";

// The links one photo drop has handed out (ADR-014 as amended 2026-09-07, issue
// #316). A drop holds a bounded SET of valid token hashes, not one: every open of
// a live drop mints another link for the caller and leaves every earlier link
// working, because the page the user still has open is holding one of them.
//
// Only the SHA-256 of the URL token is stored, never the raw token (the at-rest
// discipline of photo_upload_tokens and invites) — which is why a continue MINTS
// rather than re-issuing: the earlier raw token is not re-derivable. Rows cascade
// with the drop, so expiry, deletion and the retention sweep take every one of a
// drop's links with it. The bound is `PHOTO_DROP_TOKENS_MAX` in @cj/domain, which
// prunes the oldest in the same transaction as the mint; the authoritative DDL
// (UNIQUE hash, the per-drop index) lives in migration 0040.
export const photoDropTokens = pgTable("photo_drop_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  photoDropId: uuid("photo_drop_id")
    .notNull()
    .references(() => photoDrops.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PhotoDropTokenRow = typeof photoDropTokens.$inferSelect;
export type NewPhotoDropTokenRow = typeof photoDropTokens.$inferInsert;
