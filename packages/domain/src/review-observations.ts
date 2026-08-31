import { sql } from "drizzle-orm";
import { auditLog, type NewAuditLogRow } from "@cj/db";
import type { Principal, Queryer } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import { ValidationError, type FieldError } from "./errors.js";
import { normalizeReviewScore, nativeScoreText } from "./review-scores.js";

// The single review-observation writer (ADR-013 §2) — the ADR-009
// price-observation pattern applied to reviews, and the only path that writes
// `review_observations`. The reviewer crawlers (slice 2) and any enrichment agent
// that finds a score go through here, so the two can never disagree about what
// counts as the same review.
//
// IT FETCHES NOTHING. Ingestion takes already-extracted facts: whoever read the
// page decides what the score was and which cigar it was about. That boundary is
// what lets this be tested against hand-written facts and lets an adapter be
// tested against fixtures, with neither needing the other.
//
// THE IDEMPOTENCY RULE DIFFERS FROM THE PRICE PATH, DELIBERATELY. `offers` is an
// append-only series with a 24h identical-observation window, because the same
// vendor pricing the same cigar next week is a NEW fact. A review is not a
// series: one reviewer publishes one verdict at one URL, and a re-crawl of that
// URL finds the same review. If the score there has moved, the reviewer
// corrected themselves — an amendment to one observation, not a second one. So
// the key is a real UNIQUE (source, url) and re-ingestion updates in place. Both
// rules exist so a re-crawl creates zero duplicates; they differ because the
// facts differ.

// The excerpt's hard bound, in characters — the same number as the CHECK on
// `review_observations.excerpt` in migration 0028, pinned to it by the tests.
//
// ADR-013 permits "scores, links, and short excerpts only — never full review
// text". 400 characters is one or two sentences: enough to show what the score
// meant, nowhere near enough to substitute for reading the review.
export const REVIEW_EXCERPT_MAX = 400;

const SOURCE_MAX = 100;
const URL_MAX = 2000;
const REVIEWER_MAX = 200;

export interface ReviewObservationInput {
  // The stable ingestion key — the crawler's adapter slug ("halfwheel"). Folded
  // to lowercase here, because it is half of the idempotency key and a source
  // that re-ingested everything over a capitalization change would not be one.
  source: string;
  // The registry link, when the source is registered. Null for a score an agent
  // brought from a site the crawl registry does not carry — the same allowance
  // ADR-009 makes for named ad-hoc price sources.
  sourceId?: string | null;
  // The review's canonical URL. NORMALIZING IT IS THE ADAPTER'S JOB: only the
  // adapter knows whether a query string on that site is a tracking parameter or
  // part of the address, and guessing here would either merge two reviews or
  // split one. This trims and nothing else.
  url: string;
  reviewer?: string | null;
  // The scale the source scores on, and the score exactly as it wrote it. Both
  // are stored; see review-scores.ts for why the normalization is reversible.
  nativeScale: string;
  nativeScore: number | string;
  // Publication date, day precision (YYYY-MM-DD).
  reviewedAt?: string | null;
  excerpt?: string | null;
  // The most specific level the SOURCE stated — exactly one (ADR-013 §2). The
  // leaf cigar when the reviewer named a vitola, the blend when they reviewed the
  // blend at large. A cigar-linked observation's blend is derived downstream
  // through `cigars.blend_id`; do not pass both hoping to help.
  cigarId?: string | null;
  blendId?: string | null;
  // The extractor's payload — evidence about how the row was derived. NOT a
  // place to park the review body; the excerpt bound is not avoidable by writing
  // prose in here.
  raw?: unknown;
  // When this ingest saw the review. Drives `last_seen_at` always, and
  // `updated_at` only when something actually changed.
  seenAt: Date;
}

// Who drove this ingest. `system` is a crawl lane, `agent` an enrichment agent
// bringing a score it found, `mcp` a future conversational tool. `principal` is
// present only where a credential authenticated the call — the crawler has none,
// and `auditActor` records the explicit null for it (#183).
export interface ReviewIngestAttribution {
  actor: NonNullable<NewAuditLogRow["actor"]>;
  principal?: Principal;
  runId?: string | null;
  correlationId?: string | null;
}

export interface RecordReviewObservationResult {
  observationId: string;
  // A row that did not exist before.
  inserted: boolean;
  // Whether anything the source claims actually moved. False on the ordinary
  // re-crawl — the review is still there, saying what it said — which is the
  // signal the caller uses to skip an audit row for a night of no news.
  changed: boolean;
  // The 0-100 value the aggregates average.
  normalizedScore: number;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text != null && text.length > 0 ? text : null;
}

