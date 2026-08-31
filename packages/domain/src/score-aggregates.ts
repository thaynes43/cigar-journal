import { sql, type SQL } from "drizzle-orm";
import type { Queryer } from "./deps.js";

// The two-population aggregates (ADR-013 §3) — the Rotten Tomatoes model over
// this catalogue. A CRITIC score over external `review_observations`, a JOURNAL
// score over users' smoke ratings, computed at the blend and rolled up
// line → brand → blender.
//
// THE ROLL-UP AGGREGATES THE UNDERLYING OBSERVATIONS, NEVER THE AVERAGES BELOW.
// A brand's critic score is the mean of every observation under that brand, not
// the mean of its lines' means. The two differ whenever children are unevenly
// sampled, and the difference is not small: a line with one 96 and a line with
// forty scores averaging 84 give 90 by averaging averages and 84.3 by
// aggregating rows. The second is what the evidence says. There is no code path
// here that computes a mean from a mean — every level reads the same two scope
// views, changing only which column it groups on.
//
// EVERY NUMBER TRAVELS WITH ITS SAMPLE COUNT. `ScoreAggregate` has no
// constructor that yields a bare score, and there is no level below the leaf
// cigar, so a single smoke's rating cannot be obtained from this module as
// anything but `{ score, count: 1 }`. That is the mechanical half of ADR-013 §1
// — "no surface may present a single smoke's score as the score of a blend" — and
// score-aggregates.test.ts pins the behavioural half.

// The levels an aggregate is defined at. `cigar` is the leaf — one blend in one
// vitola — and it is here because ADR-013 §1 says per-cigar numbers are
// aggregates too: three smokes of one Toro is a sample of three, not a rating.
export type ScoreLevel = "cigar" | "blend" | "line" | "brand" | "blender";

export interface ScoreAggregate {
  // The mean on the 0-100 axis, rounded to the two decimals the observations
  // themselves carry. Rounded in SQL so the value is identical on every platform
  // and a hand-computed fixture can assert it exactly.
  score: number;
  // How many observations produced it. Never absent, never inferred.
  count: number;
}

export interface ScorePair {
  // External reviewers. Null when nobody has reviewed anything at this level —
  // null, not zero: "no critic has scored this" and "critics scored it zero" are
  // different claims and must not share a representation.
  critic: ScoreAggregate | null;
  // The journal — smoke ratings from whichever population the caller asked for.
  journal: ScoreAggregate | null;
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
 */
export type JournalPopulation = { kind: "public" } | { kind: "user"; userId: string };

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
// real cases and takes this level to 3.9ms.
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

// One population's grouped aggregate over one scope view, restricted to the
// requested ids. `round(avg(...), 2)` before the float8 cast, not after: rounding
// the exact numeric mean is deterministic, while rounding a float that has
// already lost precision is not.
function population(
  view: SQL,
  valueColumn: SQL,
  level: ScoreLevel,
  keys: SQL,
  restrict: SQL = sql``,
): SQL {
  const blender = level === "blender";
  const key = blender ? sql`bb.blender_id` : sql.raw(`p.${LEVEL_COLUMN[level]}`);
  return sql`
    SELECT ${key} AS key,
           round(avg(${valueColumn}), 2)::float8 AS score,
           count(*)::int AS n
    FROM ${view} p
    ${blender ? BLENDER_JOIN : sql``}
    WHERE ${key} = ANY (${keys})
    ${restrict}
    ${blender ? BLENDER_GATE : sql``}
    GROUP BY ${key}
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
  }
}

interface AggregateRow {
  key: string;
  critic_score: number | null;
  critic_n: number | null;
  journal_score: number | null;
  journal_n: number | null;
}

function toAggregate(score: number | null, count: number | null): ScoreAggregate | null {
  // Null when the count is zero, which is also the unknown-id case: an id nobody
  // has reviewed and an id that does not exist are indistinguishable here, and
  // deliberately so — this module answers "what do the observations say", not
  // "does this entity exist".
  return score == null || count == null || count === 0 ? null : { score, count };
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
  const result = new Map<string, ScorePair>();
  for (const id of ids) result.set(id, EMPTY);
  if (ids.length === 0) return result;

  // The two populations are computed independently and stitched by key, never
  // joined row-to-row: a blend with critic scores and no smokes must still return
  // its critic aggregate, and vice versa. `keys` on the outside is what makes both
  // LEFT JOINs safe.
  const keys = idArray(ids);
  const rows = await db.execute(sql`
    WITH keys AS (SELECT unnest(${keys}) AS key),
    critic AS (${population(sql`review_observation_scope`, sql`p.normalized_score`, level, keys)}),
    journal AS (${population(
      sql`smoke_rating_scope`,
      sql`p.rating`,
      level,
      keys,
      journalRestriction(journalPopulation),
    )})
    SELECT k.key::text AS key,
           c.score AS critic_score, c.n AS critic_n,
           j.score AS journal_score, j.n AS journal_n
    FROM keys k
    LEFT JOIN critic c ON c.key = k.key
    LEFT JOIN journal j ON j.key = k.key
  `);

  for (const row of rows.rows as unknown as AggregateRow[]) {
    result.set(row.key, {
      critic: toAggregate(row.critic_score, row.critic_n),
      journal: toAggregate(row.journal_score, row.journal_n),
    });
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
