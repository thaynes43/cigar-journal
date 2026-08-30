import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { citext } from "./_columns.js";
import { users } from "./users.js";

// An invite to create a local account (ADR-010, issue #46). The invite is bound
// to one email address and carries NO role — an invite has no role field to
// escalate, so redemption can only ever produce the users.role DEFAULT 'user'.
// Only the SHA-256 hash of the link token is stored, never the raw token (same
// at-rest discipline as photo_upload_tokens). Redemption is two-phase:
// `redeemedAt` is stamped by an atomic conditional UPDATE (the burn), `redeemedBy`
// only once sign-up succeeded — so a set `redeemedAt` with a null `redeemedBy`
// means in flight, and a crash there leaves the invite spent rather than reusable.
// The authoritative DDL (UNIQUE hash, the one-open-invite-per-email partial
// unique index) lives in migration 0022.
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  email: citext("email").notNull(),
  invitedBy: uuid("invited_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  redeemedBy: uuid("redeemed_by").references(() => users.id, { onDelete: "set null" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InviteRow = typeof invites.$inferSelect;
export type NewInviteRow = typeof invites.$inferInsert;
