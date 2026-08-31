import { sql, eq, inArray } from "drizzle-orm";
import { blends, brands, lines } from "@cj/db";
import type { Queryer } from "./deps.js";
import { windowKeys, fold, anchorByAlias, registrySlugCandidates, MIN_ANCHOR_KEY_LENGTH, type AliasCandidate } from "./taxonomy-keys.js";
import {
  parseListingTitle,
  stripPackaging,
  extractDims,
  tokenizeTitle,
  type ListingParse,
  type ParseRegistry,
} from "./catalog-parse.js";
import { numbersCompatible, packagingCompatible, variantRelation, vitolaAgrees } from "./name-heuristics.js";
import { isUuid } from "./uuid.js";
import type { CigarAncestry, CigarAncestryContext } from "./cigar-ancestry.js";

// The database half of matching v2: registry probes in, a `ListingParse` out,
// and the scoped candidate set the match decision runs over. Everything that
// decides anything is pure and lives in catalog-parse.ts / name-heuristics.ts;
// this file only fetches.

interface LineCandidate extends AliasCandidate {
  brandId: string;
}

interface BlendCandidate extends AliasCandidate {
  lineId: string;
}

// THE ANCHOR PROBE. One GIN lookup against `brands_aliases_gin` with every window
// key the title could produce. This is the query the whole 0026 alias convention
// exists to serve: because `aliases` holds pre-folded matching keys and nothing
// else, containment is an exact-match index probe rather than a scan with a
// per-row normalization that no index could help.
async function probeBrands(db: Queryer, keys: string[]): Promise<AliasCandidate[]> {
  if (keys.length === 0) return [];
  const result = await db.execute(sql`
    SELECT id, name, aliases FROM brands WHERE aliases && ${sql.param(keys)}::text[]
  `);
  return result.rows as unknown as AliasCandidate[];
}

async function probeLines(db: Queryer, brandId: string, keys: string[]): Promise<LineCandidate[]> {
  if (keys.length === 0) return [];
  const result = await db.execute(sql`
    SELECT id, name, aliases, brand_id AS "brandId"
    FROM lines
    WHERE brand_id = ${brandId} AND aliases && ${sql.param(keys)}::text[]
  `);
  return result.rows as unknown as LineCandidate[];
}

async function probeBlends(db: Queryer, lineIds: string[], keys: string[]): Promise<BlendCandidate[]> {
  if (keys.length === 0 || lineIds.length === 0) return [];
  const result = await db.execute(sql`
    SELECT id, name, aliases, line_id AS "lineId"
    FROM blends
    WHERE line_id = ANY(${sql.param(lineIds)}::uuid[]) AND aliases && ${sql.param(keys)}::text[]
  `);
  return result.rows as unknown as BlendCandidate[];
}

// Parse a listing title against the live registries.
//
// The brand is anchored TWICE and that is deliberate, not waste: once here on the
// probe result to learn which brand's lines to fetch, and once inside
// `parseListingTitle`, which is the authority. Both runs are the same pure
// function over the same keys, so they cannot disagree; prefetching a superset
// and letting the pure pipeline make every decision keeps the parse testable
// against literals with no database at all.
export async function parseListing(db: Queryer, title: string): Promise<ListingParse> {
  const { cleaned } = stripPackaging(title);
  const { remainder } = extractDims(cleaned);
  const { keys, segmentStarts } = tokenizeTitle(remainder);
  const probeKeys = windowKeys(keys);

  const brandRows = await probeBrands(db, probeKeys);
  // THE SAME CONSTRAINTS THE AUTHORITY APPLIES. This anchor exists only to learn
  // which brand's lines to prefetch, but it must agree with the one inside
  // `parseListingTitle` or it would fetch the lines of a brand the parse then
  // refuses — and the parse would find no candidates for the brand it did pick.
  const brand = anchorByAlias(keys, brandRows, { segmentStarts, minKeyLength: MIN_ANCHOR_KEY_LENGTH });

  const lineRows = brand ? await probeLines(db, brand.entity.id, probeKeys) : [];
  const blendRows = lineRows.length > 0 ? await probeBlends(db, lineRows.map((row) => row.id), probeKeys) : [];

  const registry: ParseRegistry = {
    brands: brandRows,
    linesOfBrand: (brandId) => lineRows.filter((row) => row.brandId === brandId),
    blendsOfLine: (lineId) => blendRows.filter((row) => row.lineId === lineId),
  };
  return parseListingTitle(title, registry);
}

