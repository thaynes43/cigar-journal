import { and, eq, gte, lte, ilike, sql, desc, count, inArray, isNotNull, asc, type SQL } from "drizzle-orm";
import {
  cigars,
  smokes,
  smokeProgression,
  type CigarRow,
  type SmokeRow,
  type SmokeProgressionRow,
} from "@cj/db";
import type { Deps, Principal } from "./deps.js";
import type {
  SmokeView,
  QueryMySmokesFilters,
  QueryMySmokesResult,
  SmokeSummary,
  MatchField,
  SearchCigarsArgs,
  SearchCigarsResult,
  CigarMatch,
  GetCigarResult,
  CigarView,
  PersonalProfile,
  BrowseCigarsResult,
  CatalogCigar,
} from "./types.js";
import { SmokeNotFoundError, CigarNotFoundError } from "./errors.js";
import { normalizeDescriptor } from "./descriptors.js";
import { validateQueryFilters } from "./validation.js";

const DEFAULT_SMOKE_LIMIT = 10;
const MAX_SMOKE_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const BROWSE_CIGARS_LIMIT = 100;

// Match-provenance snippet rendering. We use ts_headline per prose field (not
// over the combined weighted `search` vector — ts_headline can't attribute a
// fragment back to one weighted source, so a per-field call is the pragmatic
// choice) and wrap each hit in sentinel delimiters we strip in JS, yielding a
// PLAIN-TEXT excerpt (the snippet is provenance, not display markup). The
// sentinels are code points that never occur in cigar prose; stripping them is
// a no-op on the rare chance they do.
const HL_START = "⟪"; // ⟪
const HL_STOP = "⟫"; // ⟫
const HEADLINE_OPTS = `StartSel=${HL_START},StopSel=${HL_STOP},MaxWords=24,MinWords=10,MaxFragments=1`;
const MATCH_SNIPPET_MAX = 160;

