import { and, desc, eq, sql } from "drizzle-orm";
import {
  cigars,
  smokes,
  smokeProgression,
  smokePhotos,
  users,
  type CigarRow,
  type SmokeRow,
  type SmokeProgressionRow,
  type SmokePhotoRow,
} from "@cj/db";
import type { Deps } from "./deps.js";
import type {
  PublicSmokeView,
  PublicSmokeSummary,
  QueryPublicSmokesFilters,
  QueryPublicSmokesResult,
} from "./types.js";
import { SmokeNotFoundError } from "./errors.js";
import { toSmokePhotoView } from "./mapping.js";
import { decodeSmokeCursor, encodeSmokeCursor, afterSmokeCursor } from "./smoke-cursor.js";

// Anonymous reads for public journals (PRD-001 R7, ADR-004; issue #96). A journal
// is public when its owner's `journal_visibility = 'public'`. These reads take no
// Principal: the visibility filter IS the authorization, applied in SQL, so a
// private or nonexistent smoke are indistinguishable — both raise
// SmokeNotFoundError, which the adapters render as one 404 (no existence leak).
//
// LAUNCH CONSTRAINT: the index lists ALL public journals' smokes together, which
// at launch means the single public journal (the owner's). The multi-user /
// per-handle URL question stays on issue #46 — do not infer a handle scheme here.

const DEFAULT_SMOKE_LIMIT = 10;
const MAX_SMOKE_LIMIT = 25;

function clampLimit(value: number | undefined): number {
  const n = value ?? DEFAULT_SMOKE_LIMIT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SMOKE_LIMIT;
  return Math.min(Math.floor(n), MAX_SMOKE_LIMIT);
}

// Public summary text is narrative-only. The private deriveSummary prefers the
// impression, but the impression is a private assessment field withheld from the
// public surface, so it must not seed a public summary either.
function deriveNarrativeSummary(narrative: string | null): string | null {
  if (narrative && narrative.trim().length > 0) {
    const text = narrative.trim();
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  }
  return null;
}

function toPublicSmokeView(
  smoke: SmokeRow,
  cigar: Pick<CigarRow, "canonicalName">,
  progression: SmokeProgressionRow[],
  photos: SmokePhotoRow[],
): PublicSmokeView {
  return {
    smokeId: smoke.id,
    cigar: { canonicalName: cigar.canonicalName },
    smokedAt: {
      value: smoke.smokedAt ? smoke.smokedAt.toISOString() : null,
      source: smoke.smokedAtSource,
      precision: smoke.smokedAtPrecision,
    },
    journal: { title: smoke.journalTitle, narrative: smoke.journalNarrative },
    overallDescriptors: smoke.overallDescriptors,
    progression: progression.map((p) => ({
      stage: p.stage,
      approximatePosition: p.approximatePosition != null ? Number(p.approximatePosition) : null,
      descriptors: p.descriptors,
      specificDescriptors: p.specificDescriptors,
      verbatim: p.verbatim,
    })),
    construction: {
      draw: smoke.draw,
      burn: smoke.burn,
      smokeOutput: smoke.smokeOutput,
      notes: smoke.constructionNotes,
    },
    assessment: {
      strength: smoke.strength,
      body: smoke.body,
      liked: smoke.liked,
      rating: smoke.rating,
      impression: smoke.impression,
    },
    pairing: smoke.context?.pairing ?? [],
    originalMarkdown: smoke.originalMarkdown,
    photos: photos.map(toSmokePhotoView),
  };
}

// One smoke from a public journal, stripped to journal content. A smoke that does
// not exist and a smoke whose journal is private both raise SmokeNotFoundError —
// the join requires `journal_visibility = 'public'`, so the two cases are one row
// count of zero and cannot be told apart.
export async function getPublicSmoke(
  deps: Deps,
  args: { smokeId: string },
): Promise<PublicSmokeView> {
  const rows = await deps.db
    .select({ smoke: smokes, cigar: { canonicalName: cigars.canonicalName } })
    .from(smokes)
    .innerJoin(cigars, eq(smokes.cigarId, cigars.id))
    .innerJoin(users, eq(smokes.userId, users.id))
    .where(and(eq(smokes.id, args.smokeId), eq(users.journalVisibility, "public")))
    .limit(1);
  const row = rows[0];
  if (!row) throw new SmokeNotFoundError();

  const progression = await deps.db
    .select()
    .from(smokeProgression)
    .where(eq(smokeProgression.smokeId, args.smokeId))
    .orderBy(smokeProgression.ordinal);

  const photos = await deps.db
    .select()
    .from(smokePhotos)
    .where(eq(smokePhotos.smokeId, args.smokeId))
    .orderBy(smokePhotos.createdAt);

  return toPublicSmokeView(row.smoke, row.cigar, progression, photos);
}

// The public journal index: public journals' smokes, newest first, keyset-
// paginated with the shared cursor idiom. A compact summary per card (the full
// assessment lives on the detail view); consumption/holding data and the private
// context (location/occasion) never reach it.
export async function queryPublicSmokes(
  deps: Deps,
  filters: QueryPublicSmokesFilters = {},
): Promise<QueryPublicSmokesResult> {
  const limit = clampLimit(filters.limit);
  const cursor = decodeSmokeCursor(filters.cursor);
  const conditions = [eq(users.journalVisibility, "public")];
  if (cursor) conditions.push(afterSmokeCursor(cursor));

  // Fetch one extra row to decide whether a next cursor exists, then trim it off.
  const fetched = await deps.db
    .select({ smoke: smokes, canonicalName: cigars.canonicalName })
    .from(smokes)
    .innerJoin(cigars, eq(smokes.cigarId, cigars.id))
    .innerJoin(users, eq(smokes.userId, users.id))
    .where(and(...conditions))
    .orderBy(sql`${smokes.smokedAt} DESC NULLS LAST`, desc(smokes.createdAt), desc(smokes.id))
    .limit(limit + 1);

  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;

  const summaries: PublicSmokeSummary[] = rows.map((row) => ({
    smokeId: row.smoke.id,
    cigar: { canonicalName: row.canonicalName },
    smokedAt: {
      value: row.smoke.smokedAt ? row.smoke.smokedAt.toISOString() : null,
      source: row.smoke.smokedAtSource,
      precision: row.smoke.smokedAtPrecision,
    },
    rating: row.smoke.rating,
    liked: row.smoke.liked,
    descriptors: row.smoke.overallDescriptors,
    summary: deriveNarrativeSummary(row.smoke.journalNarrative),
  }));

  const last = rows[rows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeSmokeCursor({
          smokedAt: last.smoke.smokedAt ? last.smoke.smokedAt.toISOString() : null,
          createdAt: last.smoke.createdAt.toISOString(),
          id: last.smoke.id,
        })
      : null;

  return { smokes: summaries, nextCursor };
}

// Whether any public journal exists at all — the existence gate for the public
// index. When false the index 404s exactly as a nonexistent smoke does, so the
// absence of a public journal is not distinguishable from a bad URL.
export async function publicJournalExists(deps: Deps): Promise<boolean> {
  const rows = await deps.db
    .select({ one: sql`1` })
    .from(users)
    .where(eq(users.journalVisibility, "public"))
    .limit(1);
  return rows.length > 0;
}