// --------------------------------------------------------------------------
// Ancestry context — the loader every wired write path needs.
// --------------------------------------------------------------------------

// Load the registry rows an ancestry claims, in the shape `assertCigarAncestry`
// checks against. A level whose row does not exist comes back null, which the
// assertion reports as a violation — a caller asserting a line it cannot resolve
// is exactly as wrong as one asserting a line from another brand.
//
// A MALFORMED ID IS AN UNRESOLVABLE LEVEL, not an error. Skipping the query
// leaves the level to the same `?? null` a miss takes, so `assertCigarAncestry`
// reports the identical violation and every caller keeps its own established
// refusal without knowing the guard exists (./uuid.ts). One check here covers
// lineId and blendId for `assignCigarTaxonomy`, `splitCigar` and
// `assignCigarParts` alike — and all three read on a transaction a 22P02 would
// abort, so it has to happen instead of the query rather than around it.
export async function loadAncestryContext(db: Queryer, ancestry: CigarAncestry): Promise<CigarAncestryContext> {
  const context: CigarAncestryContext = {};

  if (ancestry.lineId != null) {
    const rows = isUuid(ancestry.lineId)
      ? await db
          .select({ id: lines.id, brandId: lines.brandId })
          .from(lines)
          .where(eq(lines.id, ancestry.lineId))
          .limit(1)
      : [];
    context.line = rows[0] ?? null;
  }
  if (ancestry.blendId != null) {
    const rows = isUuid(ancestry.blendId)
      ? await db
          .select({ id: blends.id, lineId: blends.lineId })
          .from(blends)
          .where(eq(blends.id, ancestry.blendId))
          .limit(1)
      : [];
    context.blend = rows[0] ?? null;
  }

  return context;
}

// --------------------------------------------------------------------------
// The scoped candidate set — trigram, demoted to ranking within one brand.
// --------------------------------------------------------------------------

export interface LeafCandidate {
  cigarId: string;
  canonicalName: string;
  brandId: string | null;
  lineId: string | null;
  blendId: string | null;
  vitolaName: string | null;
  sim: number;
}

interface LeafCandidateRow {
  id: string;
  canonical_name: string;
  brand_id: string | null;
  line_id: string | null;
  blend_id: string | null;
  vitola_name: string | null;
  sim: number;
}

// The SQL transcription of `fold()` — NFKD, drop the combining marks, then the
// brandSlug rule with an explicit character class (a `a-z` range is
// collation-dependent inside a bracket expression and can swallow accented
// letters under a non-C collation). Identical to the expression migration 0026
// seeds `brands.aliases` with, which is what makes the comparison below sound.
const FOLDED_NAME = sql`btrim(regexp_replace(lower(regexp_replace(normalize(c.canonical_name, NFKD), U&'[\\0300-\\036F]', '', 'g')), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')`;

export const SCOPE_LIMIT = 25;

