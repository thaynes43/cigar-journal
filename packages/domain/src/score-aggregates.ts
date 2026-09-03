import { sql, type SQL } from "drizzle-orm";
import type { Queryer } from "./deps.js";
import { isUuid } from "./uuid.js";

// The two-population aggregates (ADR-013 §3) — the Rotten Tomatoes model over
// this catalogue. A CRITIC score over external `review_observations`, a JOURNAL
// score over users' smoke ratings, computed at the blend and rolled up
// line → brand → blender.
//
// THE ROLL-UP AGGREGATES THE UNDERLYING ROWS, NEVER THE AVERAGES BELOW.
// A brand's critic score is the mean of every observation under that brand, not
// the mean of its lines' means. The two differ whenever children are unevenly
// sampled, and the difference is not small: a line with one 96 and a line with
// forty scores averaging 84 give 90 by averaging averages and 84.3 by
// aggregating rows. The second is what the evidence says. No level here computes
// a mean from another LEVEL's mean — every one reads the same two scope views,
// changing only which column it groups on.
//
// THE TWO POPULATIONS COUNT DIFFERENT THINGS, BECAUSE THEIR ROWS MEAN DIFFERENT
// THINGS. A critic row is one reviewer's verdict, so observations are voices and
// the mean is over rows. A journal row is one smoke, and one person leaves many
// — so the journal population collapses each user's ratings to that user's mean
// first and aggregates the voices (ADR-013 §3 as amended 2026-08-31, owner
// ruling). Its sample count is JOURNALS. See `JournalAggregate` and
// `journalVoices` for why that is not the averages-of-averages the rule above
// forbids: a journal is a unit of the population, a line is not.
//
// EVERY NUMBER TRAVELS WITH ITS SAMPLE COUNT. `ScoreAggregate` has no
// constructor that yields a bare score, and there is no level below the leaf
// cigar, so one person's rating cannot be obtained from this module as anything
// but `{ score, count: 1 }` — one journal, saying so. That is the mechanical half
// of ADR-013 §1 — "no surface may present a single smoke's score as the score of
// a blend" — and score-aggregates.test.ts pins the behavioural half.

// The levels an aggregate is defined at. `cigar` is the leaf — one blend in one
// vitola — and it is here because ADR-013 §1 says per-cigar numbers are
// aggregates too: three smokes of one Toro is a sample of three, not a rating.
export type ScoreLevel = "cigar" | "blend" | "line" | "brand" | "blender";

export interface ScoreAggregate {
  // The mean on the 0-100 axis, rounded to the two decimals the observations
  // themselves carry. Rounded in SQL so the value is identical on every platform
  // and a hand-computed fixture can assert it exactly.
  score: number;
  // How many independent voices produced it. Never absent, never inferred. For
  // the critic population that is observations; for the journal population it is
  // JOURNALS, not ratings and not smokes — see `JournalAggregate`.
  count: number;
}

// ONE VOICE PER JOURNAL (ADR-013 §3 as amended 2026-08-31, owner ruling).
//
// The journal's rows are not independent the way a critic's are. Every external
// observation is a different reviewer, so averaging observations averages
// people. A user can smoke the same blend twenty times and rate every one — and
// a mean over those twenty rows is that one person's opinion twenty times over,
// printed beside a critic count of twenty as though twenty people had spoken.
// One prolific logger would then decide a blend's community score outright.
//
// So the journal aggregate averages TWICE, and the order matters: each user's
// ratings of the target collapse to that user's mean first, and those per-user
// means are what the level aggregates. `score` is the mean of the voices;
// `count` is how many voices there were.
export interface JournalAggregate extends ScoreAggregate {
  // Distinct journals behind the score — the SAME number as `count`, named
  // unambiguously for a caller holding the pair. `count` exists on both
  // populations because ADR-013 §1's guarantee is structural (no shape here
  // yields a score without one); `journalCount` says what this population's
  // count is counting.
  journalCount: number;
  // How many ratings those journals contributed. Diagnostic — the density
  // behind a voice, and what makes a one-journal score's basis inspectable. It
  // is NOT the sample count and no surface should render it as one: forty
  // ratings from one journal is one opinion, and the whole point of the ruling
  // is that it does not read as forty.
  ratingCount: number;
}

