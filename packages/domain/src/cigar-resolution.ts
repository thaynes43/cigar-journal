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

  // THE NAME MINUS ITS VITOLA IS THE FAMILY CLAIM (ADR-017). When the caller
  // states `vitola.name`, striking that vitola's own words leaves what the name
  // claims about WHICH FAMILY this is. Without it a numbered vitola never reaches
  // its family: `Padron 1926 Natural No. 2` carries the model token `2` that
  // `Padron 1926 Natural` lacks, so `numbersCompatible` disqualifies the family
  // outright and the resolver mints a row sharing nothing with it.
  //
  // A SECOND KEY, NOT A REPLACEMENT — it widens the candidate pool below and
  // answers the strong-match filter only when the full name answered nothing (see
  // there). What it LEAVES is judged by the ordinary rules, unchanged: a leftover
  // identity word still asks (`Padrón 1926 Serie No. 2 Natural` minus `No. 2`
  // leaves `Serie`, which the family never said, so `cigar_ambiguous`). And the
  // sibling's own name is composed from the FULL described name, so nothing the
  // user typed is lost by having been struck here.
  //
  // Not applied under `confirmedDistinct`: that path makes none of these
  // comparisons and wants only its exact-duplicate guard, which is on the name
  // the user actually gave.
  const statedVitola = described.vitola?.name?.trim() || null;
  const claim =
    statedVitola != null && !options?.confirmedDistinct ? strikeVitola(name, statedVitola) : name;

  // THE SAME POOL `searchCigars` DRAWS, and for the same reason: every decision
  // below — the strong-link filter, the sibling scan, the ambiguity list the user
  // picks from — is made over the rows this query returned, so a family larger
  // than the pool decides on an arbitrary slice of itself. `LIMIT 10` against
  // fourteen live `Tatuaje Monster` siblings could not see four of them
  // (`CANDIDATE_POOL`, name-heuristics.ts).
  //
  // BOTH KEYS PROBE IT, scored on whichever fits better. The pool must not
  // NARROW when a vitola is stated: drawn on the claim alone, `Cohiba Robusto`
  // + `Robusto` probes for `Cohiba`, scores the catalogued `Cohiba Robusto` at
  // 0.43 — under the strong-match floor — and mints a duplicate of a row the
  // catalog already holds. The claim widens the search; it never shrinks it.
  const result = await tx.execute(sql`
    SELECT id, canonical_name, brand, line, brand_id, line_id, blend_id, type,
           vitola_name, verification,
           GREATEST(similarity(canonical_name, ${name}), similarity(canonical_name, ${claim})) AS sim
    FROM cigars
    WHERE canonical_name % ${name} OR canonical_name % ${claim}
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
    //
    // THE NAME IS ASKED FIRST AND THE CLAIM ONLY WHEN IT ANSWERS NOTHING
    // (ADR-017). The strike exists to REACH a family the full name cannot; it
    // must never take a decision the full name already makes, because most
    // vitolas are not in the size vocabulary and the claim reads their word as an
    // identity residue on the ROW: `Trinidad Trinidad Reyes` + `Reyes` claims
    // `Trinidad Trinidad`, which no longer accounts for the `Reyes` its own
    // catalog row says (importer ledger fixture, row 5). Falling back only from
    // ZERO strong candidates also keeps a genuine ambiguity a question: the
    // broader key must not resolve what the narrower one could not decide.
    const nearby = candidates.filter((c) => Number(c.sim) >= STRONG_MATCH);
    const named = nearby.filter((c) => journalLinkCompatible(name, c.canonical_name));
    const strong =
      named.length === 0 && claim !== name
        ? nearby.filter((c) => journalLinkCompatible(claim, c.canonical_name))
        : named;

    if (strong.length === 1) {
      const match = strong[0]!;
      // SPECIALIZATION (ADR-017). A candidate whose `vitola_name` is NULL is a
      // FAMILY ROW — the vitola was never recorded — and linking a stated vitola
      // onto it would retroactively declare every smoke and lot already there
      // that vitola. Nor is the row retyped: the stated vitola gets its own
      // sibling leaf under the family's structure instead. Keyed on the FIELD and
      // not on a word in the name, so a size word in `canonicalName` alone stays
      // vocabulary and links here as it always did (flow 002). The sibling is
      // named from the FULL described name, not the claim — the strike is a
      // comparison key, never a rename.
      if (statedVitola != null && match.vitola_name == null) {
        return await specialize(tx, match, described, name, statedVitola);
      }
      return {
        cigarId: match.id,
        canonicalName: match.canonical_name,
        verification: match.verification,
        created: false,
      };
    }
    if (strong.length > 1) {
      throw new CigarAmbiguousError(name, rankedCandidates(claim, strong));
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
        numbersCompatible(claim, c.canonical_name) &&
        packagingCompatible(claim, c.canonical_name),
    );
    if (siblings.length > 0) {
      throw new CigarAmbiguousError(name, rankedCandidates(claim, siblings));
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

// A name as its words, each kept verbatim beside its matching key. Split on
// letters and numbers so an accented word stays ONE word — `/[a-z0-9]+/` would
// cut `Padrón` into `Padr` and `n`, while `fold` reads it as `padron`.
interface NameWord {
  text: string;
  key: string;
}

function nameWords(name: string): NameWord[] {
  return [...name.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    text: match[0],
    key: fold(match[0]),
  }));
}

// Where the vitola's own words sit in a name, as an index into its words, or -1.
// Compared on FOLDED KEYS, the rule the registries and the identity guards match
// on, and never a substring test: `Padrón 1926 Serie No. 2 Natural` names
// `No. 2`, a bare `Padron 1926 Natural` does not, and `Coronado` does not name
// `Corona`.
function vitolaAt(words: readonly NameWord[], needle: readonly string[]): number {
  if (needle.length === 0) return -1;
  for (let start = 0; start + needle.length <= words.length; start++) {
    if (needle.every((token, offset) => words[start + offset]!.key === token)) return start;
  }
  return -1;
}

function namesVitola(name: string, vitola: string): boolean {
  return vitolaAt(nameWords(name), foldTokens(vitola)) >= 0;
}

// THE FAMILY CLAIM: the name with the stated vitola's own words removed
// (ADR-017). A comparison key and nothing else — no row is ever named or renamed
// from it. A name that is ONLY its vitola makes no family claim at all, so it is
// returned whole rather than as the empty string.
function strikeVitola(name: string, vitola: string): string {
  const needle = foldTokens(vitola);
  const words = nameWords(name);
  const at = vitolaAt(words, needle);
  if (at < 0) return name;
  const kept = [...words.slice(0, at), ...words.slice(at + needle.length)];
  return kept.length === 0 ? name : kept.map((word) => word.text).join(" ");
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
  // PARTS MATCH ONLY UNDER A BRAND — ADR-012's rule, which `split_cigar` states
  // as "a null on either side is refused rather than treated as a wildcard: an
  // unbranded row is not a sibling of everything". Without a `brand_id` the parts
  // degenerate to `{null, null, <vitola>}`, which EVERY unbranded row carrying
  // that size word satisfies, so an unbranded `Foo` + `Robusto` would re-point
  // onto an unrelated `Bar Robusto`. An unbranded family therefore links only on
  // the folded name, and mints otherwise.
  //
  // Under a brand, `null === null` on `lineId`/`blendId` is the INTENDED reading:
  // a family with no line and a leaf with no line sit at the same place in that
  // marca's structure, which is exactly what makes them siblings.
  const branded = family.brand_id != null;
  const existing = siblings.find(
    (row) =>
      (branded &&
        row.lineId === family.line_id &&
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