// Every leaf that could plausibly be this listing, and NOTHING ELSE. Scope is
// the brand — that single restriction is what turns trigram from a ranker of the
// whole catalog (where it ranks `Liga Privada No. 9` and `T52` as near-identical)
// into a tie-breaker among siblings of one marca, which is the only job it is
// good at.
//
// THE SECOND CLAUSE IS A BRIDGE AND IT IS TEMPORARY. 0026 linked `brand_id` only
// for rows that already carried a free-text brand; 565 active rows carry none,
// and attaching them is Wave 3 curation on evidence, not something a matcher may
// do. Without this clause a re-crawl would fail to see those rows, find no
// candidate, and MINT A DUPLICATE of each one — turning the migration that was
// supposed to end per-vendor catalogs into the event that doubled them. So an
// unlinked row whose own name folds to the anchored brand's key (or begins with
// it) is admitted to the scope on the strength of its name alone. It links the
// listing; it does not write `brand_id`, because inferring a cigar's brand from
// its title is precisely the curation judgement Wave 3 owns.
//
// It dies with the backfill: when every active row carries a `brand_id`, this
// clause matches nothing and can be deleted with the `LIKE` scan it costs.
export async function scopedLeafCandidates(
  db: Queryer,
  parse: ListingParse,
  limit = SCOPE_LIMIT,
): Promise<LeafCandidate[]> {
  if (parse.brandId == null) return [];

  const result = await db.execute(sql`
    SELECT c.id, c.canonical_name, c.brand_id, c.line_id, c.blend_id, c.vitola_name,
           similarity(c.canonical_name, ${parse.cleanedName}) AS sim
    FROM cigars c
    WHERE c.catalog_status = 'active'
      AND (
        c.brand_id = ${parse.brandId}
        OR (
          c.brand_id IS NULL
          AND EXISTS (
            -- EVERY key the brand answers to, read from the registry rather than
            -- derived from its display name. The anchor matched on any alias, so
            -- a bridge that only ever tried fold(name) would fail to admit a
            -- brand's own unlinked rows the moment its catalog spelling and its
            -- registered name differ: a brand named Oliva Cigar Co. that answers
            -- to the key oliva would silently see none of its orphans.
            SELECT 1
            FROM brands anchor_b
            CROSS JOIN LATERAL unnest(anchor_b.aliases) AS a(key)
            WHERE anchor_b.id = ${parse.brandId}
              AND (
                ${FOLDED_NAME} = a.key
                -- The prefix form needs a floor. A one- or two-character key
                -- (la, de) drags every unrelated marca starting with that word
                -- into scope on the strength of one syllable; three is enough to
                -- keep real short marcas (CAO, LFD) working while refusing the
                -- ones that are just articles. Exact equality is unguarded — a
                -- key that IS the whole folded name is never accidental.
                OR (length(a.key) >= 3 AND ${FOLDED_NAME} LIKE a.key || '-%')
              )
          )
        )
      )
    -- STRUCTURE ORDERS THE WINDOW, not just the choice. Arturo Fuente has 52
    -- active rows and Drew Estate 46, so a brand's leaves do not all fit in one
    -- LIMIT — and if that window were ordered by trigram alone, the leaf carrying
    -- the very blend this listing named could fall outside it while 25 siblings
    -- that merely share a prefix stayed in. The chooser would then never see the
    -- right answer and would mint a duplicate of a row that exists. Ranking the
    -- structural agreement first guarantees the candidates the parse actually
    -- points at are in the window; similarity only breaks ties inside it.
    --
    -- COALESCE, not a bare comparison: comparing a uuid column to NULL yields
    -- NULL rather than false, and ORDER BY ... DESC puts NULLs FIRST in Postgres
    -- — so an unguarded term would sort every structured row to the top of the
    -- window precisely when the parse resolved no blend to compare them against.
    ORDER BY COALESCE(c.blend_id = ${parse.blendId}, false) DESC,
             COALESCE(c.line_id = ${parse.lineId}, false) DESC,
             sim DESC
    LIMIT ${limit}
  `);

  return (result.rows as unknown as LeafCandidateRow[]).map((row) => ({
    cigarId: row.id,
    canonicalName: row.canonical_name,
    brandId: row.brand_id,
    lineId: row.line_id,
    blendId: row.blend_id,
    vitolaName: row.vitola_name,
    sim: Number(row.sim),
  }));
}

// THE LAST CHECK BEFORE A MINT, AND IT IS A WAVE 3 CASUALTY BY DESIGN.
//
// The scope query above can only see rows it can attribute to the anchored
// brand: rows carrying its `brand_id`, plus the bridge clause's unlinked rows
// whose own name folds to one of the brand's keys. That bridge admits 54 of
// prod's 570 unlinked rows. The other 516 are invisible to the scope of EVERY
// brand — their names do not begin with the marca (`Fuente Fuente OpusX
// Perfecxion No. 2` does not start with `Arturo Fuente`) — and a listing that
// anchors, finds nothing under the brand, and mints would create a second row
// for a cigar the catalog already holds. That is the failure ADR-012 exists to
// end, arriving through the door built to prevent it.
//
// So: one unscoped similarity pass over the unlinked rows, and a hit is a
// QUESTION rather than a mint. Unscoped on purpose — the whole point is that
// these rows cannot be attributed to a brand, so scoping would re-introduce the
// blindness. Deliberately narrow: `brand_id IS NULL` only, so it reads a
// shrinking set and never re-ranks the catalog at large.
//
// IT DIES WITH WAVE 3. When the backfill attaches every active row to a brand,
// `brand_id IS NULL` matches nothing, this query costs one index probe that
// returns no rows, and it should be deleted along with the bridge clause above.
export async function findUnlinkedNameCollision(
  db: Queryer,
  cleanedName: string,
  threshold = SCOPED_MATCH_THRESHOLD,
): Promise<LeafCandidate | null> {
  if (cleanedName.trim() === "") return null;

  const result = await db.execute(sql`
    SELECT c.id, c.canonical_name, c.brand_id, c.line_id, c.blend_id, c.vitola_name,
           similarity(c.canonical_name, ${cleanedName}) AS sim
    FROM cigars c
    WHERE c.catalog_status = 'active'
      AND c.brand_id IS NULL
      AND c.canonical_name % ${cleanedName}
      AND similarity(c.canonical_name, ${cleanedName}) >= ${threshold}
    ORDER BY sim DESC
    LIMIT 1
  `);

  const row = (result.rows as unknown as LeafCandidateRow[])[0];
  if (!row) return null;
  return {
    cigarId: row.id,
    canonicalName: row.canonical_name,
    brandId: row.brand_id,
    lineId: row.line_id,
    blendId: row.blend_id,
    vitolaName: row.vitola_name,
    sim: Number(row.sim),
  };
}