export interface ScorePair {
  // External reviewers. Null when nobody has reviewed anything at this level —
  // null, not zero: "no critic has scored this" and "critics scored it zero" are
  // different claims and must not share a representation.
  critic: ScoreAggregate | null;
  // The journal — smoke ratings from whichever population the caller asked for.
  journal: JournalAggregate | null;
}

/**
 * Which ratings the journal score is computed over.
 *
 * THIS HAS TO BE A CHOICE, because the Rotten Tomatoes analogy quietly breaks
 * here. An audience score is built from reviews people published on purpose; a
 * journal rating is a private note by default — `users.journal_visibility` is
 * `'private'` until its owner changes it. Averaging every rating into one
 * community number would publish exactly the entries their authors marked
 * private, and at a sample count of one that "aggregate" IS one person's private
 * rating, rendered on a catalogue page beside a critic score.
 *
 * `public` — ratings from journals their owners made public. The community
 * number, and the only one safe to render to anyone. It is the DEFAULT, so a
 * caller that forgets to think about this gets the non-disclosing population.
 *
 * `user` — one person's own ratings ("my score for this blend"). Private by
 * construction, and the caller is responsible for having authenticated that
 * userId; the visibility flag is deliberately ignored, since a private journal
 * is exactly what its owner is entitled to see aggregated.
 *
 * `viewer` — the population every RENDERED surface uses (DESIGN-006 rule 1):
 * public journals PLUS the viewer's own, whether or not theirs is public. It is
 * the union of the two above and not a third policy — a signed-in reader looking
 * at a blend they have rated should see their own rating counted, and hiding it
 * would make the number they are shown disagree with the entries on the same
 * page. It discloses nothing new: the only journal it adds to `public` is the
 * caller's own.
 */
export type JournalPopulation =
  | { kind: "public" }
  | { kind: "user"; userId: string }
  | { kind: "viewer"; userId: string };

const PUBLIC_JOURNAL: JournalPopulation = { kind: "public" };

const EMPTY: ScorePair = { critic: null, journal: null };

// The column each level groups on, in both scope views. `blender` is the odd one
// out: it is not a column on the leaf's ancestry but a many-to-many credit, so it
// arrives as a join instead — see `blenderJoin` below.
const LEVEL_COLUMN: Record<Exclude<ScoreLevel, "blender">, string> = {
  cigar: "cigar_id",
  blend: "blend_id",
  line: "line_id",
  brand: "brand_id",
};

// The blender roll-up's extra join, and its gate.
//
// NC TERRITORY ONLY (ADR-013): "Cuban blends credit no individual blender —
// blender views are NC-only". `blend_market_type` derives that per blend from its
// leaves' `cigars.type`, fail-closed: only a blend with a leaf known to be New
// World and no leaf contradicting it reads 'NC'. A Cuban blend and an
// entirely-untyped blend are both excluded, which is the same positive test the
// cigar detail page's blender row already applies at the leaf.
//
// A blend credited to two blenders contributes to both — a collaboration is part
// of each blender's body of work, and counting it once per credit is what makes
// "this blender's blends" mean the same thing here as everywhere else.
//
// The gate is an EXISTS correlated to `bb.blend_id` rather than a join against
// `blend_market_type`. The two columns hold the same value — `bb` is joined on
// it — but `bb` is the side already narrowed by the requested blenders, and a
// semi-join cannot fan a row out even if the view ever stopped being one row per
// blend.
//
// It is NOT what makes this level fast, and the honest record matters here
// because it was the first thing tried: correlating the gate changed the blender
// level by nothing at all (20.7ms before and after). The cost was in
// `review_observation_scope`, whose `blend_id` was a COALESCE the planner could
// not use as a join key — see migration 0028, which splits the view into its two
// real cases and takes this level to 3.9ms (5.4ms since the one-voice grouping,
// which costs about the same half-millisecond at every other level too).
const BLENDER_JOIN: SQL = sql`JOIN blend_blenders bb ON bb.blend_id = p.blend_id`;

