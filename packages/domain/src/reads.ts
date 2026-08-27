import { and, eq, gte, lte, ilike, sql, desc, count, type SQL } from "drizzle-orm";
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
  SearchCigarsArgs,
  SearchCigarsResult,
  CigarMatch,
  GetCigarResult,
  CigarView,
  PersonalProfile,
} from "./types.js";
import { SmokeNotFoundError, CigarNotFoundError } from "./errors.js";
import { normalizeDescriptor } from "./descriptors.js";

const DEFAULT_SMOKE_LIMIT = 10;
const MAX_SMOKE_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

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

// The authenticated user's history — compact summaries, newest first, capped.
export async function queryMySmokes(
  deps: Deps,
  principal: Principal,
  filters: QueryMySmokesFilters = {},
): Promise<QueryMySmokesResult> {
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

  const summaries: SmokeSummary[] = rows.map((row) => ({
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
  }));

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

  const guidance = matches.length === 1 ? "single_match" : "multiple_matches";
  return { matches, guidance };
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