function clamp(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function toSmokeView(
  smoke: SmokeRow,
  cigar: { id: string; canonicalName: string; verification: CigarRow["verification"] },
  progression: SmokeProgressionRow[],
): SmokeView {
  return {
    smokeId: smoke.id,
    version: smoke.version,
    cigar: {
      cigarId: cigar.id,
      canonicalName: cigar.canonicalName,
      verification: cigar.verification,
    },
    smokedAt: {
      value: smoke.smokedAt ? smoke.smokedAt.toISOString() : null,
      source: smoke.smokedAtSource,
      precision: smoke.smokedAtPrecision,
    },
    context: smoke.context ?? null,
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
    journal: { title: smoke.journalTitle, narrative: smoke.journalNarrative },
    provenance: { source: smoke.provenanceSource, client: smoke.provenanceClient },
    originalMarkdown: smoke.originalMarkdown,
  };
}

// The canonical, complete representation of one Smoke — owner-only.
export async function getSmoke(
  deps: Deps,
  principal: Principal,
  args: { smokeId: string },
): Promise<SmokeView> {
  const rows = await deps.db
    .select({
      smoke: smokes,
      cigar: {
        id: cigars.id,
        canonicalName: cigars.canonicalName,
        verification: cigars.verification,
      },
    })
    .from(smokes)
    .innerJoin(cigars, eq(smokes.cigarId, cigars.id))
    .where(eq(smokes.id, args.smokeId))
    .limit(1);
  const row = rows[0];
  if (!row || row.smoke.userId !== principal.userId) throw new SmokeNotFoundError();

  const progression = await deps.db
    .select()
    .from(smokeProgression)
    .where(eq(smokeProgression.smokeId, args.smokeId))
    .orderBy(smokeProgression.ordinal);

  return toSmokeView(row.smoke, row.cigar, progression);
}

function smokeConditions(principal: Principal, filters: QueryMySmokesFilters): SQL[] {
  const conditions: SQL[] = [eq(smokes.userId, principal.userId)];
  if (filters.cigarId) conditions.push(eq(smokes.cigarId, filters.cigarId));
  if (filters.brand) conditions.push(ilike(cigars.brand, filters.brand));

  if (filters.descriptor) {
    const descriptor = normalizeDescriptor(filters.descriptor);
    if (descriptor) {
      conditions.push(
        sql`(${smokes.overallDescriptors} @> ARRAY[${descriptor}]::text[] OR EXISTS (
          SELECT 1 FROM smoke_progression p WHERE p.smoke_id = ${smokes.id} AND p.descriptors @> ARRAY[${descriptor}]::text[]))`,
      );
    }
  }

  if (filters.text) {
    // Generated tsvector covers all journal prose — title, narrative, impression,
    // construction notes, imported original markdown (migration 0004); the EXISTS
    // clause extends FTS to progression verbatim per the tool contract.
    conditions.push(
      sql`(${smokes.search} @@ websearch_to_tsquery('english', ${filters.text}) OR EXISTS (
        SELECT 1 FROM smoke_progression p WHERE p.smoke_id = ${smokes.id}
        AND to_tsvector('english', coalesce(p.verbatim, '')) @@ websearch_to_tsquery('english', ${filters.text})))`,
    );
  }

  if (filters.smokedAfter) conditions.push(gte(smokes.smokedAt, new Date(filters.smokedAfter)));
  if (filters.smokedBefore) conditions.push(lte(smokes.smokedAt, new Date(filters.smokedBefore)));
  if (filters.minRating != null) conditions.push(gte(smokes.rating, filters.minRating));
  return conditions;
}

function deriveSummary(smoke: SmokeRow): string | null {
  if (smoke.impression && smoke.impression.trim().length > 0) return smoke.impression;
  if (smoke.journalNarrative && smoke.journalNarrative.trim().length > 0) {
    const text = smoke.journalNarrative.trim();
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  }
  return null;
}

// Strip the ts_headline sentinels, collapse whitespace, and cap at ~160 chars —
// the excerpt is provenance for the model, not rendered markup.
function cleanSnippet(raw: string | null): string | null {
  if (raw == null) return null;
  const stripped = raw
    .replace(/[⟪⟫]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length === 0) return null;
  if (stripped.length <= MATCH_SNIPPET_MAX) return stripped;
  return `${stripped.slice(0, MATCH_SNIPPET_MAX - 1).trimEnd()}…`;
}

interface MatchProvenanceRow {
  id: string;
  m_title: boolean;
  m_narrative: boolean;
  m_impression: boolean;
  m_construction: boolean;
  m_markdown: boolean;
  m_progression: boolean;
  snippet: string | null;
}

interface MatchProvenance {
  matchedIn: MatchField[];
  matchSnippet: string | null;
}

// For a page of already-matched smokes, attribute the text hit to its prose
// field(s) and produce one excerpt. One extra indexed-PK round trip, run only
// when `text` was used and only over the ≤limit returned ids. Per-field matches
// are consistent with the combined `search` vector: setweight changes weights,
// not which lexemes are present, so `search @@ q` is true iff some field here is
// (progression is the EXISTS clause, mirroring queryMySmokes).
async function matchProvenance(
  deps: Deps,
  ids: string[],
  text: string,
): Promise<Map<string, MatchProvenance>> {
  const map = new Map<string, MatchProvenance>();
  if (ids.length === 0) return map;

  const q = sql`websearch_to_tsquery('english', ${text})`;
  const opts = HEADLINE_OPTS;
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

  const result = await deps.db.execute(sql`
    SELECT s.id AS id,
      to_tsvector('english', coalesce(s.journal_title, '')) @@ ${q} AS m_title,
      to_tsvector('english', coalesce(s.journal_narrative, '')) @@ ${q} AS m_narrative,
      to_tsvector('english', coalesce(s.impression, '')) @@ ${q} AS m_impression,
      to_tsvector('english', coalesce(s.construction_notes, '')) @@ ${q} AS m_construction,
      to_tsvector('english', coalesce(s.original_markdown, '')) @@ ${q} AS m_markdown,
      EXISTS (
        SELECT 1 FROM smoke_progression p
        WHERE p.smoke_id = s.id
          AND to_tsvector('english', coalesce(p.verbatim, '')) @@ ${q}
      ) AS m_progression,
      CASE
        WHEN to_tsvector('english', coalesce(s.journal_title, '')) @@ ${q}
          THEN ts_headline('english', s.journal_title, ${q}, ${opts})
        WHEN to_tsvector('english', coalesce(s.journal_narrative, '')) @@ ${q}
          THEN ts_headline('english', s.journal_narrative, ${q}, ${opts})
        WHEN to_tsvector('english', coalesce(s.impression, '')) @@ ${q}
          THEN ts_headline('english', s.impression, ${q}, ${opts})
        WHEN to_tsvector('english', coalesce(s.construction_notes, '')) @@ ${q}
          THEN ts_headline('english', s.construction_notes, ${q}, ${opts})
        WHEN to_tsvector('english', coalesce(s.original_markdown, '')) @@ ${q}
          THEN ts_headline('english', s.original_markdown, ${q}, ${opts})
        ELSE (
          SELECT ts_headline('english', p.verbatim, ${q}, ${opts})
          FROM smoke_progression p
          WHERE p.smoke_id = s.id
            AND to_tsvector('english', coalesce(p.verbatim, '')) @@ ${q}
          ORDER BY p.ordinal
          LIMIT 1
        )
      END AS snippet
    FROM smokes s
    WHERE s.id IN (${idList})
  `);

  for (const row of result.rows as unknown as MatchProvenanceRow[]) {
    const matchedIn: MatchField[] = [];
    if (row.m_title) matchedIn.push("title");
    if (row.m_narrative) matchedIn.push("narrative");
    if (row.m_impression) matchedIn.push("impression");
    if (row.m_construction) matchedIn.push("constructionNotes");
    if (row.m_markdown) matchedIn.push("originalMarkdown");
    if (row.m_progression) matchedIn.push("progression");
    map.set(row.id, { matchedIn, matchSnippet: cleanSnippet(row.snippet) });
  }
  return map;
}

// Per-smoke progression positions for a page of smokes — the approximate_position
// values, nulls filtered, ordered by ordinal. One batched round trip over the
// ≤limit returned ids; feeds the journal-card burn-line sparkline (DESIGN-001).
async function progressionPositionsBySmoke(
  deps: Deps,
  ids: string[],
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (ids.length === 0) return map;

  const rows = await deps.db
    .select({ smokeId: smokeProgression.smokeId, position: smokeProgression.approximatePosition })
    .from(smokeProgression)
    .where(and(inArray(smokeProgression.smokeId, ids), isNotNull(smokeProgression.approximatePosition)))
    .orderBy(smokeProgression.smokeId, asc(smokeProgression.ordinal));

  for (const row of rows) {
    const list = map.get(row.smokeId) ?? [];
    list.push(Number(row.position));
    map.set(row.smokeId, list);
  }
  return map;
}

// The authenticated user's history — compact summaries, newest first, capped.
export async function queryMySmokes(
  deps: Deps,
  principal: Principal,
  filters: QueryMySmokesFilters = {},
): Promise<QueryMySmokesResult> {
  validateQueryFilters(filters);
  const conditions = smokeConditions(principal, filters);
  const limit = clamp(filters.limit, DEFAULT_SMOKE_LIMIT, MAX_SMOKE_LIMIT);

  const rows = await deps.db
    .select({ smoke: smokes, cigarId: cigars.id, canonicalName: cigars.canonicalName })
    .from(smokes)
    .innerJoin(cigars, eq(smokes.cigarId, cigars.id))
    .where(and(...conditions))
    .orderBy(sql`${smokes.smokedAt} DESC NULLS LAST`, desc(smokes.createdAt))
    .limit(limit);

  const totals = await deps.db
    .select({ value: count() })
    .from(smokes)
    .innerJoin(cigars, eq(smokes.cigarId, cigars.id))
    .where(and(...conditions));

  const ids = rows.map((r) => r.smoke.id);

  // Only when the caller ran a text search do we attribute the hit and excerpt it.
  const provenance = filters.text ? await matchProvenance(deps, ids, filters.text) : null;
  const positions = await progressionPositionsBySmoke(deps, ids);

  const summaries: SmokeSummary[] = rows.map((row) => {
    const summary: SmokeSummary = {
      smokeId: row.smoke.id,
      cigar: { cigarId: row.cigarId, canonicalName: row.canonicalName },
      smokedAt: {
        value: row.smoke.smokedAt ? row.smoke.smokedAt.toISOString() : null,
        source: row.smoke.smokedAtSource,
        precision: row.smoke.smokedAtPrecision,
      },
      rating: row.smoke.rating,
      liked: row.smoke.liked,
      descriptors: row.smoke.overallDescriptors,
      summary: deriveSummary(row.smoke),
      progressionPositions: positions.get(row.smoke.id) ?? [],
    };
    if (provenance) {
      const p = provenance.get(row.smoke.id);
      summary.matchedIn = p?.matchedIn ?? [];
      summary.matchSnippet = p?.matchSnippet ?? null;
    }
    return summary;
  });

  return { smokes: summaries, totalMatches: Number(totals[0]?.value ?? 0) };
}

interface CigarMatchRow {
  id: string;
  canonical_name: string;
  brand: string | null;
  line: string | null;
  vitola_name: string | null;
  length_inches: string | null;
  ring_gauge: number | null;
  type: CigarMatch["type"];
  verification: CigarRow["verification"];
  user_smoke_count: number | string;
}

function toCigarMatch(row: CigarMatchRow): CigarMatch {
  return {
    cigarId: row.id,
    canonicalName: row.canonical_name,
    brand: row.brand,
    line: row.line,
    vitola: {
      name: row.vitola_name,
      lengthInches: row.length_inches != null ? Number(row.length_inches) : null,
      ringGauge: row.ring_gauge,
    },
    type: row.type,
    verification: row.verification,
    userSmokeCount: Number(row.user_smoke_count),
  };
}

// Resolve conversational cigar mentions via trigram matching. Guidance tells the
// client how to act (documented in docs/mcp/tool-contract.md search_cigars):
//   single_match    — top hit is an exact canonical name; proceed with it.
//   brand_match     — the query is only a brand name; ask the user for the line
//                     or vitola. matches are that brand's catalogued cigars.
//   multiple_matches— several fuzzy hits and no clean brand/exact winner; ask.
//   no_match        — nothing plausible; a described save creates the cigar.
export async function searchCigars(
  deps: Deps,
  principal: Principal,
  args: SearchCigarsArgs,
): Promise<SearchCigarsResult> {
  const limit = clamp(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const query = args.query.trim();

  const result = await deps.db.execute(sql`
    SELECT c.id, c.canonical_name, c.brand, c.line, c.vitola_name, c.length_inches, c.ring_gauge, c.type, c.verification,
      (SELECT count(*) FROM smokes s WHERE s.cigar_id = c.id AND s.user_id = ${principal.userId}) AS user_smoke_count
    FROM cigars c
    WHERE c.canonical_name % ${query} OR coalesce(c.brand, '') % ${query}
    ORDER BY GREATEST(similarity(c.canonical_name, ${query}), similarity(coalesce(c.brand, ''), ${query})) DESC
    LIMIT ${limit}
  `);
  const matches: CigarMatch[] = (result.rows as unknown as CigarMatchRow[]).map(toCigarMatch);

  if (matches.length === 0) return { matches, guidance: "no_match" };

  // An exact (case-insensitive) canonical-name hit is a confident resolution even
  // when weaker fuzzy hits trail it — proceed with the top match, keep the rest.
  if (matches[0]!.canonicalName.toLowerCase() === query.toLowerCase()) {
    return { matches, guidance: "single_match" };
  }

  // The query names only a brand (no specific product): return that brand's
  // catalogued cigars and ask the user to narrow to a line/vitola.
  const brandRows = await deps.db.execute(sql`
    SELECT c.id, c.canonical_name, c.brand, c.line, c.vitola_name, c.length_inches, c.ring_gauge, c.type, c.verification,
      (SELECT count(*) FROM smokes s WHERE s.cigar_id = c.id AND s.user_id = ${principal.userId}) AS user_smoke_count
    FROM cigars c
    WHERE lower(c.brand) = lower(${query})
    ORDER BY c.canonical_name
    LIMIT ${limit}
  `);
  const brandMatches = (brandRows.rows as unknown as CigarMatchRow[]).map(toCigarMatch);
  if (brandMatches.length > 0) return { matches: brandMatches, guidance: "brand_match" };

  // Anything reaching here is fuzzy without an exact canonical hit. A LONE fuzzy
  // candidate is NOT a confident resolution: trigram similarity is dominated by
  // shared brand tokens, so a different product under a known brand (e.g. a query
  // for "Arturo Fuente OpusX" against a catalogued "Arturo Fuente Hemingway")
  // scores high and would otherwise be labelled single_match → "proceed",
  // silently mislinking the smoke. Only an exact canonical-name hit (handled
  // above) earns single_match; every other candidate set asks the user to
  // confirm before saving.
  return { matches, guidance: "multiple_matches" };
}

function toCigarView(cigar: CigarRow): CigarView {
  return {
    cigarId: cigar.id,
    canonicalName: cigar.canonicalName,
    brand: cigar.brand,
    line: cigar.line,
    edition: cigar.edition,
    vitola: {
      name: cigar.vitolaName,
      lengthInches: cigar.lengthInches != null ? Number(cigar.lengthInches) : null,
      ringGauge: cigar.ringGauge,
    },
    type: cigar.type,
    manufacturer: cigar.manufacturer,
    factory: cigar.factory,
    productionCountry: cigar.productionCountry,
    tobacco: cigar.tobacco ?? null,
    blendNotes: cigar.blendNotes,
    releaseYear: cigar.releaseYear,
    verification: cigar.verification,
  };
}

function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value == null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, n] of counts) {
    if (n > bestCount) {
      best = value;
      bestCount = n;
    }
  }
  return best;
}