const BLENDER_GATE: SQL = sql`
  AND EXISTS (
    SELECT 1 FROM blend_market_type bm WHERE bm.blend_id = bb.blend_id AND bm.type = 'NC'
  )
`;

// The requested ids as a uuid[], with every id bound as its own parameter.
//
// Written out rather than passing the JS array as one parameter, because Drizzle
// interpolates an array into the statement as a comma-separated parameter list
// rather than binding it as a Postgres array — `${ids}::uuid[]` compiles to
// `($1)::uuid[]` with the FIRST id as $1, which fails as a malformed array
// literal the moment it is asked for. `ARRAY[$1, $2, …]::uuid[]` is unambiguous
// and still fully parameterized.
function idArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

// How many decimals a read rounds its means to.
//
// TWO PRECISIONS, ONE ROUNDING. The analytical reads keep two decimals — the
// precision the observations themselves carry, and what a hand-computed fixture
// can assert exactly. The RENDERED surfaces (DESIGN-006 rule 1) want an integer
// on the 0-100 axis, and they get it by rounding the exact numeric mean ONCE,
// here, rather than by rounding a two-decimal value a second time in TypeScript:
// a true mean of 82.499 rounds to 82.50 and then to 83, which is not 82. Postgres
// rounds numeric half away from zero, so the value is identical on every platform.
type ScoreDigits = 0 | 2;

// One population's grouped aggregate over one scope view, restricted to the
// requested ids. `round(avg(...), n)` before the float8 cast, not after: rounding
// the exact numeric mean is deterministic, while rounding a float that has
// already lost precision is not.
function population(
  view: SQL,
  valueColumn: SQL,
  level: ScoreLevel,
  keys: SQL,
  digits: ScoreDigits,
): SQL {
  const blender = level === "blender";
  const key = blender ? sql`bb.blender_id` : sql.raw(`p.${LEVEL_COLUMN[level]}`);
  return sql`
    SELECT ${key} AS key,
           round(avg(${valueColumn}), ${sql.raw(String(digits))})::float8 AS score,
           count(*)::int AS n
    FROM ${view} p
    ${blender ? BLENDER_JOIN : sql``}
    WHERE ${key} = ANY (${keys})
    ${blender ? BLENDER_GATE : sql``}
    GROUP BY ${key}
  `;
}

// The journal population — ONE VOICE PER JOURNAL (ADR-013 §3 as amended
// 2026-08-31). Two aggregations, and the inner one is the ruling: a user's
// ratings of this target collapse to that user's mean before the level averages
// anything, so twenty ratings from one person weigh exactly as much as one
// rating from another.
//
// THIS IS NOT THE "AVERAGES OF AVERAGES" THE ROLL-UP RULE FORBIDS, and the
// difference is worth being precise about because the two look alike written
// down. That rule is about LEVELS: a brand's score may not be the mean of its
// lines' means, because the lines are unevenly sampled and the level below is
// not a unit of anything. A journal is a unit — it is the thing being counted,
// the way an observation is on the critic side. So the inner GROUP BY is what
// DEFINES the population's rows, and the outer one aggregates them exactly once.
//
// The roll-up rule still binds above that: a brand's journal score groups every
// rating a user left anywhere under that brand into ONE voice, rather than
// averaging that user's per-blend means. The inner grouping is on the requested
// level's key, so this happens by construction — there is no per-level mean for
// a higher level to re-average.
function journalVoices(
  level: ScoreLevel,
  keys: SQL,
  restrict: SQL,
  digits: ScoreDigits,
): SQL {
  const blender = level === "blender";
  const key = blender ? sql`bb.blender_id` : sql.raw(`p.${LEVEL_COLUMN[level]}`);
  return sql`
    SELECT key,
           round(avg(voice), ${sql.raw(String(digits))})::float8 AS score,
           count(*)::int AS n,
           sum(ratings)::int AS ratings
    FROM (
      SELECT ${key} AS key,
             p.user_id,
             avg(p.rating) AS voice,
             count(*)::int AS ratings
      FROM smoke_rating_scope p
      ${blender ? BLENDER_JOIN : sql``}
      WHERE ${key} = ANY (${keys})
      ${restrict}
      ${blender ? BLENDER_GATE : sql``}
      GROUP BY ${key}, p.user_id
    ) voices
    GROUP BY key
  `;
}

