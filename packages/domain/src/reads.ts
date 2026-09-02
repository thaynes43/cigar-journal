import { and, eq, ne, gte, lte, ilike, sql, desc, count, asc, type SQL } from "drizzle-orm";
import {
  cigars,
  smokes,
  smokeProgression,
  smokePhotos,
  smokeConsumptions,
  productPhotos,
  wants,
  favorites,
  brands,
  lines,
  blends,
  blenders,
  blendBlenders,
  type CigarRow,
  type SmokeRow,
  type SmokeProgressionRow,
  type SmokePhotoRow,
  type SmokeConsumptionRow,
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
  CigarOffer,
  CigarPricing,
  CigarPricingSingle,
  CigarPricePoint,
  OfferHistory,
  PriceType,
  CigarHierarchy,
} from "./types.js";
import { HIERARCHY_UNFILED } from "./types.js";
import { brandSlug } from "./catalog-browse.js";
import { SmokeNotFoundError, CigarNotFoundError } from "./errors.js";
import { normalizeDescriptor } from "./descriptors.js";
import { toSmokePhotoView } from "./mapping.js";
import { assessEnrichmentFields } from "./enrichment.js";
import { validateQueryFilters } from "./validation.js";
import { isUuid } from "./uuid.js";
import { vendorDisplaysPricesSql, offerIsDisplayableSql } from "./offer-display.js";
import { compareOffersByTier, packagingTier, TIER_SINGLE } from "./packaging-tier.js";
import { decodeSmokeCursor, encodeSmokeCursor, afterSmokeCursor } from "./smoke-cursor.js";
import { rankByIdentity, CANDIDATE_POOL } from "./name-heuristics.js";

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
  photos: SmokePhotoRow[],
  consumption: SmokeConsumptionRow | undefined,
): SmokeView {
  return {
    smokeId: smoke.id,
    version: smoke.version,
    cigar: {
      cigarId: cigar.id,
      canonicalName: cigar.canonicalName,
      verification: cigar.verification,
    },
    consumption: consumption
      ? { purchaseId: consumption.purchaseId, source: consumption.source }
      : null,
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
    photos: photos.map(toSmokePhotoView),
  };
}

// The canonical, complete representation of one Smoke — owner-only.
//
// A malformed id is answered as NOT-FOUND, not as a validation error, because to
// the caller it is indistinguishable from an id that names nothing: both mean
// "there is no such smoke", and the read already refuses to confirm existence to
// a non-owner. See `./uuid.ts` for why the guard belongs here and not in the
// adapters.
export async function getSmoke(
  deps: Deps,
  principal: Principal,
  args: { smokeId: string },
): Promise<SmokeView> {
  if (!isUuid(args.smokeId)) throw new SmokeNotFoundError();

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

  const photos = await deps.db
    .select()
    .from(smokePhotos)
    .where(eq(smokePhotos.smokeId, args.smokeId))
    .orderBy(smokePhotos.createdAt);

  // The explicit humidor link, if any (ADR-008). At most one per smoke.
  const consumptionRows = await deps.db
    .select()
    .from(smokeConsumptions)
    .where(eq(smokeConsumptions.smokeId, args.smokeId))
    .limit(1);

  return toSmokeView(row.smoke, row.cigar, progression, photos, consumptionRows[0]);
}

