import { eq, sql } from "drizzle-orm";
import { auditLog, blends, cigars, type NewAuditLogRow } from "@cj/db";
import type { Principal, Queryer } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import { ValidationError, type FieldError } from "./errors.js";
import { normalizeReviewScore, nativeScoreText } from "./review-scores.js";
import { isUuid } from "./uuid.js";

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

// `source` and `url` are bounded in BYTES, not characters, because their bound
// exists to keep an oversized value from failing on the btree behind
// `review_observations_source_url_key` — and a btree entry's ~2704-byte ceiling
// is counted in bytes. A 2000-character URL of percent-decoded CJK is 6000 bytes
// and would pass a `length` check on its way to an opaque index error. Measured
// with `Buffer.byteLength` here and `octet_length` in the CHECK, so the two
// agree on what they are counting.
const SOURCE_MAX_BYTES = 100;
const URL_MAX_BYTES = 2000;
const REVIEWER_MAX = 200;

// Publication date, day precision, in exactly the form the column stores.
// See `validate` for why nothing else is accepted.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The shape AND the calendar. `Date.parse` is not a calendar check: `2026-02-31`
// is a conforming date-time string, so the spec's MakeDay rolls it forward and
// it parses cleanly as March 3rd. Postgres would then reject the same value at
// the column, turning an extractor bug into a storage-layer error instead of a
// field error the caller can act on. Round-tripping the parsed instant back to
// its digits is what makes the check total.
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface ReviewObservationInput {
  // The stable ingestion key — the crawler's adapter slug ("halfwheel"). Folded
  // to lowercase here, because it is half of the idempotency key and a source
  // that re-ingested everything over a capitalization change would not be one.
  source: string;
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
  } else if (Buffer.byteLength(source, "utf8") > SOURCE_MAX_BYTES) {
    errors.push({ path: "source", message: `Must be at most ${SOURCE_MAX_BYTES} bytes.` });
  }

  const url = trimmed(input.url);
  if (url == null) {
    errors.push({ path: "url", message: "Required." });
  } else if (Buffer.byteLength(url, "utf8") > URL_MAX_BYTES) {
    errors.push({ path: "url", message: `Must be at most ${URL_MAX_BYTES} bytes.` });
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

  // ONE CANONICAL FORM, REFUSED OTHERWISE — the same refuse-don't-guess posture
  // the excerpt bound and the scale table take, and for a sharper reason than
  // tidiness. `reviewed_at` is `date`, so anything wider is silently narrowed by
  // the `::date` cast on the way in: a full timestamp is accepted, stored as its
  // day, and then compared on the NEXT crawl against the day Postgres handed
  // back — which never equals what the adapter sent. The row is "amended" every
  // night thereafter, writing an audit row each time and making `updated_at`
  // useless as the answer to "when did this score last move". A locale form
  // (`03/14/2026`) is worse: `Date.parse` accepts it under a timezone nobody
  // stated, so the stored day can be the day before the one printed on the page.
  //
  // `isCalendarDate` fixes the shape and the calendar together, so the value
  // that reaches the column is always the value that comes back out of it.
  const reviewedAt = trimmed(input.reviewedAt);
  if (reviewedAt != null && !isCalendarDate(reviewedAt)) {
    errors.push({
      path: "reviewedAt",
      message: "Must be a calendar date in YYYY-MM-DD form.",
    });
  }
}

// THE TARGET IS AN FK AND NOTHING RESOLVED IT (#230). `cigar_id` and `blend_id`
// are extractor-supplied and went straight into the INSERT, so an id naming no
// row raised 23503 and a malformed one 22P02. Both are untyped, so both escape
// this writer's documented ValidationError contract as an opaque failure — and
// the 22P02 is worse than a failed statement here, because this runs on the
// CALLER'S transaction by design (a crawl ingesting a page's whole batch), which
// it would poison. A misread id is a statement that the extractor read the wrong
// thing, which is exactly what the other field errors here report.
//
// Malformed skips the query and takes the miss's refusal, so the two are
// indistinguishable to the caller — the same contract every other id-taking
// entry point in this domain keeps (./uuid.ts) — and the wording is the registry
// writes' own, so one condition reads one way across the surface.
//
// `validate` has already established that exactly one of the two is set, so at
// most one lookup runs.
async function assertObservationTarget(
  db: Queryer,
  cigarId: string | null,
  blendId: string | null,
): Promise<void> {
  if (cigarId != null) {
    const rows = isUuid(cigarId)
      ? await db.select({ id: cigars.id }).from(cigars).where(eq(cigars.id, cigarId)).limit(1)
      : [];
    if (!rows[0]) throw new ValidationError([{ path: "cigarId", message: "No such cigar." }]);
  }
  if (blendId != null) {
    const rows = isUuid(blendId)
      ? await db.select({ id: blends.id }).from(blends).where(eq(blends.id, blendId)).limit(1)
      : [];
    if (!rows[0]) throw new ValidationError([{ path: "blendId", message: "No such blend." }]);
  }
}