// The journal population as a WHERE fragment. Written as a total function over
// the union so a population added later cannot be silently forgotten here — the
// exhaustiveness is the point, since the failure mode of a missing branch is a
// private rating being published rather than an error anyone would see.
function journalRestriction(population: JournalPopulation): SQL {
  switch (population.kind) {
    case "public":
      return sql`AND p.visibility = 'public'`;
    case "user":
      return sql`AND p.user_id = ${population.userId}`;
    case "viewer":
      return sql`AND (p.visibility = 'public' OR p.user_id = ${population.userId})`;
  }
}

interface AggregateRow {
  key: string;
  critic_score: number | null;
  critic_n: number | null;
  journal_score: number | null;
  journal_n: number | null;
  journal_ratings: number | null;
}

function toAggregate(score: number | null, count: number | null): ScoreAggregate | null {
  // Null when the count is zero, which is also the unknown-id case: an id nobody
  // has reviewed and an id that does not exist are indistinguishable here, and
  // deliberately so — this module answers "what do the observations say", not
  // "does this entity exist".
  return score == null || count == null || count === 0 ? null : { score, count };
}

// `journals` is the sample count — the ruling's whole point — so it is what
// lands in `count`, and `journalCount` names it for a caller holding the pair.
// `ratings` is the density behind the voices and never the count.
function toJournalAggregate(
  score: number | null,
  journals: number | null,
  ratings: number | null,
): JournalAggregate | null {
  const base = toAggregate(score, journals);
  // A journal in the population contributed at least one rating, so the fallback
  // is unreachable rather than a default that could quietly under-report.
  return base == null
    ? null
    : { ...base, journalCount: base.count, ratingCount: ratings ?? base.count };
}

/**
 * Both populations for many entities at one level, in one round trip.
 *
 * Returns an entry for every id asked about, so a caller rendering a list never
 * has to distinguish "not in the map" from "no observations" — both are
 * `{ critic: null, journal: null }`.
 *
 * `journalPopulation` defaults to public journals only; see `JournalPopulation`
 * for why the safe population is the default rather than an opt-in.
 *
 * `ids` is bound one parameter per id, so this is a page-sized read — a few
 * hundred at most. It is not the shape to reach for to score the whole catalogue;
 * that is the materialization question migration 0028 leaves open for slice 2.
 */
export async function getScoreAggregates(
  db: Queryer,
  level: ScoreLevel,
  ids: string[],
  journalPopulation: JournalPopulation = PUBLIC_JOURNAL,
): Promise<Map<string, ScorePair>> {
  return fetchAggregates(db, level, ids, journalPopulation, 2);
}