// Shape and licence checks, accumulated so a caller learns everything wrong with
// an observation at once rather than one field per round trip.
//
// THE EXCERPT BOUND REFUSES, IT DOES NOT TRUNCATE, and that is the one choice
// here worth arguing. Every other bounded free-text field in this domain
// (`normalizeNote` on wants and favorites, `normalizeDisplayName`) silently
// slices at its cap, because those caps are formatting. This one is a copyright
// rule. A truncating writer would accept a full review body forever and quietly
// store its first 400 characters, so the adapter that meant to send a pull quote
// and sent a page would never find out. A refusal costs the caller one field and
// makes the mistake visible at the moment it is made.
function validate(input: ReviewObservationInput, errors: FieldError[]): void {
  const source = trimmed(input.source);
  if (source == null) {
    errors.push({ path: "source", message: "Required." });
  } else if (source.length > SOURCE_MAX) {
    errors.push({ path: "source", message: `Must be at most ${SOURCE_MAX} characters.` });
  }

  const url = trimmed(input.url);
  if (url == null) {
    errors.push({ path: "url", message: "Required." });
  } else if (url.length > URL_MAX) {
    errors.push({ path: "url", message: `Must be at most ${URL_MAX} characters.` });
  }

  const reviewer = trimmed(input.reviewer);
  if (reviewer != null && reviewer.length > REVIEWER_MAX) {
    errors.push({ path: "reviewer", message: `Must be at most ${REVIEWER_MAX} characters.` });
  }

  const excerpt = trimmed(input.excerpt);
  if (excerpt != null && excerpt.length > REVIEW_EXCERPT_MAX) {
    errors.push({
      path: "excerpt",
      message: `Must be at most ${REVIEW_EXCERPT_MAX} characters — scores, links and short excerpts only, never full review text.`,
    });
  }

  // Exactly one target, matching the CHECK in migration 0028. Reported as a
  // field error rather than left to the database so the caller gets a
  // fix_and_retry it can act on instead of an opaque `unavailable`.
  const targets = [input.cigarId, input.blendId].filter((id) => trimmed(id) != null).length;
  if (targets !== 1) {
    errors.push({
      path: "target",
      message:
        "Exactly one of cigarId or blendId is required — the most specific level the source states.",
    });
  }

  if (input.reviewedAt != null && Number.isNaN(Date.parse(input.reviewedAt))) {
    errors.push({ path: "reviewedAt", message: "Must be an ISO-8601 date (YYYY-MM-DD)." });
  }
}

// The stored row's content, as the comparison that decides whether anything
// moved. Deliberately excludes `last_seen_at` (that is liveness, which moves
// every crawl) and `raw` (the extractor's payload can churn on an irrelevant
// page detail, and a changed payload behind an unchanged score is not news).
interface PriorRow {
  id: string;
  source_id: string | null;
  reviewer: string | null;
  native_scale: string;
  native_score: string;
  normalized_score: string;
  reviewed_at: string | null;
  excerpt: string | null;
  cigar_id: string | null;
  blend_id: string | null;
}

/**
 * Ingest one already-extracted review score, idempotently on (source, url).
 *
 * Runs inside the caller's transaction when given one, so the read that decides
 * "has anything changed" and the write that acts on it are one atomic step —
 * the same reason `recordPriceObservation` takes a `Queryer`.
 *
 * Refuses (ValidationError) an unknown scale, an unmappable score, a missing or
 * doubled target, and an over-long excerpt. Every one of those is a statement
 * that the extractor misread the page, and a misread score is worse than a
 * missing one: once averaged it is indistinguishable from a real one.
 */
