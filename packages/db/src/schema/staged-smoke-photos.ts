import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { photoDrops } from "./photo-drops.js";
import { users } from "./users.js";
import type { SmokePhotoKind } from "./smoke-photos.js";

// A photo dropped before its smoke existed (ADR-014). Shaped EXACTLY like
// smoke_photos — same kind, caption, keys, dimensions and bytes — but bound to a
// drop instead of a smoke, because the claim moves the row across keeping its id
// and its object keys: nothing is copied in the bucket, so a claimed photo's
// object_key simply keeps its `drop/` prefix (ADR-007 — keys are unguessable, not
// authorization). Cascades with the drop; the storage objects are cleaned up by
// @cj/domain's sweep, not the DB. The authoritative DDL (kind CHECK, UNIQUE keys)
// lives in migration 0033.
export const stagedSmokePhotos = pgTable(
  "staged_smoke_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dropId: uuid("drop_id")
      .notNull()
      .references(() => photoDrops.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").$type<SmokePhotoKind>().notNull().default("other"),
    caption: text("caption"),
    objectKey: text("object_key").notNull().unique(),
    thumbKey: text("thumb_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("staged_smoke_photos_drop_idx").on(table.dropId, table.createdAt)],
);

export type StagedSmokePhotoRow = typeof stagedSmokePhotos.$inferSelect;
export type NewStagedSmokePhotoRow = typeof stagedSmokePhotos.$inferInsert;