// The batch read's body, with the rounding precision the caller needs. Two
// precisions, one query shape — see `ScoreDigits`.
async function fetchAggregates(
  db: Queryer,
  level: ScoreLevel,
  ids: string[],
  journalPopulation: JournalPopulation,
  digits: ScoreDigits,
): Promise<Map<string, ScorePair>> {
  const result = new Map<string, ScorePair>();

  // THE MAP IS KEYED BY THE CALLER'S STRINGS, NOT POSTGRES'S.
  //
  // `uuid::text` always comes back in the canonical lowercase form, whatever
  // case went in — Postgres parses `A1B2…` and `a1b2…` to the same uuid and
  // prints one of them. So a caller holding an upper- or mixed-case id (a value
  // from an external system, a hand-typed id, anything that has been through a
  // formatter) used to get its pre-seeded `EMPTY` entry left in place while the
  // real aggregate landed under a SECOND, lowercase key it never asked for.
  // `getScoreAggregate` then read back its own id and found the null pair. A
  // silently empty score — the failure mode this module is least able to reveal,
  // because "no observations" is a legitimate answer that looks identical.
  //
  // So ids are folded on the way in — which also collapses two spellings of one
  // id into one bound parameter — and every row is written back to every
  // original spelling that produced it. The map therefore has exactly one entry
  // per distinct string the caller passed, no more and no fewer.
  //
  // A malformed id is seeded like any other and then simply never asked about.
  // It keeps its EMPTY — indistinguishable from an id naming nothing, which is
  // this function's answer for an unknown id anyway — while staying out of the
  // bound array. That last part is the point: `ARRAY[…]::uuid[]` is cast as a
  // whole, so ONE unparseable element used to fail the entire batch, turning
  // every other id's perfectly good aggregate into a 500 (#206, ./uuid.ts).
  const originalsByCanonical = new Map<string, string[]>();
  for (const id of ids) {
    if (result.has(id)) continue;
    result.set(id, EMPTY);
    if (!isUuid(id)) continue;
    const canonical = id.toLowerCase();
    const originals = originalsByCanonical.get(canonical);
    if (originals) originals.push(id);
    else originalsByCanonical.set(canonical, [id]);
  }
  if (originalsByCanonical.size === 0) return result;

  // The two populations are computed independently and stitched by key, never
  // joined row-to-row: a blend with critic scores and no smokes must still return
  // its critic aggregate, and vice versa. `keys` on the outside is what makes both
  // LEFT JOINs safe.
  const keys = idArray([...originalsByCanonical.keys()]);
  const rows = await db.execute(sql`
    WITH keys AS (SELECT unnest(${keys}) AS key),
    critic AS (${population(sql`review_observation_scope`, sql`p.normalized_score`, level, keys, digits)}),
    journal AS (${journalVoices(level, keys, journalRestriction(journalPopulation), digits)})
    SELECT k.key::text AS key,
           c.score AS critic_score, c.n AS critic_n,
           j.score AS journal_score, j.n AS journal_n, j.ratings AS journal_ratings
    FROM keys k
    LEFT JOIN critic c ON c.key = k.key
    LEFT JOIN journal j ON j.key = k.key
  `);

  for (const row of rows.rows as unknown as AggregateRow[]) {
    const pair: ScorePair = {
      critic: toAggregate(row.critic_score, row.critic_n),
      journal: toJournalAggregate(row.journal_score, row.journal_n, row.journal_ratings),
    };
    for (const original of originalsByCanonical.get(row.key) ?? []) result.set(original, pair);
  }
  return result;
}

/**
 * Both populations for one entity at one level.
 *
 * `{ critic: null, journal: null }` when nothing has been observed — including
 * for an id that does not exist, and including a journal whose only ratings sit
 * in journals their owners keep private.
 */
export async function getScoreAggregate(
  db: Queryer,
  level: ScoreLevel,
  id: string,
  journalPopulation: JournalPopulation = PUBLIC_JOURNAL,
): Promise<ScorePair> {
  const all = await getScoreAggregates(db, level, [id], journalPopulation);
  return all.get(id) ?? EMPTY;
}

// ---------------------------------------------------------------------------
// THE RENDERED SURFACES (DESIGN-006)
//
// Everything above answers "what do the observations say" for a level, at the
// precision they carry. Everything below answers the narrower question every
// SURFACE asks — a leaf page, a drill header, a group card, `get_cigar` — and it
// is narrower in three ways, each of which is a rule rather than a formatting
// choice:
//
//   1. INTEGERS. Both aggregates round to a whole number on the 0-100 axis
//      (DESIGN-006 rule 1). Rounded once, from the exact numeric mean, in the
//      same statement that computes it — see `ScoreDigits`.
//   2. THE VIEWER'S POPULATION. The journal aggregate is public journals plus
//      the viewer's own (rule 1). An unauthenticated reader gets the public
//      population alone.
//   3. THE SCOPE TRAVELS WITH THE NUMBER. Rule 2 — "nothing is ever shown at a
//      level it was not computed for" — is enforceable only if a caller cannot
//      hold a score without holding the level it came from, so `SurfaceScore`
//      has no shape that omits it. The leaf page is the one surface that can
//      fall back to a wider level, and it is the reason this exists at all.
// ---------------------------------------------------------------------------

// The levels a surface renders at. `blender` is absent deliberately: DESIGN-006
// puts blender roll-ups out of scope until blender browsing exists, and a level
// with no surface has no business in a surface type.
export type SurfaceLevel = "cigar" | "blend" | "line" | "brand";

