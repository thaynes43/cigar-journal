import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { smokes } from "./smokes.js";
import { users } from "./users.js";

// One row per review-bound SmokePhoto (ADR-007). 1→N per smoke, owned by the
// smoke's user; `kind` classifies the shot. `object_key`/`thumb_key` are the
// unguessable, unique keys into the private `photos` bucket — only pipeline
// output (normalized JPEG, EXIF stripped) is ever stored. Cascades with the
// smoke; the storage objects are cleaned up by @cj/domain, not the DB. The
// authoritative DDL (kind CHECK, UNIQUE keys) lives in migration 0005; the
// `cigar` default is migration 0036 (#287) — the common photo is the stick
// itself, and `other` is the fallback.
export type SmokePhotoKind = "cigar" | "band" | "construction" | "burn" | "other";

export const smokePhotos = pgTable(
  "smoke_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    smokeId: uuid("smoke_id")
      .notNull()
      .references(() => smokes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").$type<SmokePhotoKind>().notNull().default("cigar"),
    caption: text("caption"),
    objectKey: text("object_key").notNull().unique(),
    thumbKey: text("thumb_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("smoke_photos_smoke_idx").on(table.smokeId, table.createdAt)],
);

export type SmokePhotoRow = typeof smokePhotos.$inferSelect;
export type NewSmokePhotoRow = typeof smokePhotos.$inferInsert;
