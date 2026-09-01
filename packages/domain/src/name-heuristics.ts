import { fold, foldTokens } from "./taxonomy-keys.js";
import { PACKAGING_TOKENS, VITOLA_TOKENS } from "./catalog-parse.js";

// ==========================================================================
// THESE FUNCTIONS ARE SCHEDULED FOR DELETION. (ADR-012, issue #196 Wave 3/5.)
//
// They are string heuristics that guess at product identity by comparing two
// free-text names, and they exist only because the catalog has no structure to
// compare instead. Matching v2 no longer calls them when BOTH sides of a
// comparison are structurally resolved — a shared `blend_id` settles the
// question that `numbersCompatible` was approximating, and a shared vitola
// settles the one `packagingCompatible` was approximating, exactly and without
// tokenizing anything.
//
// They survive for one case: a comparison where at least one side is still an
// unstructured freeform row. That is most of the catalog today (0026 minted no
// lines and no blends, so every leaf's `blend_id` is NULL) and none of it after
// the Wave 3 backfill. When the last leaf carries a blend, delete this file and
// the call sites that guard on `unstructured`.
//
// Until then they are load-bearing, because the failure they prevent is the one
// ADR-012 was written about: trigram similarity RANKS DISTINCT PRODUCTS ABOVE
// TRUE SIBLINGS. The two highest-scoring "duplicate" pairs in the whole catalog
// are `Davidoff Signature` vs `Signature 2000` and `Liga Privada No. 9` vs
// `T52` — different cigars — while sibling vitolas of one blend score below 0.5.
// ==========================================================================

function tokensOf(name: string): string[] {
  return name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// Model tokens are name tokens carrying a digit — product numbers (`1926`,
// `1964`) or alphanumeric model codes (`T52`). Trigram similarity is blind to
// these: `1964 Maduro` and `1926 Maduro` score 0.6 on shared letters alone.
function modelTokens(name: string): Set<string> {
  return new Set(tokensOf(name).filter((token) => /[0-9]/.test(token)));
}

function packagingTokens(name: string): Set<string> {
  return new Set(tokensOf(name).filter((token) => PACKAGING_TOKENS.has(token)));
}

// Wrapper and shade variants that a brand SELLS AS SEPARATE PRODUCTS. ADR-012 is
// explicit that these are distinct blends — "wrapper variants marketed as
// separate products (Padron Maduro/Natural) are distinct blends, because that is
// how they are sold" — so a name carrying one and a name carrying another are
// never the same leaf, however close their trigram score.
//
// This is the guard the old heuristics lacked, and its absence is visible in
// production: `Padron 1964 Anniversary Natural` is one row holding twelve vendor
// listings that span both wrappers. `Maduro` and `Natural` share no digits and no
// packaging token, so neither existing guard could tell them apart.
const VARIANT_TOKENS = new Set([
  "maduro",
  "natural",
  "claro",
  "colorado",
  "oscuro",
  "connecticut",
  "broadleaf",
  "habano",
  "corojo",
  "criollo",
  "cameroon",
  "sumatra",
  "candela",
  "shade",
  "sungrown",
  "rosado",
]);

// A wrapper name is written three ways by three vendors — `Sun Grown`,
// `sun-grown`, `sungrown` — and a token scan sees the third only. Reading
// ADJACENT PAIRS as well as single tokens unifies them onto one key, because the
// separator is the whole difference and `tokensOf` has already dropped it.
// Without this the guard was blind exactly where it was needed: two rows of one
// brand differing only in wrapper, spelled differently by two shops, read as
// making no variant claim at all.
function variantTokens(name: string): Set<string> {
  const tokens = tokensOf(name);
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const single = tokens[i]!;
    if (VARIANT_TOKENS.has(single)) found.add(single);
    if (i + 1 < tokens.length) {
      const joined = single + tokens[i + 1]!;
      if (VARIANT_TOKENS.has(joined)) found.add(joined);
    }
  }
  return found;
}

function hasExtra(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (!b.has(token)) return true;
  return false;
}

function mutuallyContained(a: Set<string>, b: Set<string>): boolean {
  return !(hasExtra(a, b) || hasExtra(b, a));
}

// Incompatible when EITHER side carries a digit-bearing token the other lacks —
// mutually-distinct numbers (`No. 9` vs `T52`) AND one-sided extras
// (`Signature 2000` vs `Signature`) are different products by definition.
export function numbersCompatible(query: string, candidate: string): boolean {
  return mutuallyContained(modelTokens(query), modelTokens(candidate));
}

// Incompatible when EITHER side carries a packaging token the other lacks — a
// Tubos Pack / tin / sampler is a packaging variant, not the product.
export function packagingCompatible(query: string, candidate: string): boolean {
  return mutuallyContained(packagingTokens(query), packagingTokens(candidate));
}