export interface SurfaceScore {
  // The mean on the 0-100 axis, a whole number (DESIGN-006 rule 1).
  score: number;
  // Observations for `critics`; JOURNALS for `journal`. Never absent — the
  // labelled count is half of what ADR-013 §1 requires every rendered number to
  // carry, and a shape that could omit it would let a surface print a bare score.
  count: number;
  // The level these numbers were actually computed at. Equal to the surface's own
  // level everywhere except a leaf page that fell back to its blend, which is the
  // case the caption `Across <blend name>` exists to state.
  scope: SurfaceLevel;
}

// The pair a surface renders. `critics` and `journal` are independent: either can
// be absent while the other is present, and an absent one renders NOTHING — not a
// zero, not a dash (DESIGN-006 rule 1, "each absent when its population is empty").
export interface SurfaceScores {
  critics: SurfaceScore | null;
  journal: SurfaceScore | null;
}

export const NO_SURFACE_SCORES: SurfaceScores = { critics: null, journal: null };

// Who is looking. `null` is an unauthenticated reader — the public population,
// which is what DESIGN-006 rule 1 degenerates to when there is no "own journal".
export type ScoreViewer = { userId: string } | null;

function viewerPopulation(viewer: ScoreViewer): JournalPopulation {
  return viewer == null ? PUBLIC_JOURNAL : { kind: "viewer", userId: viewer.userId };
}

function toSurfaceScore(
  aggregate: ScoreAggregate | null,
  scope: SurfaceLevel,
): SurfaceScore | null {
  return aggregate == null ? null : { score: aggregate.score, count: aggregate.count, scope };
}

/**
 * Both populations for many entities at ONE level, as the surfaces render them
 * (DESIGN-006): whole numbers, the viewer's journal population, and every score
 * carrying the level it was computed at.
 *
 * One round trip. There is no fallback here — a blend, line or brand surface IS
 * its scope (rule 2), so the only level any of these numbers can carry is the one
 * that was asked for. The leaf's own-else-blend resolution lives in
 * `getLeafSurfaceScores`, which is a different question and a different query.
 *
 * Returns an entry for every id asked about, so a list render never distinguishes
 * "not in the map" from "nothing observed".
 */
export async function getSurfaceScores(
  db: Queryer,
  level: SurfaceLevel,
  ids: string[],
  viewer: ScoreViewer,
): Promise<Map<string, SurfaceScores>> {
  const pairs = await fetchAggregates(db, level, ids, viewerPopulation(viewer), 0);
  const result = new Map<string, SurfaceScores>();
  for (const [id, pair] of pairs) {
    result.set(id, {
      critics: toSurfaceScore(pair.critic, level),
      journal: toSurfaceScore(pair.journal, level),
    });
  }
  return result;
}

/** One entity at one level, surface-shaped. */
export async function getSurfaceScore(
  db: Queryer,
  level: SurfaceLevel,
  id: string,
  viewer: ScoreViewer,
): Promise<SurfaceScores> {
  const all = await getSurfaceScores(db, level, [id], viewer);
  return all.get(id) ?? NO_SURFACE_SCORES;
}

interface LeafScoreRow {
  critic_cigar_score: number | null;
  critic_cigar_n: number | null;
  critic_blend_score: number | null;
  critic_blend_n: number | null;
  journal_cigar_score: number | null;
  journal_cigar_n: number | null;
  journal_blend_score: number | null;
  journal_blend_n: number | null;
}

// One arm of the leaf read: a whole-number mean and a count over one scope view,
// with no GROUP BY. An ungrouped aggregate always returns exactly one row, so an
// arm that matches nothing yields `{ score: null, n: 0 }` rather than no row at
// all — which is what lets the four arms be cross-joined into a single row below
// without any of them being able to erase the others.
function leafCritics(on: SQL): SQL {
  return sql`
    SELECT round(avg(p.normalized_score), 0)::float8 AS score, count(*)::int AS n
    FROM leaf JOIN review_observation_scope p ON ${on}
  `;
}