// Personal Profile is computed on read from the caller's Smokes (ADR-002),
// never materialized. Recurring descriptors are those appearing in >=2 smokes.
function computeProfile(
  rows: Pick<SmokeRow, "rating" | "overallDescriptors" | "strength" | "smokedAt">[],
): PersonalProfile {
  const descriptorCounts = new Map<string, number>();
  for (const row of rows) {
    for (const descriptor of new Set(row.overallDescriptors)) {
      descriptorCounts.set(descriptor, (descriptorCounts.get(descriptor) ?? 0) + 1);
    }
  }
  const recurringDescriptors = [...descriptorCounts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([descriptor]) => descriptor);

  const ratings = rows.map((r) => r.rating).filter((r): r is number => r != null);
  const rating =
    ratings.length > 0
      ? {
          average: Math.round(ratings.reduce((sum, r) => sum + r, 0) / ratings.length),
          min: Math.min(...ratings),
          max: Math.max(...ratings),
        }
      : null;

  const times = rows.map((r) => r.smokedAt).filter((t): t is Date => t != null);
  const lastSmokedAt =
    times.length > 0
      ? new Date(Math.max(...times.map((t) => t.getTime()))).toISOString().slice(0, 10)
      : null;

  return {
    smokeCount: rows.length,
    recurringDescriptors,
    rating,
    lastSmokedAt,
    typicalStrength: mostCommon(rows.map((r) => r.strength)),
  };
}