// THREE ANSWERS, NOT TWO, because the middle one is a real and different fact.
//
//   same      — both names state a wrapper and they agree.
//   different — both state one and they disagree. Never the same leaf, however
//               close the trigram score: ADR-012 is explicit that "wrapper
//               variants marketed as separate products (Padron Maduro/Natural)
//               are distinct blends, because that is how they are sold".
//   unstated  — one side states a wrapper and the other says nothing. NOT a
//               disagreement and NOT an agreement: it is the collapse-bucket
//               signature. `Padron 1964 Anniversary Natural` is one prod row
//               holding twelve listings spanning BOTH wrappers, so a listing
//               naming a wrapper against a row naming none is a question about
//               which half of that row it belongs to — a question for a curator.
export type VariantRelation = "same" | "different" | "unstated";

export function variantRelation(query: string, candidate: string): VariantRelation {
  const q = variantTokens(query);
  const c = variantTokens(candidate);
  if (q.size === 0 && c.size === 0) return "same";
  if (q.size === 0 || c.size === 0) return "unstated";
  return mutuallyContained(q, c) ? "same" : "different";
}

// Incompatible when the two names name different wrapper variants. A name that
// states no variant at all is compatible with anything: silence is not a claim,
// and refusing to link `Padrón 1964 Anniversary` to its Maduro row would invent a
// distinction the vendor did not make.
export function variantCompatible(query: string, candidate: string): boolean {
  return variantRelation(query, candidate) !== "different";
}

// ==========================================================================
// IDENTITY TOKENS — `numbersCompatible`, generalized from digits to words.
//
// `numbersCompatible` exists because trigram similarity is blind to the token
// that carries the product's identity: `1964 Maduro` and `1926 Maduro` score 0.6
// on shared letters alone. Nothing about that argument is specific to DIGITS.
// `Tatuaje Monster Series The Face` and `Tatuaje Monster Series The Bride` score
// far above the strong-link floor on twenty-eight shared characters, differ on
// the one word that names WHICH CIGAR IT IS, and — until this guard — silently
// linked: `add_cigar` for The Face returned `created: false` against The Bride's
// row. Two different cigars, one id, no error, in production.
//
// The rule reads a name as identity plus vocabulary. Fold both names, then strike
// from each side every token that is:
//
//   shared     — both names say it, so it cannot distinguish them.
//   a size     — `Robusto`, `Double Corona`. Vitolas are compared by
//                `vitolaAgrees`, and a size word is not the product's name.
//   a container — `Tubos`, `Sampler`. Already judged by `packagingCompatible`.
//   a wrapper  — `Maduro`, `Sun Grown`. Already judged by `variantRelation`,
//                which has three answers where this rule would force two.
//
// What survives on each side is that name's IDENTITY RESIDUE: what this name
// claims about which product it is that the other name does not.
//
// ONE-SIDED RESIDUE STAYS COMPATIBLE, AND THAT ASYMMETRY IS LOAD-BEARING. An
// empty residue on one side means that name said strictly less, not something
// else — `Liga Privada No. 9` against `Liga Privada No. 9 Flying Pig` is the
// blend-level row meeting a vitola-level one, which is the shape of most of this
// catalog (0026 minted no blends, so specificity lives in free text) and the
// commonest thing a user says out loud. Refusing that link would mint a second
// row for every cigar named casually. Only a MUTUAL residue is a disagreement:
// both names reach past their common ground and reach somewhere different.
// ==========================================================================

// Trailing-`s` fold, for comparison only. `Monster`/`Monsters` and
// `Serie`/`Series` are one word two vendors spell differently; `Face` and
// `Bride` are not, and no stemming makes them one. Held to four characters so a
// short identity word is never truncated into a different one.
function singularKey(token: string): string {
  return token.length >= 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function isVocabularyToken(token: string): boolean {
  return VITOLA_TOKENS.has(token) || PACKAGING_TOKENS.has(token) || VARIANT_TOKENS.has(token);
}

function residueOf(tokens: string[], shared: ReadonlySet<string>): Set<string> {
  const residue = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const key = singularKey(token);
    if (shared.has(key)) continue;
    if (isVocabularyToken(token) || isVocabularyToken(key)) continue;
    // A two-word wrapper (`Sun Grown`) is ONE variant token to `variantTokens`,
    // which joins the pair. The residue has to drop both halves or half a
    // wrapper name reads as identity.
    const next = tokens[i + 1];
    const prev = tokens[i - 1];
    if (next !== undefined && VARIANT_TOKENS.has(token + next)) continue;
    if (prev !== undefined && VARIANT_TOKENS.has(prev + token)) continue;
    residue.add(key);
  }
  return residue;
}