export async function recordReviewObservation(
  db: Queryer,
  input: ReviewObservationInput,
  attribution: ReviewIngestAttribution = { actor: "system" },
): Promise<RecordReviewObservationResult> {
  const errors: FieldError[] = [];
  validate(input, errors);

  // Normalization can raise on its own (unknown scale, unknown grade, a value
  // outside the scale). Collect it into the same report rather than throwing
  // past the field errors already found, so one call surfaces one complete list.
  let normalizedScore = 0;
  try {
    normalizedScore = normalizeReviewScore(input.nativeScale, input.nativeScore);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    errors.push(...error.fields);
  }
  if (errors.length > 0) throw new ValidationError(errors);

  const source = input.source.trim().toLowerCase();
  const url = input.url.trim();
  const reviewer = trimmed(input.reviewer);
  const excerpt = trimmed(input.excerpt);
  const nativeScale = input.nativeScale;
  const nativeScore = nativeScoreText(input.nativeScore);
  const reviewedAt = trimmed(input.reviewedAt);
  const cigarId = trimmed(input.cigarId);
  const blendId = trimmed(input.blendId);
  const sourceId = trimmed(input.sourceId);
  const raw = input.raw == null ? null : JSON.stringify(input.raw);

  const prior = await db.execute(sql`
    SELECT id, source_id, reviewer, native_scale, native_score, normalized_score,
           reviewed_at::text AS reviewed_at, excerpt, cigar_id, blend_id
    FROM review_observations
    WHERE source = ${source} AND url = ${url}
    LIMIT 1
  `);
  const existing = (prior.rows as unknown as PriorRow[])[0];

  // Nothing the source claims has moved: the review is still up, saying what it
  // said. Record the sighting and leave `updated_at` alone, so "last confirmed"
  // and "last edited" stay separate questions and a nightly re-crawl does not
  // make every row look freshly amended.
  if (
    existing &&
    !contentDiffers(existing, {
      sourceId,
      reviewer,
      nativeScale,
      nativeScore,
      normalizedScore,
      reviewedAt,
      excerpt,
      cigarId,
      blendId,
    })
  ) {
    await db.execute(sql`
      UPDATE review_observations SET last_seen_at = ${input.seenAt} WHERE id = ${existing.id}
    `);
    return { observationId: existing.id, inserted: false, changed: false, normalizedScore };
  }

  // `xmax = 0` distinguishes the INSERT path from the DO UPDATE path on the row
  // Postgres actually wrote, rather than trusting the SELECT above. The two can
  // disagree under a concurrent ingest of the same URL, and this is the half
  // that is authoritative — which matters because it decides what the audit row
  // claims happened.
  const written = await db.execute(sql`
    INSERT INTO review_observations
      (source, source_id, url, reviewer, native_scale, native_score, normalized_score,
       reviewed_at, excerpt, cigar_id, blend_id, raw, last_seen_at, created_at, updated_at)
    VALUES
      (${source}, ${sourceId}, ${url}, ${reviewer}, ${nativeScale}, ${nativeScore},
       ${normalizedScore}, ${reviewedAt}::date, ${excerpt}, ${cigarId}, ${blendId},
       ${raw}::jsonb, ${input.seenAt}, ${input.seenAt}, ${input.seenAt})
    ON CONFLICT (source, url) DO UPDATE SET
      source_id        = EXCLUDED.source_id,
      reviewer         = EXCLUDED.reviewer,
      native_scale     = EXCLUDED.native_scale,
      native_score     = EXCLUDED.native_score,
      normalized_score = EXCLUDED.normalized_score,
      reviewed_at      = EXCLUDED.reviewed_at,
      excerpt          = EXCLUDED.excerpt,
      cigar_id         = EXCLUDED.cigar_id,
      blend_id         = EXCLUDED.blend_id,
      raw              = EXCLUDED.raw,
      last_seen_at     = EXCLUDED.last_seen_at,
      updated_at       = EXCLUDED.updated_at
    RETURNING id, (xmax = 0) AS inserted
  `);
  const row = (written.rows as unknown as { id: string; inserted: boolean }[])[0]!;

  // Audited HERE, not in a caller, and that is a deliberate departure from
  // `recordPriceObservation` — which writes no audit row because both of its
  // callers already write their own, differently. This writer has no such
  // caller: slice 1 ships no reviewer adapter and no MCP tool, and an audit that
  // lives in a caller which does not exist is not an audit. Only a real write is
  // recorded, matching the price path's rule that a deduped no-op writes nothing.
  await db.insert(auditLog).values({
    userId: attribution.principal?.userId ?? null,
    ...auditActor(attribution.principal, attribution.actor),
    action: row.inserted ? "review.record" : "review.amend",
    smokeId: null,
    before: existing ? priorSnapshot(existing) : null,
    after: {
      observationId: row.id,
      source,
      url,
      reviewer,
      nativeScale,
      nativeScore,
      normalizedScore,
      cigarId,
      blendId,
    },
    runId: attribution.runId ?? null,
    correlationId: attribution.correlationId ?? null,
  });

  return { observationId: row.id, inserted: row.inserted, changed: true, normalizedScore };
}

interface ObservationContent {
  sourceId: string | null;
  reviewer: string | null;
  nativeScale: string;
  nativeScore: string;
  normalizedScore: number;
  reviewedAt: string | null;
  excerpt: string | null;
  cigarId: string | null;
  blendId: string | null;
}

// `normalized_score` comes back from a numeric column as a string, so it is
// compared as a number — the same reason `price-observations.ts` carries
// `sameNumber`. Everything else is text and compares directly.
function contentDiffers(prior: PriorRow, next: ObservationContent): boolean {
  return (
    prior.source_id !== next.sourceId ||
    prior.reviewer !== next.reviewer ||
    prior.native_scale !== next.nativeScale ||
    prior.native_score !== next.nativeScore ||
    Number(prior.normalized_score) !== next.normalizedScore ||
    prior.reviewed_at !== next.reviewedAt ||
    prior.excerpt !== next.excerpt ||
    prior.cigar_id !== next.cigarId ||
    prior.blend_id !== next.blendId
  );
}

// The `before` snapshot for an amendment. The score and its target are what an
// operator asking "what did this source change?" needs; the excerpt and byline
// ride along because a reviewer swapping the pull quote under an unchanged score
// is exactly the kind of edit worth being able to see.
function priorSnapshot(prior: PriorRow): Record<string, unknown> {
  return {
    observationId: prior.id,
    reviewer: prior.reviewer,
    nativeScale: prior.native_scale,
    nativeScore: prior.native_score,
    normalizedScore: Number(prior.normalized_score),
    reviewedAt: prior.reviewed_at,
    excerpt: prior.excerpt,
    cigarId: prior.cigar_id,
    blendId: prior.blend_id,
  };
}