// The stored row's content, as the comparison that decides whether anything
// moved. Deliberately excludes `last_seen_at` (that is liveness, which moves
// every crawl) and `raw` (the extractor's payload can churn on an irrelevant
// page detail, and a changed payload behind an unchanged score is not news).
interface PriorRow {
  id: string;
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
 * Refuses (ValidationError) an unknown scale, an unmappable score, a missing,
 * doubled or unresolvable target, and an over-long excerpt. Every one of those
 * is a statement that the extractor misread the page, and a misread score is
 * worse than a missing one: once averaged it is indistinguishable from a real
 * one.
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
  const raw = input.raw == null ? null : JSON.stringify(input.raw);

  // Before the dedupe read, so the refusal costs one indexed lookup instead of
  // riding all the way to the INSERT's foreign key.
  await assertObservationTarget(db, cigarId, blendId);

  const prior = await db.execute(sql`
    SELECT id, reviewer, native_scale, native_score, normalized_score,
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
      (source, url, reviewer, native_scale, native_score, normalized_score,
       reviewed_at, excerpt, cigar_id, blend_id, raw, last_seen_at, created_at, updated_at)
    VALUES
      (${source}, ${url}, ${reviewer}, ${nativeScale}, ${nativeScore},
       ${normalizedScore}, ${reviewedAt}::date, ${excerpt}, ${cigarId}, ${blendId},
       ${raw}::jsonb, ${input.seenAt}, ${input.seenAt}, ${input.seenAt})
    ON CONFLICT (source, url) DO UPDATE SET
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

  // AN AMENDMENT IS A ROW WE CAN DESCRIBE THE BEFORE OF. `row.inserted` and
  // `existing` normally agree; they come apart in exactly one case, and it is
  // the case that decides what the audit claims happened. Under a concurrent
  // first ingest of the same URL, the SELECT above sees nothing and the INSERT
  // then loses the ON CONFLICT race, so `inserted` is false while `existing` is
  // null. Trusting `inserted` alone writes `review.amend` with `before: null` —
  // an amendment to nothing, in the one surface an operator reads to find out
  // what a source changed. Postgres cannot hand back the row the other
  // transaction wrote (RETURNING sees the post-update row, and the pre-read is
  // on this transaction's snapshot), so the honest record is the weaker claim:
  // this ingest recorded a score, and the writer that raced us recorded its own.
  const amended = !row.inserted && existing != null;

  // Audited HERE, not in a caller, and that is a deliberate departure from
  // `recordPriceObservation` — which writes no audit row because both of its
  // callers already write their own, differently. This writer has no such
  // caller: slice 1 ships no reviewer adapter and no MCP tool, and an audit that
  // lives in a caller which does not exist is not an audit. Only a real write is
  // recorded, matching the price path's rule that a deduped no-op writes nothing.
  await db.insert(auditLog).values({
    userId: attribution.principal?.userId ?? null,
    ...auditActor(attribution.principal, attribution.actor),
    action: amended ? "review.amend" : "review.record",
    smokeId: null,
    before: existing ? priorSnapshot(existing) : null,
    // The SAME field set as `priorSnapshot`, so an amendment's two halves can be
    // diffed key by key. They were asymmetric until the excerpt and the date were
    // added here: `before` carried both, `after` carried neither, so the console
    // could show that a pull quote or a publication date had changed but never to
    // what — which is most of the reason to record an amendment at all.
    after: {
      observationId: row.id,
      source,
      url,
      reviewer,
      nativeScale,
      nativeScore,
      normalizedScore,
      reviewedAt,
      excerpt,
      cigarId,
      blendId,
    },
    runId: attribution.runId ?? null,
    correlationId: attribution.correlationId ?? null,
  });

  return { observationId: row.id, inserted: row.inserted, changed: true, normalizedScore };
}

interface ObservationContent {
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