// Full catalog detail plus the caller's Personal Profile (null if never smoked).
export async function getCigar(
  deps: Deps,
  principal: Principal,
  args: { cigarId: string },
): Promise<GetCigarResult> {
  const rows = await deps.db.select().from(cigars).where(eq(cigars.id, args.cigarId)).limit(1);
  const cigar = rows[0];
  if (!cigar) throw new CigarNotFoundError();

  const smokeRows = await deps.db
    .select({
      rating: smokes.rating,
      overallDescriptors: smokes.overallDescriptors,
      strength: smokes.strength,
      smokedAt: smokes.smokedAt,
    })
    .from(smokes)
    .where(and(eq(smokes.cigarId, args.cigarId), eq(smokes.userId, principal.userId)));

  return {
    cigar: toCigarView(cigar),
    personalProfile: smokeRows.length > 0 ? computeProfile(smokeRows) : null,
  };
}

function toCatalogCigar(cigar: CigarRow): CatalogCigar {
  return {
    cigarId: cigar.id,
    canonicalName: cigar.canonicalName,
    brand: cigar.brand,
    line: cigar.line,
    vitola: {
      name: cigar.vitolaName,
      lengthInches: cigar.lengthInches != null ? Number(cigar.lengthInches) : null,
      ringGauge: cigar.ringGauge,
    },
    type: cigar.type,
    verification: cigar.verification,
  };
}

// The catalog's default browse view: alphabetical by canonical name, capped, and
// catalog-only (no per-caller personal fields). `totalCount` lets the UI note
// when the cap elides some. Auth-gated at the adapter; add principal-scoped
// personal counts here only if the view later folds in the caller's history.
export async function browseCigars(deps: Deps): Promise<BrowseCigarsResult> {
  const rows = await deps.db
    .select()
    .from(cigars)
    .orderBy(asc(cigars.canonicalName))
    .limit(BROWSE_CIGARS_LIMIT);

  const totals = await deps.db.select({ value: count() }).from(cigars);

  return {
    cigars: rows.map(toCatalogCigar),
    totalCount: Number(totals[0]?.value ?? 0),
  };
}
