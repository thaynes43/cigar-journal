import { and, eq, gte, lte, ilike, sql, desc, count, asc, type SQL } from "drizzle-orm";
import {
  cigars,
  smokes,
  smokeProgression,
  smokePhotos,
  productPhotos,
  type CigarRow,
  type SmokeRow,
  type SmokeProgressionRow,
  type SmokePhotoRow,
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
} from "./types.js";
import { SmokeNotFoundError, CigarNotFoundError } from "./errors.js";
import { normalizeDescriptor } from "./descriptors.js";
import { toSmokePhotoView } from "./mapping.js";
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

// Keyset cursor for the journal list (web infinite scroll). The list orders by
// (smokedAt DESC NULLS LAST, createdAt DESC, id DESC), so the cursor carries all
// three keys — smokedAt is nullable, hence the null tail below. Mirrors the
// opaque base64url cursor in catalog-browse.ts; the MCP tool never issues one.
interface SmokeCursor {
  smokedAt: string | null; // ISO instant, or null for the never-timestamped tail
  createdAt: string; // ISO instant
  id: string; // uuid, the final tie-breaker
}

function encodeSmokeCursor(c: SmokeCursor): string {
  return Buffer.from(JSON.stringify([c.smokedAt, c.createdAt, c.id]), "utf8").toString("base64url");
}

// A malformed cursor is treated as absent (first page) rather than an error — a
// stale link degrades gracefully, exactly as catalog-browse decodes its cursor.
function decodeSmokeCursor(raw: string | null | undefined): SmokeCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      (parsed[0] === null || typeof parsed[0] === "string") &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string"
    ) {
      return { smokedAt: parsed[0], createdAt: parsed[1], id: parsed[2] };
    }
    return null;
  } catch {
    return null;
  }
}

// The "rows strictly after the cursor" predicate for the list's compound order
// (smokedAt DESC NULLS LAST, createdAt DESC, id DESC). NULLS LAST means a null
// smokedAt sorts after every timestamped row, so a non-null cursor also admits
// the null tail; a null cursor is already inside that tail and only walks it.
function afterSmokeCursor(c: SmokeCursor): SQL {
  const created = new Date(c.createdAt);
  if (c.smokedAt !== null) {
    const smoked = new Date(c.smokedAt);
    return sql`(
      ${smokes.smokedAt} IS NULL
      OR ${smokes.smokedAt} < ${smoked}
      OR (${smokes.smokedAt} = ${smoked} AND ${smokes.createdAt} < ${created})
      OR (${smokes.smokedAt} = ${smoked} AND ${smokes.createdAt} = ${created} AND ${smokes.id} < ${c.id}::uuid)
    )`;
  }
  return sql`(
    ${smokes.smokedAt} IS NULL
    AND (
      ${smokes.createdAt} < ${created}
      OR (${smokes.createdAt} = ${created} AND ${smokes.id} < ${c.id}::uuid)
    )
  )`;
}

function toSmokeView(
  smoke: SmokeRow,
  cigar: { id: string; canonicalName: string; verification: CigarRow["verification"] },
  progression: SmokeProgressionRow[],
  photos: SmokePhotoRow[],
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
    photos: photos.map(toSmokePhotoView),
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

  const photos = await deps.db
    .select()
    .from(smokePhotos)
    .where(eq(smokePhotos.smokeId, args.smokeId))
    .orderBy(smokePhotos.createdAt);

  return toSmokeView(row.smoke, row.cigar, progression, photos);
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

  // At most one product photo per cigar (ADR-007) — its existence drives the
  // detail hero image; the bytes are served through the authed proxy route.
  const photoRows = await deps.db
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, args.cigarId))
    .limit(1);

  return {
    cigar: toCigarView(cigar),
    personalProfile: smokeRows.length > 0 ? computeProfile(smokeRows) : null,
    hasProductPhoto: photoRows.length > 0,
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

interface CigarOfferRow {
  vendor: string;
  price: string | null; // numeric column — pg returns it as a string
  currency: string | null;
  in_stock: boolean | null;
  listing_url: string | null;
  seen_at: string | Date; // timestamptz
}

// The current market snapshot for a cigar: the newest offer per vendor among its
// auto|confirmed listing matches, cheapest first (nulls last). Catalog-scoped,
// not owner-scoped — market data is the same for every viewer, so no principal.
// One query: DISTINCT ON collapses each vendor's append-only price series to its
// latest row, then the outer select orders by price — no N+1 across vendors.
export async function getCigarOffers(
  deps: Deps,
  args: { cigarId: string },
): Promise<CigarOffer[]> {
  const result = await deps.db.execute(sql`
    SELECT vendor, price, currency, in_stock, listing_url, seen_at
    FROM (
      SELECT DISTINCT ON (o.vendor_id)
        v.name AS vendor,
        o.price AS price,
        o.currency AS currency,
        o.in_stock AS in_stock,
        o.listing_url AS listing_url,
        o.seen_at AS seen_at
      FROM offers o
      JOIN listing_matches lm ON lm.id = o.listing_match_id
      JOIN vendors v ON v.id = o.vendor_id
      WHERE lm.cigar_id = ${args.cigarId}
        AND lm.status IN ('auto', 'confirmed')
      ORDER BY o.vendor_id, o.seen_at DESC, o.created_at DESC, o.id DESC
    ) latest
    ORDER BY latest.price ASC NULLS LAST, latest.vendor ASC
  `);

  return (result.rows as unknown as CigarOfferRow[]).map((row) => ({
    vendor: row.vendor,
    price: row.price != null ? Number(row.price) : null,
    currency: row.currency,
    inStock: row.in_stock,
    listingUrl: row.listing_url,
    seenAt: new Date(row.seen_at).toISOString(),
  }));
}