// --------------------------------------------------------------------------
// The choice — pure, over the scoped set.
// --------------------------------------------------------------------------

// Within one brand, a name similarity this high is a link. Unchanged from the
// crawler's long-standing floor so the scope restriction is the only variable
// this wave changes; the guards below, not the number, are what stop the
// false positives the floor is known to admit.
export const SCOPED_MATCH_THRESHOLD = 0.55;

export type LeafChoice =
  // Exactly one leaf. Link it.
  | { kind: "one"; candidate: LeafCandidate; note: string }
  // The brand anchored and more than one of its leaves fits. Triage: minting
  // here would be the collapse-bucket failure running in reverse.
  | { kind: "many"; candidates: LeafCandidate[]; note: string }
  // The brand anchored and none of its leaves fits. In seed mode this is what
  // licenses minting a STRUCTURED row — we know the marca, we looked under it,
  // and this cigar is genuinely not there yet.
  | { kind: "none"; note: string }
  // A retailer assortment. Its own arm rather than a `many` with an empty list,
  // because the two are different facts and the type should not blur them: an
  // `ambiguous` listing is about SEVERAL leaves and a sampler is about NONE of
  // them — "a mixed box is not one catalog cigar". Returning `many` with no
  // candidates promised a curator a choice and handed them nothing, and it
  // inflated the ambiguity counter whose whole job is to point at collapse
  // buckets that need splitting.
  | { kind: "sampler"; note: string };

function structuralMatches(parse: ListingParse, candidates: LeafCandidate[]): LeafCandidate[] | null {
  // Structure beats strings whenever both sides have it. A shared `blend_id` is
  // not evidence that two rows are the same product — it is the definition, so
  // no string heuristic is consulted at all once it holds.
  if (parse.blendId != null) {
    const byBlend = candidates.filter((c) => c.blendId === parse.blendId);
    if (byBlend.length > 0) return byBlend;
  }
  if (parse.lineId != null) {
    const byLine = candidates.filter((c) => c.lineId === parse.lineId && c.blendId == null);
    if (byLine.length > 0) return byLine;
  }
  return null;
}

