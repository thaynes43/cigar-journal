import { sql, eq, and, isNull } from "drizzle-orm";
import { cigars } from "@cj/db";
import type { Tx } from "./deps.js";
import type { CigarRef, DescribedCigarInput, SpecializedFrom, Verification } from "./types.js";
import {
  CigarNotFoundError,
  CigarAmbiguousError,
  ValidationError,
  type CigarCandidate,
} from "./errors.js";
import { assertCigarAncestry } from "./cigar-ancestry.js";
import { loadAncestryContext, resolveDescribedTaxonomy } from "./taxonomy-resolve.js";
import { fold, foldTokens } from "./taxonomy-keys.js";
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
  journalLinkCompatible,
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
  // Set when the described cigar stated a vitola against a family row (ADR-017):
  // the resolved entry is that vitola's own sibling leaf, and this names the
  // family it came from. Absent on every other path.
  specializedFrom?: SpecializedFrom;
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
  // The free-text line and the three registry ids ride along for ADR-017: a
  // sibling minted off a family row copies its structure verbatim, so the row
  // that decided the link is also the row the mint reads its parents from.
  line: string | null;
  brand_id: string | null;
  line_id: string | null;
  blend_id: string | null;
  type: "NC" | "CC" | null;
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
// candidate that makes the SAME identity claims as the name, errors
// `cigar_ambiguous` when it can't decide, and otherwise creates an `unverified`
// entry — all inside the caller's transaction. With `options.confirmedDistinct`
// (the add_cigar / record_purchase escape hatch) strong-link and ambiguity are
// skipped and it creates, except a case-insensitive exact-name match still links.
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
    SELECT id, canonical_name, brand, line, brand_id, line_id, blend_id, type,
           vitola_name, verification, similarity(canonical_name, ${name}) AS sim
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
    // A candidate links only if it makes the SAME identity claims as the name —
    // no residue on either side, no stated wrapper disagreement
    // (`journalLinkCompatible`, which is the journal's own rule and stricter than
    // the `strongLinkCompatible` the curation queue and the crawler read).
    const nearby = candidates.filter((c) => Number(c.sim) >= STRONG_MATCH);
    const strong = nearby.filter((c) => journalLinkCompatible(name, c.canonical_name));

    if (strong.length === 1) {
      const match = strong[0]!;
      // SPECIALIZATION (ADR-017). A candidate whose `vitola_name` is NULL is a
      // FAMILY ROW — the vitola was never recorded — and linking a stated vitola
      // onto it would retroactively declare every smoke and lot already there
      // that vitola. Nor is the row retyped: the stated vitola gets its own
      // sibling leaf under the family's structure instead. Keyed on the FIELD and
      // not on a word in the name, so a size word in `canonicalName` alone stays
      // vocabulary and links here as it always did (flow 002).
      const vitola = described.vitola?.name?.trim();
      if (vitola != null && vitola !== "" && match.vitola_name == null) {
        return await specialize(tx, match, described, name, vitola);
      }
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

    // NEITHER LINK NOR CREATE — ASK. Every candidate this close (≥ STRONG_MATCH)
    // that survived the number and packaging rules but did not link above is a
    // word away from the name, and that word decides whether this is the same
    // cigar under a fuller name or a product the catalog has never seen. Neither
    // outcome may be taken silently: creating mints a second row for a cigar the
    // catalog already holds, and linking hangs smoke history, ratings, inventory,
    // prices and enrichment on the wrong product. Both go to the user, which is
    // exactly what `confirmedDistinct` answers (the client shows these
    // candidates, asks, and re-issues with the flag only if none of them is it).
    //
    // THE RESIDUE NEED NOT BE MUTUAL, since 2026-09-01. It was — a one-sided
    // residue linked, on the reasoning that the shorter name said strictly less —
    // until production proved what that costs: the catalog held `Atabey Ritos`, a
    // session called `add_cigar` for `Atabey Black Ritos` (a different blend), and
    // the residue `{black}` on the query side alone read as compatible, so the
    // Black silently became the Ritos. A stated-wrapper disagreement asks for the
    // same reason (`Padron 1964 Anniversary Maduro` against a lone `… Natural`).
    // The ask branch did not exist when the allowance was written; now that it
    // does, a question costs a round trip and a silent link costs data.
    //
    // A number or packaging rejection deliberately does NOT come here and still
    // creates. Those names make an explicit, structured claim of difference —
    // `No. 9` is not `T52`, a Tubos Pack is not the stick — so there is nothing
    // for a user to adjudicate. A word residue is the weaker signal, and only the
    // weaker signal needs the question.
    const siblings = nearby.filter(
      (c) =>
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

// ---- specialization (ADR-017) ----------------------------------------------

// Does the described name already NAME the vitola? Compared on FOLDED TOKENS,
// the key rule the registries and the identity guards match on, never a
// substring test: `Padrón 1926 Serie No. 2 Natural` names `No. 2`, a bare
// `Padron 1926 Natural` does not, and `Coronado` does not name `Corona`.
function namesVitola(name: string, vitola: string): boolean {
  const needle = foldTokens(vitola);
  if (needle.length === 0) return false;
  const tokens = foldTokens(name);
  for (let start = 0; start + needle.length <= tokens.length; start++) {
    if (needle.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

// The sibling's name: what the user called it when that already carries the
// vitola, else the family's name with the vitola after it. Composing
// unconditionally would yield `Padrón 1926 Serie No. 2 Natural No. 2`; taking the
// described name unconditionally would drop the family's own spelling from a bare
// `Padron 1926 Natural` + `Belicoso`.
function siblingName(describedName: string, familyName: string, vitola: string): string {
  return namesVitola(describedName, vitola) ? describedName : `${familyName} ${vitola}`;
}

// MINT (OR FIND) THE VITOLA'S OWN LEAF UNDER A FAMILY ROW — ADR-017's whole
// mechanism, and the one path in this module that writes a row it did not derive
// from the description alone.
//
// GET-OR-CREATE ON PARTS **OR** FOLDED NAME, the idiom `splitCigar` mints leaves
// with (taxonomy-curation.ts) and for the same reason: matching parts alone means
// the same product however it is spelled, a matching folded name alone catches
// the leaf minted freeform before anyone structured it, and the catalog is
// mid-migration and carries both kinds. Scoped to the family's own marca, which
// is exact rather than an approximation — every leaf this can mint carries the
// family's `brand_id` verbatim, so a duplicate of one necessarily carries it too.
async function specialize(
  tx: Tx,
  family: CandidateRow,
  described: DescribedCigarInput,
  describedName: string,
  vitola: string,
): Promise<ResolvedCigar> {
  const canonicalName = siblingName(describedName, family.canonical_name, vitola);

  // THE FAMILY ROW IS ALREADY THAT VITOLA'S ROW, in one case: its name carries
  // the size its field never recorded (`… Anniversary Maduro Torpedo`, vitola
  // NULL, user says "Torpedo"). The sibling would compose to the family's own
  // name, and minting a second row under it is never right — link it, and report
  // no specialization, because none happened.
  if (fold(canonicalName) === fold(family.canonical_name)) {
    return {
      cigarId: family.id,
      canonicalName: family.canonical_name,
      verification: family.verification,
      created: false,
    };
  }

  const specializedFrom: SpecializedFrom = {
    cigarId: family.id,
    canonicalName: family.canonical_name,
  };
  const vitolaKey = fold(vitola);
  const nameKey = fold(canonicalName);
  const siblings = await tx
    .select({
      id: cigars.id,
      canonicalName: cigars.canonicalName,
      verification: cigars.verification,
      lineId: cigars.lineId,
      blendId: cigars.blendId,
      vitolaName: cigars.vitolaName,
    })
    .from(cigars)
    .where(
      and(
        eq(cigars.catalogStatus, "active"),
        family.brand_id == null ? isNull(cigars.brandId) : eq(cigars.brandId, family.brand_id),
      ),
    );
  const existing = siblings.find(
    (row) =>
      (row.lineId === family.line_id &&
        row.blendId === family.blend_id &&
        row.vitolaName != null &&
        fold(row.vitolaName) === vitolaKey) ||
      (nameKey !== "" && fold(row.canonicalName) === nameKey),
  );
  if (existing) {
    return {
      cigarId: existing.id,
      canonicalName: existing.canonicalName,
      verification: existing.verification,
      created: false,
      specializedFrom,
    };
  }

  const inserted = await tx
    .insert(cigars)
    .values({
      canonicalName,
      // Structure copied from the family VERBATIM. The sibling is the same blend
      // in a stated size, so its ancestry is the family's already-consistent
      // triple — re-deriving it from the description would be strictly less
      // information and could land the leaf under a different parent.
      brand: family.brand,
      line: family.line,
      brandId: family.brand_id,
      lineId: family.line_id,
      blendId: family.blend_id,
      // The family's type, and only when it has none does a stated NC/CC fill it
      // rather than being dropped.
      type: family.type ?? described.type ?? null,
      // What the description actually added: the vitola and its dimensions.
      vitolaName: vitola,
      lengthInches:
        described.vitola?.lengthInches != null ? String(described.vitola.lengthInches) : null,
      ringGauge: described.vitola?.ringGauge ?? null,
      edition: described.edition ?? null,
      // Freeform and unverified, like every other row a conversation mints; the
      // caller queues its enrichment on the same "only a create queues" rule.
      nameSource: "freeform",
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
    specializedFrom,
  };
}