function smokeConditions(principal: Principal, filters: QueryMySmokesFilters): SQL[] {
  const conditions: SQL[] = [eq(smokes.userId, principal.userId)];
  // A malformed cigarId filter narrows to nothing rather than raising 22P02 —
  // the same empty page a filter naming an unknown cigar already returns
  // (./uuid.ts). A filter is not an identity, so there is no not-found to throw.
  if (filters.cigarId) {
    conditions.push(isUuid(filters.cigarId) ? eq(smokes.cigarId, filters.cigarId) : sql`false`);
  }
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

// The authenticated user's history — compact summaries, newest first, capped.
export async function queryMySmokes(
  deps: Deps,
  principal: Principal,
  filters: QueryMySmokesFilters = {},
): Promise<QueryMySmokesResult> {
  validateQueryFilters(filters);
  const conditions = smokeConditions(principal, filters);
  const limit = clamp(filters.limit, DEFAULT_SMOKE_LIMIT, MAX_SMOKE_LIMIT);

  // The cursor narrows only the page query, never the total — totalMatches stays
  // the full count across the filters (mirrors browseCatalog's totalCount).
  const cursor = decodeSmokeCursor(filters.cursor);
  const pageConditions = cursor ? [...conditions, afterSmokeCursor(cursor)] : conditions;

  // Fetch one extra row to decide whether a next cursor exists, then trim it off.
  const fetched = await deps.db
    .select({
      smoke: smokes,
      cigarId: cigars.id,
      canonicalName: cigars.canonicalName,
      // Correlated count of review photos — feeds the web card's photo badge.
      photoCount: sql<number>`(SELECT count(*) FROM smoke_photos p WHERE p.smoke_id = ${smokes.id})`,
      // Whether the smoke has an explicit humidor link (ADR-008) — feeds the
      // web card's "humidor" provenance tag. Web-only, like photoCount.
      fromHumidor: sql<boolean>`EXISTS (SELECT 1 FROM smoke_consumptions sc WHERE sc.smoke_id = ${smokes.id})`,
    })
    .from(smokes)
    .innerJoin(cigars, eq(smokes.cigarId, cigars.id))
    .where(and(...pageConditions))
    .orderBy(sql`${smokes.smokedAt} DESC NULLS LAST`, desc(smokes.createdAt), desc(smokes.id))
    .limit(limit + 1);

  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;

  const totals = await deps.db
    .select({ value: count() })
    .from(smokes)
    .innerJoin(cigars, eq(smokes.cigarId, cigars.id))
    .where(and(...conditions));

  const ids = rows.map((r) => r.smoke.id);

  // Only when the caller ran a text search do we attribute the hit and excerpt it.
  const provenance = filters.text ? await matchProvenance(deps, ids, filters.text) : null;

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
      strength: row.smoke.strength,
      photoCount: Number(row.photoCount),
      fromHumidor: Boolean(row.fromHumidor),
    };
    if (provenance) {
      const p = provenance.get(row.smoke.id);
      summary.matchedIn = p?.matchedIn ?? [];
      summary.matchSnippet = p?.matchSnippet ?? null;
    }
    return summary;
  });

  const last = rows[rows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeSmokeCursor({
          smokedAt: last.smoke.smokedAt ? last.smoke.smokedAt.toISOString() : null,
          createdAt: last.smoke.createdAt.toISOString(),
          id: last.smoke.id,
        })
      : null;

  return { smokes: summaries, totalMatches: Number(totals[0]?.value ?? 0), nextCursor };
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

// The ranking pool carries its trigram score; the brand-exact query below does
// not compute one and does not need one (it is ordered by name).
interface CigarPoolRow extends CigarMatchRow {
  sim: number | string;
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
//   no_match        — nothing plausible; add_cigar, then save against the
//                     cigarId it returns, in the same turn. A described save
//                     still creates the cigar, but that is the safety net for a
//                     client that skipped the prelude, not the documented
//                     action (#177).
// Only active catalog rows are candidates (DESIGN-003 §Curation): excluded
// pollution and merged tombstones never resolve here (the picker never offers a
// hidden row), so a smoke can never re-link to one.
export async function searchCigars(
  deps: Deps,
  principal: Principal,
  args: SearchCigarsArgs,
): Promise<SearchCigarsResult> {
  const limit = clamp(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const query = args.query.trim();

  const result = await deps.db.execute(sql`
    SELECT c.id, c.canonical_name, c.brand, c.line, c.vitola_name, c.length_inches, c.ring_gauge, c.type, c.verification,
      GREATEST(similarity(c.canonical_name, ${query}), similarity(coalesce(c.brand, ''), ${query})) AS sim,
      (SELECT count(*) FROM smokes s WHERE s.cigar_id = c.id AND s.user_id = ${principal.userId}) AS user_smoke_count
    FROM cigars c
    WHERE c.catalog_status = 'active'
      AND (c.canonical_name % ${query} OR coalesce(c.brand, '') % ${query})
    ORDER BY sim DESC
    LIMIT ${CANDIDATE_POOL}
  `);
  const matches: CigarMatch[] = rankByIdentity(
    query,
    result.rows as unknown as CigarPoolRow[],
    (row) => ({ name: row.canonical_name, sim: Number(row.sim) }),
  )
    .slice(0, limit)
    .map(toCigarMatch);

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
    WHERE c.catalog_status = 'active' AND lower(c.brand) = lower(${query})
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

// The leaf's structural ancestry (ADR-012, DESIGN-004 D-08) — the registry rows
// its three nullable FKs point at, plus the vitola label the leaf carries itself.
//
// Two queries, not four: one LEFT-JOINed row for the three registry levels (all
// 1:1 by primary key, so joining them costs a single index probe each), and one
// for the credited blenders, asked only when there is a blend to credit. Every
// level is independently nullable and an absent level comes back null — the
// breadcrumb then renders nothing for it, which is how "no level ever renders as
// Unknown" stays enforced by shape rather than by discipline at the call site.
async function loadCigarHierarchy(deps: Deps, cigar: CigarRow): Promise<CigarHierarchy> {
  const rows = await deps.db
    .select({
      brandName: brands.name,
      brandSlugValue: brands.slug,
      lineName: lines.name,
      lineSlugValue: lines.slug,
      blendName: blends.name,
      blendSlugValue: blends.slug,
      wrapper: blends.wrapper,
      binder: blends.binder,
      filler: blends.filler,
      strength: blends.strength,
    })
    .from(cigars)
    .leftJoin(brands, eq(brands.id, cigars.brandId))
    .leftJoin(lines, eq(lines.id, cigars.lineId))
    .leftJoin(blends, eq(blends.id, cigars.blendId))
    .where(eq(cigars.id, cigar.id))
    .limit(1);
  const row = rows[0];

  // The blender credit (ADR-012 amendment). An empty list is a FACT, not a gap —
  // Cuban blends credit the marca rather than a person — so no query runs and no
  // placeholder is invented when the leaf has no blend at all.
  const blenderRows = cigar.blendId
    ? await deps.db
        .select({ name: blenders.name, slug: blenders.slug })
        .from(blendBlenders)
        .innerJoin(blenders, eq(blenders.id, blendBlenders.blenderId))
        .where(eq(blendBlenders.blendId, cigar.blendId))
        .orderBy(asc(blenders.name))
    : [];

  // A vitola has no registry row (ADR-012 rejects a global vitolas table), so its
  // slug is derived with the same rule brandSlug() applies everywhere else. A
  // blank name has no level; so does a punctuation-only one, which slugs to the
  // empty string and would produce an unaddressable `?vitola=` link — the same
  // guard the SQL side applies in VITOLA_SLUG.
  // `unfiled` is skipped as a key here for the same reason SQL's VITOLA_SLUG
  // nulls it: at every level that value means IS NULL, so a `?vitola=unfiled`
  // link built from a cigar whose vitola is literally "Unfiled" would open the
  // screen of cigars with NO vitola — not this one. No link is the honest
  // outcome; the breadcrumb simply omits the level, which it already does for
  // every vitola it cannot address.
  const vitolaName = cigar.vitolaName?.trim() ?? "";
  const derivedVitolaSlug = vitolaName !== "" ? brandSlug(vitolaName) : "";
  const vitolaSlug = derivedVitolaSlug === HIERARCHY_UNFILED ? "" : derivedVitolaSlug;

  return {
    brand:
      row?.brandName != null && row.brandSlugValue != null
        ? { name: row.brandName, slug: row.brandSlugValue }
        : null,
    line:
      row?.lineName != null && row.lineSlugValue != null
        ? { name: row.lineName, slug: row.lineSlugValue }
        : null,
    blend:
      row?.blendName != null && row.blendSlugValue != null
        ? {
            name: row.blendName,
            slug: row.blendSlugValue,
            wrapper: row.wrapper,
            binder: row.binder,
            filler: row.filler,
            strength: row.strength,
          }
        : null,
    vitola: vitolaSlug !== "" ? { name: vitolaName, slug: vitolaSlug } : null,
    blenders: blenderRows.map((b) => ({ name: b.name, slug: b.slug })),
  };
}

// Full catalog detail plus the caller's Personal Profile (null if never smoked).
export async function getCigar(
  deps: Deps,
  principal: Principal,
  args: { cigarId: string },
): Promise<GetCigarResult> {
  if (!isUuid(args.cigarId)) throw new CigarNotFoundError();

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

  // At most one product photo per cigar (ADR-007) — its existence drives the
  // detail hero image; the bytes are served through the authed proxy route. A
  // `suppressed` photo (rights takedown, DESIGN-003 §Curation) counts as absent,
  // matching getProductPhoto's serving gate and the catalog-browse tile join — so
  // a suppressed hero falls back to the monogram instead of a broken proxy image.
  const photoRows = await deps.db
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(and(eq(productPhotos.cigarId, args.cigarId), ne(productPhotos.rights, "suppressed")))
    .limit(1);
  // The photo's row id — a fresh uuid on every crawl/upload/replace (attach
  // deletes+re-inserts), so the detail hero can fingerprint its immutable image
  // URL and a Replace is seen immediately instead of the browser serving the
  // cached prior photo under the stable per-cigar path.
  const productPhotoId = photoRows[0]?.id ?? null;

  // The caller's want overlay (PRD-003 R-WANT-3): whether they marked this cigar
  // and the optional MCP-authored note. Principal-scoped — never another user's.
  const wantRows = await deps.db
    .select({ note: wants.note })
    .from(wants)
    .where(and(eq(wants.cigarId, args.cigarId), eq(wants.userId, principal.userId)))
    .limit(1);

  // The caller's favorite overlay (PRD-003, DESIGN-002) — the second cigar-level
  // mark, mirroring the want overlay. Principal-scoped — never another user's.
  const favoriteRows = await deps.db
    .select({ note: favorites.note })
    .from(favorites)
    .where(and(eq(favorites.cigarId, args.cigarId), eq(favorites.userId, principal.userId)))
    .limit(1);

  // Additive catalog-repair + market hints (ADR-009), both catalog-scoped (same
  // for every viewer). `enrichment` reuses the shared completeness gate; `pricing`
  // is the compact summary over the cigar's observations (null when none).
  const hasProductPhoto = productPhotoId != null;
  const enrichmentFields = assessEnrichmentFields(cigar, hasProductPhoto);
  const pricing = await getCigarPricing(deps, args.cigarId);
  // The structural ancestry behind the D-08 breadcrumb and facts rows.
  // Catalog-scoped, like enrichment and pricing — the same for every viewer.
  const hierarchy = await loadCigarHierarchy(deps, cigar);

  return {
    cigar: toCigarView(cigar),
    personalProfile: smokeRows.length > 0 ? computeProfile(smokeRows) : null,
    enrichment: {
      recommended: !enrichmentFields.complete,
      missingFields: enrichmentFields.missingFields,
      verification: cigar.verification,
    },
    pricing,
    hasProductPhoto,
    productPhotoId,
    wanted: wantRows.length > 0,
    wantNote: wantRows[0]?.note ?? null,
    favorited: favoriteRows.length > 0,
    favoriteNote: favoriteRows[0]?.note ?? null,
    hierarchy,
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
// Only active rows show (DESIGN-003 §Curation): excluded pollution and merged
// tombstones drop out of both the list and its total.
export async function browseCigars(deps: Deps): Promise<BrowseCigarsResult> {
  const rows = await deps.db
    .select()
    .from(cigars)
    .where(eq(cigars.catalogStatus, "active"))
    .orderBy(asc(cigars.canonicalName))
    .limit(BROWSE_CIGARS_LIMIT);

  const totals = await deps.db
    .select({ value: count() })
    .from(cigars)
    .where(eq(cigars.catalogStatus, "active"));

  return {
    cigars: rows.map(toCatalogCigar),
    totalCount: Number(totals[0]?.value ?? 0),
  };
}

// A cigar's price observations older than this are stale enough to flag a refresh
// on the compact get_cigar summary (ADR-009, 30d staleness window).
const PRICING_STALE_MS = 30 * 24 * 60 * 60 * 1000;

interface SeriesRow {
  source: string;
  is_registry: boolean;
  purchase_linkout: boolean;
  price: string | null; // numeric column — pg returns it as a string
  currency: string | null;
  in_stock: boolean | null;
  listing_url: string | null;
  seen_at: string | Date; // timestamptz
  packaging: string | null;
  sticks_per_package: number | null;
  price_per_stick_cents: number | null;
  price_type: PriceType;
}

// The current observation per (source, packaging) series for a cigar, cheapest
// per-stick first (nulls last), then package price. One query over the unified
// observation set (ADR-009): crawler/registry rows reach the cigar through their
// auto|confirmed listing match (the curator-authoritative link); ad-hoc chat rows
// link directly via cigar_id with no listing match. DISTINCT ON collapses each
// append-only series to its latest row — no N+1 across sources/packagings.
//
// Both arms carry the ADR-015 display gate (./offer-display.ts): the match status
// says a price belongs to this cigar, `display_enabled` says it may be SHOWN.
async function latestSeries(deps: Deps, cigarId: string): Promise<SeriesRow[]> {
  // No series for a malformed id, exactly as for a cigar nobody has priced
  // (./uuid.ts). Guarding here rather than in each caller is what carries the
  // contract into getCigarOffers (maps to `[]`) and getCigarPricing (its
  // `rows.length === 0` path returns null before it runs its own totals query).
  if (!isUuid(cigarId)) return [];

  const result = await deps.db.execute(sql`
    WITH obs AS (
      SELECT v.name AS source, TRUE AS is_registry, v.purchase_linkout,
             o.price, o.currency, o.in_stock,
             COALESCE(o.listing_url, o.source_url) AS listing_url,
             o.seen_at, o.created_at, o.id,
             o.packaging, o.sticks_per_package, o.price_per_stick_cents, o.price_type
      FROM offers o
      JOIN listing_matches lm ON lm.id = o.listing_match_id
      JOIN vendors v ON v.id = o.vendor_id
      WHERE lm.cigar_id = ${cigarId} AND lm.status IN ('auto', 'confirmed')
        AND ${vendorDisplaysPricesSql(sql`v`)}
      UNION ALL
      -- Ad-hoc/chat sources have no vendor row: purchase_linkout defaults TRUE
      -- (nothing to gate; a registry vendor supplies the real flag above).
      SELECT COALESCE(v.name, o.source_name) AS source, (o.vendor_id IS NOT NULL) AS is_registry,
             COALESCE(v.purchase_linkout, TRUE) AS purchase_linkout,
             o.price, o.currency, o.in_stock,
             COALESCE(o.listing_url, o.source_url) AS listing_url,
             o.seen_at, o.created_at, o.id,
             o.packaging, o.sticks_per_package, o.price_per_stick_cents, o.price_type
      FROM offers o
      LEFT JOIN vendors v ON v.id = o.vendor_id
      WHERE o.cigar_id = ${cigarId} AND o.listing_match_id IS NULL
        AND ${offerIsDisplayableSql(sql`o.vendor_id`, sql`v`)}
    )
    SELECT source, is_registry, purchase_linkout, price, currency, in_stock, listing_url, seen_at,
           packaging, sticks_per_package, price_per_stick_cents, price_type
    FROM (
      SELECT DISTINCT ON (source, packaging) *
      FROM obs
      ORDER BY source, packaging, seen_at DESC, created_at DESC, id DESC
    ) latest
    ORDER BY latest.price_per_stick_cents ASC NULLS LAST, latest.price ASC NULLS LAST, latest.source ASC
  `);
  return result.rows as unknown as SeriesRow[];
}

// The current market snapshot for a cigar: the newest observation per (source,
// packaging) series, in the tier order a buyer thinks in (DESIGN-005 rule 2 —
// single → packs → box → packaging not stated, best per-stick inside each).
// Catalog-scoped, not owner-scoped — market data is the same for every viewer, so
// no principal. The order is part of the payload: the web groups the rows into
// tier blocks and get_offers hands the model the same sequence.
export async function getCigarOffers(
  deps: Deps,
  args: { cigarId: string },
): Promise<CigarOffer[]> {
  const rows = await latestSeries(deps, args.cigarId);
  return rows
    .map((row) => ({
      vendor: row.source,
      isRegistryVendor: Boolean(row.is_registry),
      purchaseLinkout: Boolean(row.purchase_linkout),
      price: row.price != null ? Number(row.price) : null,
      currency: row.currency,
      inStock: row.in_stock,
      listingUrl: row.listing_url,
      seenAt: new Date(row.seen_at).toISOString(),
      packaging: row.packaging,
      sticksPerPackage: row.sticks_per_package,
      pricePerStick: row.price_per_stick_cents != null ? row.price_per_stick_cents / 100 : null,
      priceType: row.price_type,
    }))
    .sort(compareOffersByTier);
}

// The compact price history behind get_offers (PRD-003 R-MCP-2, ADR-009): span
// and per-stick range over the cigar's whole observation series — the SAME two
// offer paths getCigarPricing counts (crawler rows through their auto|confirmed
// listing match; ad-hoc/chat rows direct via cigar_id), aggregated in one pass.
// per-stick bounds cover only observations where a per-stick figure is stored;
// null when the cigar has no such observation. Catalog-scoped — no principal.
const EMPTY_OFFER_HISTORY: OfferHistory = {
  firstSeenAt: null,
  lastSeenAt: null,
  minPricePerStick: null,
  maxPricePerStick: null,
  observationCount: 0,
};

export async function getCigarOfferHistory(
  deps: Deps,
  args: { cigarId: string },
): Promise<OfferHistory> {
  // The empty history a cigar with no observations already reports (./uuid.ts).
  // This read runs its own SQL rather than going through latestSeries, so it
  // carries its own guard.
  if (!isUuid(args.cigarId)) return EMPTY_OFFER_HISTORY;

  const result = await deps.db.execute(sql`
    WITH obs AS (
      SELECT o.seen_at, o.price_per_stick_cents
      FROM offers o
      JOIN listing_matches lm ON lm.id = o.listing_match_id
      JOIN vendors v ON v.id = o.vendor_id
      WHERE lm.cigar_id = ${args.cigarId} AND lm.status IN ('auto', 'confirmed')
        AND ${vendorDisplaysPricesSql(sql`v`)}
      UNION ALL
      SELECT o.seen_at, o.price_per_stick_cents FROM offers o
      LEFT JOIN vendors v ON v.id = o.vendor_id
      WHERE o.cigar_id = ${args.cigarId} AND o.listing_match_id IS NULL
        AND ${offerIsDisplayableSql(sql`o.vendor_id`, sql`v`)}
    )
    SELECT count(*)::int AS n,
           min(seen_at) AS first_seen, max(seen_at) AS last_seen,
           min(price_per_stick_cents) AS min_pps, max(price_per_stick_cents) AS max_pps
    FROM obs
  `);
  const row = (
    result.rows as unknown as {
      n: number;
      first_seen: string | Date | null;
      last_seen: string | Date | null;
      min_pps: number | null;
      max_pps: number | null;
    }[]
  )[0];
  return {
    firstSeenAt: row?.first_seen != null ? new Date(row.first_seen).toISOString() : null,
    lastSeenAt: row?.last_seen != null ? new Date(row.last_seen).toISOString() : null,
    minPricePerStick: row?.min_pps != null ? Number(row.min_pps) / 100 : null,
    maxPricePerStick: row?.max_pps != null ? Number(row.max_pps) / 100 : null,
    observationCount: Number(row?.n ?? 0),
  };
}

// In-stock is "not explicitly out of stock" — an unknown (null) stock counts as
// available, since the crawler leaves it null when the listing didn't say.
function available(row: SeriesRow): boolean {
  return row.in_stock !== false;
}

// The figure a series shows: its per-stick when derivable, else the packaging
// unit's price. For a single these are the same number, which is why bestSingle
// can compare on it without caring which column carried it.
function seriesAmount(row: SeriesRow): number | null {
  if (row.price_per_stick_cents != null) return row.price_per_stick_cents / 100;
  return row.price != null ? Number(row.price) : null;
}

// The cheapest current single (DESIGN-005 rule 4). Scoped to the single tier and
// then in-stock-preferred WITHIN it, the same shape `lowest` uses over the whole
// pool: an out-of-stock single is still what a stick costs at that shop, so it
// answers rather than leaving the second half of the headline blank. Series are
// already collapsed to their latest observation upstream, so a shop's older
// price can never win over its current one — the stale-vs-fresh rule `lowest`
// gets from latestSeries, unchanged.
function bestSingleOf(rows: SeriesRow[]): CigarPricingSingle | null {
  const singles = rows.filter(
    (row) =>
      packagingTier(row.packaging, row.sticks_per_package).order === TIER_SINGLE &&
      seriesAmount(row) != null,
  );
  if (singles.length === 0) return null;
  const stocked = singles.filter(available);
  const pool = stocked.length > 0 ? stocked : singles;
  const best = [...pool].sort(
    (a, b) =>
      seriesAmount(a)! - seriesAmount(b)! ||
      new Date(b.seen_at).getTime() - new Date(a.seen_at).getTime(),
  )[0]!;
  return {
    amount: seriesAmount(best)!,
    currency: best.currency,
    vendor: best.source,
    seenAt: new Date(best.seen_at).toISOString(),
  };
}

// The compact pricing summary (ADR-009): the best CURRENT per-stick (in-stock
// preferred, ties toward singles) with its packaging, else the lowest package
// price with packaging; the cheapest single alongside it (DESIGN-005 — the
// headline is two facts, not one); plus distinct-source and observation counts
// and the 30d staleness flag. Null when the cigar has no observations. The
// per-stick figure never travels without its packaging — the display rule is
// enforced by shape.
export async function getCigarPricing(deps: Deps, cigarId: string): Promise<CigarPricing | null> {
  const rows = await latestSeries(deps, cigarId);
  if (rows.length === 0) return null;

  const totals = await deps.db.execute(sql`
    WITH obs AS (
      SELECT o.id, o.seen_at
      FROM offers o
      JOIN listing_matches lm ON lm.id = o.listing_match_id
      JOIN vendors v ON v.id = o.vendor_id
      WHERE lm.cigar_id = ${cigarId} AND lm.status IN ('auto', 'confirmed')
        AND ${vendorDisplaysPricesSql(sql`v`)}
      UNION ALL
      SELECT o.id, o.seen_at FROM offers o
      LEFT JOIN vendors v ON v.id = o.vendor_id
      WHERE o.cigar_id = ${cigarId} AND o.listing_match_id IS NULL
        AND ${offerIsDisplayableSql(sql`o.vendor_id`, sql`v`)}
    )
    SELECT count(*)::int AS n, max(seen_at) AS latest FROM obs
  `);
  const totalsRow = (totals.rows as unknown as { n: number; latest: string | Date | null }[])[0];
  const observationCount = Number(totalsRow?.n ?? rows.length);
  const latestSeen = totalsRow?.latest != null ? new Date(totalsRow.latest) : null;

  // Prefer in-stock series; fall back to all when nothing is in stock.
  const preferred = rows.filter(available);
  const pool = preferred.length > 0 ? preferred : rows;

  // Best per-stick with a derivable figure; ties toward singles (fewest sticks).
  const perStick = pool
    .filter((r) => r.price_per_stick_cents != null)
    .sort(
      (a, b) =>
        a.price_per_stick_cents! - b.price_per_stick_cents! ||
        (a.sticks_per_package ?? Infinity) - (b.sticks_per_package ?? Infinity),
    );
  // Otherwise the lowest package price.
  const byPrice = pool
    .filter((r) => r.price != null)
    .sort((a, b) => Number(a.price) - Number(b.price));

  const best = perStick[0] ?? byPrice[0] ?? null;
  const lowest =
    best == null
      ? null
      : best.price_per_stick_cents != null
        ? {
            perStick: true as const,
            amount: best.price_per_stick_cents / 100,
            packaging: best.packaging,
            sticksPerPackage: best.sticks_per_package,
          }
        : {
            perStick: false as const,
            amount: Number(best.price),
            packaging: best.packaging,
            sticksPerPackage: best.sticks_per_package,
          };

  const sourceCount = new Set(rows.map((r) => r.source)).size;
  const observedAt = best != null ? new Date(best.seen_at).toISOString() : new Date(rows[0]!.seen_at).toISOString();
  const refreshRecommended = latestSeen != null && deps.now().getTime() - latestSeen.getTime() > PRICING_STALE_MS;

  return {
    lowest,
    bestSingle: bestSingleOf(rows),
    currency: best?.currency ?? rows[0]!.currency,
    observedAt,
    sourceCount,
    observationCount,
    refreshRecommended,
  };
}

interface PricePointRow {
  seen_at: string | Date;
  price_per_stick_cents: number;
}

// The cigar's per-stick price observations over time, oldest first — the source
// for the detail page's price-history line (DESIGN-002 §Price). Reuses the offers
// obs union (crawler rows via an auto|confirmed listing match; ad-hoc chat rows
// direct on cigar_id), but keeps EVERY observation rather than collapsing to the
// latest per series — history needs the whole series. Only observations with a
// derivable per-stick are returned: the trend charts per-stick, so a point
// without one has no honest place on the axis. Catalog-scoped, like getCigarOffers.
export async function getCigarPriceHistory(
  deps: Deps,
  args: { cigarId: string },
): Promise<CigarPricePoint[]> {
  // No points for a malformed id, as for a cigar with no per-stick observation
  // (./uuid.ts). Own SQL, so own guard — same reason as getCigarOfferHistory.
  if (!isUuid(args.cigarId)) return [];

  const result = await deps.db.execute(sql`
    WITH obs AS (
      SELECT o.seen_at, o.price_per_stick_cents
      FROM offers o
      JOIN listing_matches lm ON lm.id = o.listing_match_id
      JOIN vendors v ON v.id = o.vendor_id
      WHERE lm.cigar_id = ${args.cigarId} AND lm.status IN ('auto', 'confirmed')
        AND ${vendorDisplaysPricesSql(sql`v`)}
      UNION ALL
      SELECT o.seen_at, o.price_per_stick_cents
      FROM offers o
      LEFT JOIN vendors v ON v.id = o.vendor_id
      WHERE o.cigar_id = ${args.cigarId} AND o.listing_match_id IS NULL
        AND ${offerIsDisplayableSql(sql`o.vendor_id`, sql`v`)}
    )
    SELECT seen_at, price_per_stick_cents
    FROM obs
    WHERE price_per_stick_cents IS NOT NULL
    ORDER BY seen_at ASC
  `);
  return (result.rows as unknown as PricePointRow[]).map((row) => ({
    seenAt: new Date(row.seen_at).toISOString(),
    pricePerStick: row.price_per_stick_cents / 100,
  }));
}