// Pick the leaf, or refuse. Pure: the scope query already did the only reading
// this needs, so every rule below is testable against literal candidate rows.
export function chooseLeaf(parse: ListingParse, candidates: LeafCandidate[]): LeafChoice {
  // THE SAMPLER TEST COMES FIRST, and the order is load-bearing: `none` is the
  // arm that licenses seed mode to MINT, so checking an empty candidate set
  // before checking the sampler would mint a catalog row called "Sampler" for
  // every assortment of a marca whose leaves are not in the catalog yet — which
  // is the newest brand in every crawl. A retailer assortment names no single
  // product (the industry vocabulary is explicit: "a mixed box is not one catalog
  // cigar"). The outcome a human sees is the same as an ambiguity — triage,
  // nothing minted — but the fact is different, so it gets its own arm.
  if (parse.sampler) {
    return { kind: "sampler", note: "Sampler listing — spans blends, so it names no single leaf." };
  }

  if (candidates.length === 0) return { kind: "none", note: "No leaf exists under this brand yet." };

  const structural = structuralMatches(parse, candidates);
  if (structural) {
    const narrowed =
      parse.vitolaName != null
        ? structural.filter((c) => vitolaAgrees(parse.vitolaName, c.vitolaName))
        : structural;
    const pool = narrowed.length > 0 ? narrowed : structural;

    // A stated vitola that agrees EXACTLY beats siblings whose vitola is unknown:
    // an unknown vitola is not a match, it is an absence, and preferring it would
    // re-create the collapse buckets one blend at a time.
    const exactVitola =
      parse.vitolaName != null ? pool.filter((c) => c.vitolaName != null && vitolaAgrees(parse.vitolaName, c.vitolaName)) : [];
    const finalists = exactVitola.length > 0 ? exactVitola : pool;

    if (finalists.length === 1) {
      return { kind: "one", candidate: finalists[0]!, note: "Resolved structurally within the anchored brand." };
    }
    return {
      kind: "many",
      candidates: finalists,
      note: `${finalists.length} leaves under this brand share the parsed structure.`,
    };
  }

  // FREEFORM FALLBACK — and the only place the retiring string heuristics still
  // run (see name-heuristics.ts). Reached when the catalog has no structure to
  // compare against, which today is almost every row and after the Wave 3
  // backfill will be none.
  //
  // BOTH SIDES ARE STRIPPED BEFORE ANY HEURISTIC READS THEM. `parse.cleanedName`
  // has been through `stripPackaging` and a candidate's `canonical_name` had not,
  // so the comparison was asymmetric and THE EXACT ROW DISQUALIFIED ITSELF: the
  // listing `Punch Bolos Tin` cleans to `Punch Bolos` and then failed
  // `packagingCompatible` against the catalog row `Punch Bolos Tin` on a token
  // only one side was allowed to keep. 70 of the 94 anchored losses measured on
  // prod were this one bug, and every one of them was a mint of a row that
  // already existed — v1's flat namespace, rebuilt by v2's own scope query.
  const cleanedCandidates = candidates.map((c) => ({ candidate: c, name: stripPackaging(c.canonicalName).cleaned }));

  const viable = cleanedCandidates.filter(
    ({ candidate: c, name }) =>
      c.sim >= SCOPED_MATCH_THRESHOLD &&
      numbersCompatible(parse.cleanedName, name) &&
      packagingCompatible(parse.cleanedName, name) &&
      variantRelation(parse.cleanedName, name) !== "different" &&
      vitolaAgrees(parse.vitolaName, c.vitolaName),
  );

  if (viable.length === 0) {
    return { kind: "none", note: "No leaf under this brand survived the freeform comparison." };
  }

  // A stated wrapper that AGREES beats a row that states none, on the same
  // reasoning the structural arm applies to vitola: an unstated wrapper is an
  // absence, not a match, and preferring it re-creates the collapse buckets one
  // blend at a time.
  const agreed = viable.filter(({ name }) => variantRelation(parse.cleanedName, name) === "same");
  const pool = agreed.length > 0 ? agreed : viable;

  // Ranked here rather than trusted from the query: the scope query orders by
  // STRUCTURAL agreement first so the right rows are inside the window, which is
  // the correct order for choosing and the wrong one for a similarity tie-break.
  pool.sort((a, b) => b.candidate.sim - a.candidate.sim);
  const best = pool[0]!;
  // A near-tie is a real ambiguity, not a ranking problem. Two rows of one brand
  // scoring within a hair of each other is the collapse-bucket signature, and
  // picking the higher one is how 42% of auto-matches came to disagree with the
  // vendor's own slug.
  const tied = pool.filter((c) => Math.abs(c.candidate.sim - best.candidate.sim) < 0.02);
  if (tied.length > 1) {
    return {
      kind: "many",
      candidates: tied.map((t) => t.candidate),
      note: "Two or more leaves of this brand score indistinguishably.",
    };
  }

  // The listing names a wrapper and the only surviving row names none. That is
  // not a link and it is not a miss — it is the collapse bucket itself: one row
  // standing for both wrappers, which a listing has just told us apart. Triage
  // with the parse attached, where splitting it is the curator's call. Safe to
  // refuse now in a way it was not before, because a refusal here ANNOTATES an
  // existing link rather than breaking one (the positive-evidence rule).
  if (variantRelation(parse.cleanedName, best.name) === "unstated") {
    return {
      kind: "many",
      candidates: [best.candidate],
      note: "This listing names a wrapper variant and the only matching leaf names none — the leaf likely covers both.",
    };
  }

  return {
    kind: "one",
    candidate: best.candidate,
    note: `Freeform name match within the brand (sim ${best.candidate.sim.toFixed(2)}).`,
  };
}

// --------------------------------------------------------------------------
// Described-cigar taxonomy — the MCP write path's share of the same machinery.
// --------------------------------------------------------------------------

export interface DescribedTaxonomy {
  brandId: string | null;
  lineId: string | null;
  blendId: string | null;
}

