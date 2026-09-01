import { sql, eq } from "drizzle-orm";
import { cigars } from "@cj/db";
import type { Tx } from "./deps.js";
import type { CigarRef, Verification } from "./types.js";
import {
  CigarNotFoundError,
  CigarAmbiguousError,
  ValidationError,
  type CigarCandidate,
} from "./errors.js";
import { assertCigarAncestry } from "./cigar-ancestry.js";
import { loadAncestryContext, resolveDescribedTaxonomy } from "./taxonomy-resolve.js";
import { isUuid } from "./uuid.js";

// The string heuristics moved to name-heuristics.ts, which carries their
// retirement note (ADR-012: they die with the Wave 3 backfill). Re-exported here
// because the curation duplicate queue and the MCP surface import them from this
// module and the move is not their business.
export {
  numbersCompatible,
  packagingCompatible,
  variantCompatible,
  identityTokensCompatible,
  strongLinkCompatible,
} from "./name-heuristics.js";
import {
  numbersCompatible,
  packagingCompatible,
  identityTokensCompatible,
  strongLinkCompatible,
  rankByIdentity,
  CANDIDATE_POOL,
} from "./name-heuristics.js";

// Similarity at or above this counts as a strong catalog match — link rather
// than create. Tuned against pg_trgm on canonical names; the `%` prefilter
// (default 0.3) narrows candidates, this threshold decides linking.
const STRONG_MATCH = 0.6;

export interface ResolvedCigar {
  cigarId: string;
  canonicalName: string;
  verification: Verification;
  created: boolean;
}

export interface ResolveCigarOptions {
  // The confirmed-distinct escape hatch. Set ONLY after search_cigars showed
  // candidates and the user explicitly confirmed none is their cigar (never
  // preemptively): skip strong-link AND ambiguity entirely and create the
  // described entry — with ONE exception, a case-insensitive EXACT
  // canonical_name match still links (created:false), since minting a literal
  // duplicate is never right. Set by the two tools that have a user
  // confirmation to act on, add_cigar and record_purchase (2026-08-31); never by
  // save_smoke, whose described branch is the safety net for a client that
  // skipped the gap-fill prelude, not a path the user was asked about.
  confirmedDistinct?: boolean;
}

interface CandidateRow {
  id: string;
  canonical_name: string;
  brand: string | null;
  vitola_name: string | null;
  verification: Verification;
  sim: number;
}

// How many candidates a `cigar_ambiguous` error offers. The POOL is wide so the
// decision is made over the whole family (`CANDIDATE_POOL`); the LIST is a page
// the model reads out loud to a user, and fifty of those is not a question
// anybody can answer. Ten is what `search_cigars` caps its own page at, so the
// two surfaces offer the same size of list.
const MAX_CANDIDATES = 10;

// The candidate list a `cigar_ambiguous` error carries, ordered the way the
// client reads it out: best identity agreement first, trigram breaking ties.
// Ordering is the whole value of the list — with fourteen `Tatuaje Monster`
// siblings in the pool the raw score sorts them almost arbitrarily, so the
// sibling the user actually named could be offered last.
function rankedCandidates(name: string, rows: CandidateRow[]): CigarCandidate[] {
  return rankByIdentity(name, rows, (row) => ({
    name: row.canonical_name,
    sim: Number(row.sim),
  }))
    .slice(0, MAX_CANDIDATES)
    .map((row) => ({
      cigarId: row.id,
      canonicalName: row.canonical_name,
      brand: row.brand,
      vitola: row.vitola_name,
      verification: row.verification,
    }));
}

