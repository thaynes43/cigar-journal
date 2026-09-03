import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { smokes } from "./smokes.js";
import { users } from "./users.js";

// A photo drop (ADR-014): the link that collects a smoke's photos BEFORE the
// smoke exists. Multi-use for its 48 hours — a live smoke produces several
// photos over hours and each is a first-class event — and bounded the way a
// smoke is: at most MAX_PHOTOS_PER_SMOKE staged photos and a page that shows
// only this drop's own. Only the SHA-256 hash of the URL token is stored, never
// the raw token (the at-rest discipline of photo_upload_tokens and invites), so
// re-opening a drop must MINT a new token and the earlier link dies with it.
//
// `smokeId` + `claimedAt` are set by the save that claims the drop. `smokeId` is
// ON DELETE SET NULL, which is how deleting a smoke CLOSES its drop rather than
// erasing the claim — claimed with no smoke reads `closed`, so uploads stop and
// the remainder is swept. The authoritative DDL (UNIQUE hash, the partial
// open-drop and smoke indexes) lives in migration 0033.
export const photoDrops = pgTable("photo_drops", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  smokeId: uuid("smoke_id").references(() => smokes.id, { onDelete: "set null" }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // The drop's SESSION window (ADR-016). One open drop per user means a drop is
  // routinely re-used across evenings, so `created_at` is not when this smoke
  // began: `sessionStartedAt` is the start of the current run of opens, reset
  // whenever an open lands more than DROP_SESSION_GAP_HOURS after the last one,
  // and `lastOpenedAt` is what that gap is measured from. Maintained only by
  // `openPhotoDrop`; the save and the claim read `sessionStartedAt` as the
  // earliest observation of when the smoke was lit.
  sessionStartedAt: timestamp("session_started_at", { withTimezone: true }).notNull().defaultNow(),
  lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PhotoDropRow = typeof photoDrops.$inferSelect;
export type NewPhotoDropRow = typeof photoDrops.$inferInsert;