// The journal arm, one voice per journal (ADR-013 §3 as amended): the inner
// GROUP BY collapses each author to their own mean before the outer one averages
// the voices, exactly as `journalVoices` does for the analytical read.
function leafJournal(on: SQL, restrict: SQL): SQL {
  return sql`
    SELECT round(avg(v.voice), 0)::float8 AS score, count(*)::int AS n
    FROM (
      SELECT p.user_id, avg(p.rating) AS voice
      FROM leaf JOIN smoke_rating_scope p ON ${on}
      WHERE true ${restrict}
      GROUP BY p.user_id
    ) v
  `;
}

function pickLeaf(
  own: { score: number | null; n: number | null },
  blend: { score: number | null; n: number | null },
): SurfaceScore | null {
  // MOST SPECIFIC LEVEL WITH DATA (DESIGN-006 rule 2), resolved per population
  // rather than once for the pair. A leaf that has been smoked but never reviewed
  // must still show what critics said about its blend; resolving both populations
  // together would suppress that, because the leaf "has data" for the other one.
  // The consequence is that the two can legitimately land at different scopes,
  // which is exactly why `scope` rides on each score rather than on the pair.
  if (own.score != null && own.n != null && own.n > 0) {
    return { score: own.score, count: own.n, scope: "cigar" };
  }
  if (blend.score != null && blend.n != null && blend.n > 0) {
    return { score: blend.score, count: blend.n, scope: "blend" };
  }
  return null;
}

/**
 * The leaf detail page's pair (DESIGN-006 rule 2): **the leaf's own observations
 * if any, else its blend's**, per population, in ONE query.
 *
 * This resolution lives here rather than at the call site on purpose. It is the
 * only place in the app where a number rendered on one entity's page was computed
 * over a wider set, so it is the only place that can get ADR-013 §1 wrong by
 * accident — and it can only be got right if the answer carries its scope. A
 * caller cannot render one of these without being handed the level it belongs to.
 *
 * A blend-scoped critic score deliberately includes the leaf's OWN observations
 * as well: the fallback widens the population to the whole blend, it does not
 * substitute a disjoint one. (It fires only when the leaf's own count is zero, so
 * the two never disagree about the same rows.)
 *
 * An unknown, excluded or merged cigar answers `{ critics: null, journal: null }`
 * — `cigar_ancestry` carries the `catalog_status = 'active'` gate, so a tombstone
 * resolves to no leaf and therefore to no blend either.
 */
export async function getLeafSurfaceScores(
  db: Queryer,
  cigarId: string,
  viewer: ScoreViewer,
): Promise<SurfaceScores> {
  // A malformed id is not-found, not a 500 (#206, ./uuid.ts) — the uuid cast
  // would otherwise fail the whole statement.
  if (!isUuid(cigarId)) return NO_SURFACE_SCORES;
  const restrict = journalRestriction(viewerPopulation(viewer));

  const rows = await db.execute(sql`
    WITH leaf AS (
      SELECT ca.cigar_id, ca.blend_id FROM cigar_ancestry ca WHERE ca.cigar_id = ${cigarId}::uuid
    ),
    cc AS (${leafCritics(sql`p.cigar_id = leaf.cigar_id`)}),
    cb AS (${leafCritics(sql`p.blend_id = leaf.blend_id`)}),
    jc AS (${leafJournal(sql`p.cigar_id = leaf.cigar_id`, restrict)}),
    jb AS (${leafJournal(sql`p.blend_id = leaf.blend_id`, restrict)})
    SELECT cc.score AS critic_cigar_score, cc.n AS critic_cigar_n,
           cb.score AS critic_blend_score, cb.n AS critic_blend_n,
           jc.score AS journal_cigar_score, jc.n AS journal_cigar_n,
           jb.score AS journal_blend_score, jb.n AS journal_blend_n
    FROM cc, cb, jc, jb
  `);

  const row = (rows.rows as unknown as LeafScoreRow[])[0];
  if (row == null) return NO_SURFACE_SCORES;
  return {
    critics: pickLeaf(
      { score: row.critic_cigar_score, n: row.critic_cigar_n },
      { score: row.critic_blend_score, n: row.critic_blend_n },
    ),
    journal: pickLeaf(
      { score: row.journal_cigar_score, n: row.journal_cigar_n },
      { score: row.journal_blend_score, n: row.journal_blend_n },
    ),
  };
}