// Resolve a Smoke's cigar reference to a catalog id, upholding the catalog
// invariant (ADR-002): a resolved id links; `described` links on a single
// strong match, errors `cigar_ambiguous` when it can't decide, and otherwise
// creates an `unverified` entry — all inside the caller's transaction. With
// `options.confirmedDistinct` (the add_cigar / record_purchase escape hatch)
// strong-link and ambiguity are skipped and it creates, except a
// case-insensitive exact-name match still links.
export async function resolveCigar(
  tx: Tx,
  ref: CigarRef,
  options?: ResolveCigarOptions,
): Promise<ResolvedCigar> {
  // A malformed id is `cigar_not_found`, the same answer a well-formed id naming
  // no row gets below — this is the shared front door for save_smoke,
  // record_purchase and add_cigar, so it is where all three inherit that answer.
  // It runs first because this function is handed the CALLER's transaction: a
  // 22P02 at the comparison would abort that transaction rather than surface as
  // this function's own typed refusal (./uuid.ts). A described ref carries no id
  // and is left to the resolution path below.
  if ("cigarId" in ref && !isUuid(ref.cigarId)) throw new CigarNotFoundError();

  if ("cigarId" in ref) {
    const rows = await tx
      .select({
        id: cigars.id,
        canonicalName: cigars.canonicalName,
        verification: cigars.verification,
      })
      .from(cigars)
      .where(eq(cigars.id, ref.cigarId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new CigarNotFoundError();
    return {
      cigarId: row.id,
      canonicalName: row.canonicalName,
      verification: row.verification,
      created: false,
    };
  }

  const described = ref.described;
  const name = described.canonicalName?.trim();
  if (!name) {
    throw new ValidationError([{ path: "cigar.described.canonicalName", message: "Required." }]);
  }

  // THE SAME POOL `searchCigars` DRAWS, and for the same reason: every decision
  // below — the strong-link filter, the sibling scan, the ambiguity list the user
  // picks from — is made over the rows this query returned, so a family larger
  // than the pool decides on an arbitrary slice of itself. `LIMIT 10` against
  // fourteen live `Tatuaje Monster` siblings could not see four of them
  // (`CANDIDATE_POOL`, name-heuristics.ts).
  const result = await tx.execute(sql`
    SELECT id, canonical_name, brand, vitola_name, verification, similarity(canonical_name, ${name}) AS sim
    FROM cigars
    WHERE canonical_name % ${name}
    ORDER BY sim DESC
    LIMIT ${CANDIDATE_POOL}
  `);
  const candidates = result.rows as unknown as CandidateRow[];

  if (options?.confirmedDistinct) {
    // The user, shown search_cigars candidates, confirmed none is their cigar.
    // Skip strong-link and ambiguity and create — EXCEPT a literal (case-
    // insensitive) canonical_name match still links, since minting an exact
    // duplicate is never the intent even under an override.
    const exact = candidates.find((c) => c.canonical_name.toLowerCase() === name.toLowerCase());
    if (exact) {
      return {
        cigarId: exact.id,
        canonicalName: exact.canonical_name,
        verification: exact.verification,
        created: false,
      };
    }
  } else {
    const nearby = candidates.filter((c) => Number(c.sim) >= STRONG_MATCH);
    const strong = nearby.filter((c) => strongLinkCompatible(name, c.canonical_name));

    if (strong.length === 1) {
      const match = strong[0]!;
      return {
        cigarId: match.id,
        canonicalName: match.canonical_name,
        verification: match.verification,
        created: false,
      };
    }
    if (strong.length > 1) {
      throw new CigarAmbiguousError(name, rankedCandidates(name, strong));
    }

    // NEITHER LINK NOR CREATE — ASK. A candidate this close (≥ STRONG_MATCH) that
    // the identity guard alone rejected is the Face/Bride shape: one word apart,
    // and that word decides whether this is the same cigar under a fuller name or
    // a sibling the catalog has never seen. Creating silently is the mirror of
    // the bug this guard fixes — the catalog gains a second row for a cigar it
    // already holds — so both outcomes go to the user, which is exactly what
    // `confirmedDistinct` answers (the client shows these candidates, asks, and
    // re-issues with the flag only if the user says none of them is it).
    //
    // A number or packaging rejection deliberately does NOT come here and still
    // creates. Those names make an explicit, structured claim of difference —
    // `No. 9` is not `T52`, a Tubos Pack is not the stick — so there is nothing
    // for a user to adjudicate. A word residue is the weaker signal, and only the
    // weaker signal needs the question.
    const siblings = nearby.filter(
      (c) =>
        !identityTokensCompatible(name, c.canonical_name) &&
        numbersCompatible(name, c.canonical_name) &&
        packagingCompatible(name, c.canonical_name),
    );
    if (siblings.length > 0) {
      throw new CigarAmbiguousError(name, rankedCandidates(name, siblings));
    }
  }

  // STRUCTURED ON CREATION (ADR-012 Wave 2). Every path that creates a cigar now
  // resolves its registry ancestry, so a row minted from a conversation is
  // findable by the same alias probe the crawler anchors on instead of joining
  // the flat namespace and waiting for a backfill.
  //
  // Resolved from the DESCRIBED FIELDS, never from the name: a described cigar
  // already separates brand from line, and re-deriving them by parsing the string
  // the user just typed would be strictly less information. Unknown stays NULL —
  // a brand spelling no registry answers to leaves the row unlinked for Wave 3
  // curation rather than minting a registry entry from an unaudited write path.
  const taxonomy = await resolveDescribedTaxonomy(tx, { brand: described.brand, line: described.line });
  assertCigarAncestry(taxonomy, await loadAncestryContext(tx, taxonomy));

  const inserted = await tx
    .insert(cigars)
    .values({
      canonicalName: name,
      brand: described.brand ?? null,
      line: described.line ?? null,
      brandId: taxonomy.brandId,
      lineId: taxonomy.lineId,
      blendId: taxonomy.blendId,
      edition: described.edition ?? null,
      vitolaName: described.vitola?.name ?? null,
      lengthInches:
        described.vitola?.lengthInches != null ? String(described.vitola.lengthInches) : null,
      ringGauge: described.vitola?.ringGauge ?? null,
      type: described.type ?? null,
      manufacturer: described.manufacturer ?? null,
      factory: described.factory ?? null,
      productionCountry: described.productionCountry ?? null,
      tobacco: described.tobacco ?? null,
      blendNotes: described.blendNotes ?? null,
      releaseYear: described.releaseYear ?? null,
      verification: "unverified",
    })
    .returning({
      id: cigars.id,
      canonicalName: cigars.canonicalName,
      verification: cigars.verification,
    });
  const created = inserted[0]!;
  return {
    cigarId: created.id,
    canonicalName: created.canonicalName,
    verification: created.verification,
    created: true,
  };
}