export interface IdentityResidues {
  query: Set<string>;
  candidate: Set<string>;
}

// The two residues, exported because ranking wants them as well as the guard:
// among siblings that share a brand and a line, the residue IS the differentiator
// the whole-string trigram score drowns.
export function identityResidues(query: string, candidate: string): IdentityResidues {
  const queryTokens = foldTokens(query);
  const candidateTokens = foldTokens(candidate);
  const candidateKeys = new Set(candidateTokens.map(singularKey));
  const shared = new Set(
    queryTokens.map(singularKey).filter((key) => candidateKeys.has(key)),
  );
  return {
    query: residueOf(queryTokens, shared),
    candidate: residueOf(candidateTokens, shared),
  };
}

// The identity tokens of ONE name — the same strike-list with nothing shared to
// subtract. `residueOf` against an empty shared set is exactly that, so the guard
// and the ranking below cannot disagree about what counts as identity.
const NOTHING_SHARED: ReadonlySet<string> = new Set<string>();

function identityTokens(name: string): Set<string> {
  return residueOf(foldTokens(name), NOTHING_SHARED);
}

// Agreement on identity alone, 0..1 (Jaccard over identity tokens).
//
// This is the ranking answer to the second half of the Face/Bride report: a
// family whose members share a brand, a line and a release word — the fourteen
// live `Tatuaje Monster Smash` siblings — differs on ONE token out of six, so
// whole-string trigram scores every sibling nearly alike and the ordering it
// yields is noise. Identity agreement reads only the tokens that distinguish
// them, so the sibling a name actually names sorts to the top and the rest sort
// below it as siblings rather than as near-duplicates of each other.
export function identitySimilarity(query: string, candidate: string): number {
  const q = identityTokens(query);
  const c = identityTokens(candidate);
  let overlap = 0;
  for (const token of q) if (c.has(token)) overlap++;
  const union = q.size + c.size - overlap;
  // Two names that are all vocabulary and no identity make no identity claim to
  // disagree about; the trigram score is left to break the tie.
  return union === 0 ? 1 : overlap / union;
}

// Candidates ordered by IDENTITY FIRST, trigram second — the ordering ADR-012's
// header warns the raw score gets wrong ("trigram similarity RANKS DISTINCT
// PRODUCTS ABOVE TRUE SIBLINGS"). Whole-string similarity is kept as the
// tiebreaker, not discarded: within one identity verdict it is still the best
// signal there is, and a query naming only a brand ties every candidate at the
// same identity score and so is ordered exactly as it was before. The sort is
// stable, so an unbroken tie preserves the order SQL returned.
export function rankByIdentity<T>(
  query: string,
  rows: readonly T[],
  read: (row: T) => { name: string; sim: number },
): T[] {
  return rows
    .map((row) => {
      const { name, sim } = read(row);
      return { row, identity: identitySimilarity(query, name), sim };
    })
    .sort((a, b) => b.identity - a.identity || b.sim - a.sim)
    .map((scored) => scored.row);
}

// Incompatible when BOTH sides carry an identity residue. The residues cannot
// overlap — a token both names carry was struck as shared before either residue
// was built — so two non-empty residues are two different identity claims, and
// the pair is not the same cigar however high its trigram score.
export function identityTokensCompatible(query: string, candidate: string): boolean {
  const residues = identityResidues(query, candidate);
  return residues.query.size === 0 || residues.candidate.size === 0;
}

// The full disqualifier for a freeform comparison. Also used by the curation
// duplicate queue, which is subject to the same reasoning — a number- or
// packaging-distinct pair is never a merge candidate either.
//
// `variantCompatible` IS DELIBERATELY NOT HERE. Wave 2 folded it in and that
// silently re-decided two things this wave never intended to touch: the MCP
// link-vs-create verdict `resolveCigar` gives every described cigar (a user
// saying "Padrón 1964 Maduro" would stop strong-linking the row they have smoked
// eleven times and mint a second one), and which pairs reach the curation
// duplicate queue. The wrapper guard is a MATCHER rule and it belongs where the
// matcher applies it — `chooseLeaf`'s freeform filter, over listings, where a
// refusal costs a triage row rather than a duplicate catalog entry. This keeps
// the #192/#208 definition intact.
export function strongLinkCompatible(query: string, candidate: string): boolean {
  return (
    numbersCompatible(query, candidate) &&
    packagingCompatible(query, candidate) &&
    identityTokensCompatible(query, candidate)
  );
}

// Two vitola labels agree when they fold to the same key. A NULL on either side
// is unknown, not a disagreement — ADR-012's rule that absent is never inferred
// applies to comparison as much as to storage.
export function vitolaAgrees(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return true;
  const left = fold(a);
  const right = fold(b);
  if (left === "" || right === "") return true;
  return left === right;
}