// Resolve the structural parts of a cigar described in words (`add_cigar`,
// `save_smoke`, `record_purchase`). Each level is resolved from its OWN stated
// field rather than from the free-text name, because a described cigar already
// separates them — that is what makes this path cheaper and more certain than
// the crawler's, and why it never falls back to parsing a title.
//
// Unknown stays NULL at every level. A brand spelling no registry answers to
// leaves `brandId` null and the cigar hangs unlinked, which is a Wave 3 worklist
// item; minting a brand here would put registry creation inside an unaudited
// write path, which ADR-012 puts in curation.
export async function resolveDescribedTaxonomy(
  db: Queryer,
  described: { brand?: string | null; line?: string | null; blend?: string | null },
): Promise<DescribedTaxonomy> {
  const result: DescribedTaxonomy = { brandId: null, lineId: null, blendId: null };

  const brandKey = fold(described.brand ?? "");
  if (brandKey === "") return result;

  const brandRows = await probeBrands(db, [brandKey]);
  // Exactly one brand may own a key — the 0026 collision pass guarantees it, and
  // if that ever stops being true the honest answer is no link rather than a
  // coin flip.
  if (brandRows.length !== 1) return result;
  result.brandId = brandRows[0]!.id;

  const lineKey = fold(described.line ?? "");
  if (lineKey === "") return result;
  const lineRows = await probeLines(db, result.brandId, [lineKey]);
  if (lineRows.length !== 1) return result;
  result.lineId = lineRows[0]!.id;

  const blendKey = fold(described.blend ?? "");
  if (blendKey === "") return result;
  const blendRows = await probeBlends(db, [result.lineId], [blendKey]);
  if (blendRows.length !== 1) return result;
  result.blendId = blendRows[0]!.id;

  return result;
}

// `cigars.brand_id` is a PROJECTION of the free-text `brand`, derived by ONE
// rule wherever that column is written: migration 0026's backfill minted the
// links this way, the curator fact edit re-derives them this way, and the
// conversational gap-fill does too (ADR-012). A path that wrote `brand` without
// recomputing the link would leave the row pointing at the brand it used to
// claim, and the registry would quietly disagree with the column it was built
// from.
//
// IT LIVES HERE BECAUSE IT MUST HAVE EXACTLY ONE DEFINITION. Two copies of a
// derivation rule that must agree is the same hazard `fold()` was moved into
// @cj/domain to end — the copies do not fail loudly when they drift, they just
// start linking different rows to different brands.
//
// A spelling no brand answers to yields null rather than a stale link: an
// unlinked cigar is a Wave 3 worklist item, a wrongly linked one is a silent
// error. Registries are never minted here — that is curation with an audit
// trail, not a side effect of a write.
// ONE RULE, TWO SPELLINGS OF IT. Since mint-time slugs began folding accents,
// a brand row wears either the folded key (minted now) or the `brandSlug()`
// transcription (minted before, or by migration 0026). Probing one flavor would
// leave every cigar whose `brand` text is accented unlinked from the marca that
// was just minted for it — silently, since an unmatched spelling yields null by
// design. `registrySlugCandidates` is the single definition of both spellings;
// preferring the folded one keeps the result deterministic if both rows exist.
export async function deriveBrandId(db: Queryer, brand: string | null): Promise<string | null> {
  const candidates = registrySlugCandidates(brand ?? "");
  if (candidates.length === 0) return null;
  const rows = await db
    .select({ id: brands.id, slug: brands.slug })
    .from(brands)
    .where(inArray(brands.slug, candidates));
  for (const slug of candidates) {
    const hit = rows.find((row) => row.slug === slug);
    if (hit) return hit.id;
  }
  return null;
}

// A registry row's own display name, for name recomposition. Loaded together
// because a `composed` name needs every level it has at once.
export async function loadNamePartsForCigar(
  db: Queryer,
  ancestry: CigarAncestry,
): Promise<{ line: string | null; blend: string | null }> {
  const parts: { line: string | null; blend: string | null } = { line: null, blend: null };
  // Same rule as `loadAncestryContext` above: a malformed id names no row, which
  // is the null a miss already yields (./uuid.ts).
  if (ancestry.lineId != null) {
    const rows = isUuid(ancestry.lineId)
      ? await db.select({ name: lines.name }).from(lines).where(eq(lines.id, ancestry.lineId)).limit(1)
      : [];
    parts.line = rows[0]?.name ?? null;
  }
  if (ancestry.blendId != null) {
    const rows = isUuid(ancestry.blendId)
      ? await db.select({ name: blends.name }).from(blends).where(eq(blends.id, ancestry.blendId)).limit(1)
      : [];
    parts.blend = rows[0]?.name ?? null;
  }
  return parts;
}
