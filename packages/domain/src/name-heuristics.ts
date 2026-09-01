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
export const VARIANT_TOKENS = new Set([
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

// ==========================================================================
// SPELLING-VARIANT EQUIVALENCE — one word, more than one spelling.
//
// Every rule in this file compares FOLDED TOKENS FOR EQUALITY, which is exact
// where the trade is not. Two shops write one wrapper three ways, a Spanish word
// and its English translation name the same release, and the catalog carries
// outright misspellings — and each of those reads to an exact-token rule as two
// different identity claims, so the guard refuses a link that is plainly right
// and the ranking scores the same product twice.
//
// The table below is the ONE place a spelling is declared to be another
// spelling. The first entry of each group is the canonical key; every other
// entry folds onto it, and a multi-word entry folds onto it with its separator
// dropped, exactly as `Sun Grown` already folds onto `sungrown`.
//
// EQUIVALENCE, NOT DISTANCE. Edit distance is not available to this rule and
// must not be: over the live catalog's own tokens, distance 1 pairs `face` with
// `farce`, `fuente` with `fuerte`, and `black` with `block`. Every entry here is
// a spelling of one word attested in the live catalog or in vendor listing
// titles, and nothing is equated because it merely looks close.
//
// Membership in the vocabulary sets is tested on the CANONICAL key, so a group
// whose canonical key is vocabulary (`shade`, `double`, `rothschild`) carries
// its variants into that vocabulary too, and a group whose canonical key is
// identity (`ecuador`, `sanandres`) keeps its variants identity-bearing. That is
// the difference between unifying two spellings and reclassifying a word.
const SPELLING_VARIANT_GROUPS: readonly (readonly string[])[] = [
  // Wrapper and shade vocabulary. `sun grown` is listed for completeness — it
  // was pair-joined by `variantTokens` before this table existed and now reads
  // from it, so the pair rule has one source. `shade grown` had no entry at all:
  // the single `shade` was struck as a wrapper and the orphaned `grown` was left
  // behind as identity, which is why `HC Series White Shade Grown Toro` and
  // `… Shadegrown Toro` did not read as the same claim.
  ["sungrown", "sun grown"],
  ["shade", "shade grown", "shadegrown"],
  // Identity-bearing, and deliberately so. `Camacho Ecuador` is a product line,
  // not a wrapper note, so `ecuador` stays identity — the group unifies its
  // spellings without letting `Camacho Ecuador` link to `Camacho Corojo`.
  ["ecuador", "ecuadorian", "ecuadorean"],
  // The Mexican wrapper region and the word vendors use instead of it.
  ["san andres", "sanandres", "mexican"],
  ["barber pole", "barberpole"],
  // Spelling and language variants of identity words, each attested in the
  // catalog or in live vendor listing titles.
  ["aniversario", "anniversario", "anniversary"],
  ["edicion", "edition"],
  ["especial", "especiale", "especiales", "special"],
  ["nicaragua", "nicaraguan"],
  // Vitola vocabulary. `rothschild` and `double` are already vitola tokens, so
  // the misspelling and the Spanish spelling become vocabulary with them.
  ["rothschild", "rothchilde"],
  ["double", "doble"],
];

// The table as a lookup: every spelling, folded and joined, to its canonical
// key. Derived rather than typed twice so a group cannot half-apply.
export const SPELLING_VARIANTS: ReadonlyMap<string, string> = new Map(
  SPELLING_VARIANT_GROUPS.flatMap((group) => {
    const canonical = foldTokens(group[0]!).join("");
    return group.map((spelling) => [foldTokens(spelling).join(""), canonical] as const);
  }),
);

// Trailing-`s` fold, for comparison only. `Monster`/`Monsters` and
// `Serie`/`Series` are one word two vendors spell differently; `Face` and
// `Bride` are not, and no stemming makes them one.
//
// THE FLOOR IS ON THE STEM, NOT THE TOKEN, and it was on the token until the
// #235 verify pass measured it: a four-character floor read as "never truncate a
// short word" while in fact truncating `opus` to `opu`, the exact outcome it was
// written to prevent. Requiring the STEM to be four characters refuses `opus`
// and still folds every plural the catalog actually carries — `series`→`serie`,
// `monsters`→`monster`, `robustos`→`robusto`, `churchills`→`churchill`.
//
// `-ss` IS NEVER A PLURAL. English has no plural ending in a doubled s, so
// `press`→`pres` and `dress`→`dres` were pure damage — `press` appears ten times
// in live listing titles, and `dress box` is trade vocabulary
// (docs/ddd/cigar-industry-vocabulary.md).
//
// What remains, stated rather than denied: a six-letter word ending in `s` still
// folds, so `andres` folds to `andre`. Neither key occurs anywhere in the live
// catalog or in vendor listing titles, so nothing collides today — and the one
// place the word is expected, the `San Andrés` wrapper, is joined into
// `sanandres` by the table above before this rule ever sees it.
function singularKey(token: string): string {
  if (!token.endsWith("s") || token.endsWith("ss")) return token;
  const stem = token.slice(0, -1);
  return stem.length >= 4 ? stem : token;
}

// A token's comparison key: its spelling variant if the table names one, else
// the singular fold. The raw token is tried before the fold so a group may name
// a plural spelling directly (`especiales`).
function canonicalKey(token: string): string {
  const direct = SPELLING_VARIANTS.get(token);
  if (direct !== undefined) return direct;
  const singular = singularKey(token);
  return SPELLING_VARIANTS.get(singular) ?? singular;
}

// Two adjacent tokens read as one word — `Sun Grown`, `San Andres`, `Barber
// Pole` — when the pair spells a key some table knows. Returns the canonical key
// or null; null means the pair is not a phrase and each token stands alone.
function joinedKey(a: string, b: string): string | null {
  const joined = a + b;
  const canonical = SPELLING_VARIANTS.get(joined);
  if (canonical !== undefined) return canonical;
  return VARIANT_TOKENS.has(joined) ? joined : null;
}

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
    const single = canonicalKey(tokens[i]!);
    if (VARIANT_TOKENS.has(single)) found.add(single);
    const next = tokens[i + 1];
    if (next !== undefined) {
      const joined = joinedKey(tokens[i]!, next);
      if (joined !== null && VARIANT_TOKENS.has(joined)) found.add(joined);
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
// The rule reads a name as identity plus vocabulary. Fold both names onto their
// comparison keys — accents dropped, plurals folded, alternative spellings
// unified by the table above — then strike from each side every key that is:
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

function isVocabularyKey(key: string): boolean {
  return VITOLA_TOKENS.has(key) || PACKAGING_TOKENS.has(key) || VARIANT_TOKENS.has(key);
}

interface NameKey {
  key: string;
  vocabulary: boolean;
}

// A name as the comparison keys it contributes, in order. ONE PASS, so the
// spelling table, the phrase join and the vocabulary strike cannot disagree
// about what a token became: an adjacent pair that spells a known phrase
// collapses into that phrase's canonical key and consumes both tokens; anything
// else is canonicalized on its own.
//
// The pair is tried first because a two-word phrase is a stronger claim on the
// text than either half — `Sun Grown` is a wrapper, `Sun` alone is not.
function comparisonKeys(name: string): NameKey[] {
  const tokens = foldTokens(name);
  const keys: NameKey[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const next = tokens[i + 1];
    const pair = next === undefined ? null : joinedKey(tokens[i]!, next);
    if (pair !== null) {
      keys.push({ key: pair, vocabulary: isVocabularyKey(pair) });
      i++;
      continue;
    }
    const key = canonicalKey(tokens[i]!);
    keys.push({ key, vocabulary: isVocabularyKey(key) });
  }
  return keys;
}

function residueOf(keys: readonly NameKey[], shared: ReadonlySet<string>): Set<string> {
  const residue = new Set<string>();
  for (const { key, vocabulary } of keys) {
    if (vocabulary || shared.has(key)) continue;
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
  const queryKeys = comparisonKeys(query);
  const candidateKeys = comparisonKeys(candidate);
  const candidateSet = new Set(candidateKeys.map(({ key }) => key));
  const shared = new Set(queryKeys.map(({ key }) => key).filter((key) => candidateSet.has(key)));
  return {
    query: residueOf(queryKeys, shared),
    candidate: residueOf(candidateKeys, shared),
  };
}

// The identity tokens of ONE name — the same strike-list with nothing shared to
// subtract. `residueOf` against an empty shared set is exactly that, so the guard
// and the ranking below cannot disagree about what counts as identity.
const NOTHING_SHARED: ReadonlySet<string> = new Set<string>();

function identityTokens(name: string): Set<string> {
  return residueOf(comparisonKeys(name), NOTHING_SHARED);
}

// How much of what the QUERY claims a candidate accounts for, 0..1 — the share
// of the query's identity tokens the candidate also carries.
//
// This is the ranking answer to the second half of the Face/Bride report: a
// family whose members share a brand, a line and a release word — the fourteen
// live `Tatuaje Monster Smash` siblings — differs on ONE token out of six, so
// whole-string trigram scores every sibling nearly alike and the ordering it
// yields is noise. Reading only the tokens that distinguish them puts the
// sibling a name actually names on top.
//
// ASYMMETRIC ON PURPOSE, and a symmetric measure is wrong here. Jaccard would
// divide by the union, so a query that names only a brand — every candidate
// containing all of it, none of it distinguishing — would score `1/k` and rank
// the SHORTEST catalog name first, silently replacing the trigram order with a
// length preference on exactly the queries that carry no identity claim to rank
// by. Dividing by the query alone makes those candidates genuinely tie, which
// hands the decision back to the trigram tiebreaker where it belongs. Extra
// tokens on the candidate are not penalized: `…No. 9` scoring below `…No. 9
// Flying Pig` for a query naming the Pig is the point, and the reverse case (a
// query naming less than the row) is the one-sided residue the guard permits.
export function identityCoverage(query: string, candidate: string): number {
  const q = identityTokens(query);
  // A query that is all vocabulary and no identity makes no claim to rank by.
  if (q.size === 0) return 1;
  const c = identityTokens(candidate);
  let overlap = 0;
  for (const token of q) if (c.has(token)) overlap++;
  return overlap / q.size;
}

// How many trigram candidates the identity rank is given, as against how many
// the caller returns. A FAMILY IS BIGGER THAN A PAGE: `Tatuaje Monster` is
// fourteen live siblings whose names differ in one word out of six, so they
// score nearly alike and a small `LIMIT` on the trigram order returns arbitrary
// members of the fourteen — the one the user actually named as likely absent as
// present. Ranking cannot recover a row the pool never held, so the pool is
// drawn wide on similarity, ranked on identity, and only then cut.
//
// ONE POOL FOR BOTH READERS. `searchCigars` shows the candidates and
// `resolveCigar` decides link-vs-create over the same catalog with the same
// guard, so a row inside one's reach and outside the other's is a disagreement
// with nothing behind it: the tool that offers a sibling would be the tool that
// cannot see it a moment later, and `resolveCigar`'s ambiguity list — the list
// the user picks from — would be drawn from a narrower slice than the search
// that prompted them to pick.
export const CANDIDATE_POOL = 50;

// Coverage is a RATIO OF SMALL INTEGERS, so the arithmetic gap between two
// candidates is often narrower than any claim either name makes: 4/5 against
// 3/4 is a difference in token counts, not in what the names say. Quantizing
// answers only the question the measure can answer — does this candidate account
// for most of the name, some of it, or none — and hands everything finer back to
// the trigram score.
const IDENTITY_BANDS = 2;

// Candidates ordered by the IDENTITY VERDICT FIRST, then by identity band, and
// only then by trigram — the ordering ADR-012's header warns the raw score gets
// wrong ("trigram similarity RANKS DISTINCT PRODUCTS ABOVE TRUE SIBLINGS").
//
// THE VERDICT IS THE GUARD'S OWN, and putting it first is what makes the rest
// safe to relax. A candidate with a MUTUAL residue contradicts the name — it
// says `Bride` where the query said `Creature` — and no trigram score should
// promote a contradiction, so those sort below every candidate that merely says
// more or less than the query. That is the whole of the fourteen-sibling case:
// thirteen siblings contradict and the named one does not.
//
// COVERAGE IS NO LONGER AN ABSOLUTE PRIMARY, because it was demoting better
// answers. It cannot see the candidate's own extra words, so a longer, more
// specific catalog name that happens to contain every word of the query scores a
// perfect 1 and outranked a near-exact match that dropped a single word —
// `Padron 1964 Anniversary Series Diplomatico` above `Padron 1964 Anniversary
// Torpedo` for a query naming the Torpedo. Banded, those two tie on identity and
// the trigram score — which is emphatically better at whole-name closeness —
// decides. A genuinely stronger identity claim still lands in a higher band and
// still wins outright.
//
// A query naming only a brand covers equally in every candidate that carries the
// brand, so those tie on all three keys and the sort — being stable — hands them
// back in the order SQL returned them.
export function rankByIdentity<T>(
  query: string,
  rows: readonly T[],
  read: (row: T) => { name: string; sim: number },
): T[] {
  return rows
    .map((row) => {
      const { name, sim } = read(row);
      return {
        row,
        compatible: identityTokensCompatible(query, name) ? 1 : 0,
        band: Math.round(identityCoverage(query, name) * IDENTITY_BANDS),
        sim,
      };
    })
    .sort((a, b) => b.compatible - a.compatible || b.band - a.band || b.sim - a.sim)
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

// The sizes a NAME states, on the same comparison keys every other rule in this
// file reads — so the spelling table, the phrase join and this scan cannot
// disagree about what a token became (`Doble` is `double`, `Rothchilde` is
// `rothschild`).
//
// THE NAME, NOT THE COLUMN, and that difference is the whole of #260. `cigars.
// vitola_name` is null on essentially every freeform row this catalog holds —
// 0026 minted no structure, so a leaf's size lives in its NAME and nowhere else.
// `Tatuaje Skinny Monsters Chuck` states a size in the only place it can, and a
// rule that reads the column alone sees an absence and calls it agreement.
export function statedVitolas(name: string): Set<string> {
  const found = new Set<string>();
  for (const { key } of comparisonKeys(name)) if (VITOLA_TOKENS.has(key)) found.add(key);
  return found;
}

// MAY THIS LISTING BIND THAT LEAF? — the matcher's own disqualifier, and a
// different question from `strongLinkCompatible` above, which asks whether two
// CATALOG ROWS are the same product. This one is asked of a vendor title against
// a leaf of the brand the title already anchored, and it exists because the
// answer "yes, because nothing positively contradicted it" was wrong 1 time in 3.
//
// Measured on prod, 2026-09-01: one Fox offers run wrote 1,067 crawler links; a
// 60-link audit against the vendor's own listing names found the marca right
// 60/60 and the LEAF right 40/60. Nineteen bound the wrong size and one the wrong
// line. Two of them are the proof that this is a guard problem and not a ranking
// one — the correct row EXISTED and a sibling was taken anyway (`CAO Flavours
// Bella Vanilla Corona` bound `CAO Flavours Moontrance Corona`; `LFD Suave Maceo`
// bound `… Gobernador`) — and the rest are lines holding exactly ONE leaf, which
// swallowed every sibling SKU the vendor sells (`Tatuaje Skinny Monsters Frank`
// into the line's only leaf `… Chuck`, `Rocky Patel Dark Star Toro` into
// `… Sixty`, nine `Davidoff Grand Cru` SKUs into one row).
//
// THREE CLAUSES, AND THE THIRD IS THE ONE THE OTHERS CANNOT COVER.
export function leafBindingCompatible(
  query: string,
  candidate: string,
  candidateVitola: string | null | undefined,
): boolean {
  // 1. The identity rule the rest of the repo already runs. `coversAsk` (the
  //    enrich drain) and `strongLinkCompatible` (the MCP link-vs-create verdict)
  //    both refuse a mutual residue; the seed and offers walks did not, which is
  //    the single largest hole here — `{bella, vanilla}` against `{moontrance}`
  //    is two different identity claims under one brand and one line.
  if (!numbersCompatible(query, candidate)) return false;
  if (!packagingCompatible(query, candidate)) return false;
  if (!identityTokensCompatible(query, candidate)) return false;

  // A listing that states no size makes no size claim to contradict. This is the
  // commonest shape in the catalog and the reason the rest of this is narrow: a
  // blend-level title meeting a vitola-level row is a link, not a disagreement.
  const stated = statedVitolas(query);
  if (stated.size === 0) return true;

  // 2. The size axis, read off the candidate's NAME as well as its column. The
  //    column is consulted because a curated row may carry a size its name omits
  //    (`Davidoff Grand Cru` carries `vitola_name = 'Toro'`), and that fact is
  //    exactly what should keep `… Robusto` off it.
  const carried = new Set([...statedVitolas(candidate), ...statedVitolas(candidateVitola ?? "")]);
  if (carried.size > 0 && !mutuallyContained(stated, carried)) return false;

  // 3. A SIZED LISTING MAY NOT ABSORB A LEAF THAT NAMES ITS OWN. The one-sided
  //    residue allowance above is written for a query that says strictly LESS
  //    than the row — `Liga Privada No. 9` meeting `… No. 9 Flying Pig`, the
  //    shape of most of this catalog. It is not written for a query that is
  //    SPECIFIC on the size axis while the row is specific in a way the vocabulary
  //    cannot read: `Rocky Patel Dark Star Toro` against `Rocky Patel Dark Star
  //    Sixty` leaves residue `{sixty}` on the row alone, and `Sixty` IS that
  //    leaf's size — it is simply not a word any size list contains, and no list
  //    ever will contain every house's private name for a 60-ring cigar.
  //
  //    So the allowance is withdrawn when the listing has pinned a size and the
  //    row still reaches somewhere the listing does not. Scoped to a row that
  //    states no size of its own, so it never fires on the case it would damage:
  //    `Padrón 1964 Anniversary Torpedo` against `… Anniversary Series Torpedo`
  //    has residue `{serie}` on the row, and both name the Torpedo, so clause 2
  //    has already agreed and this clause stands down.
  if (carried.size > 0) return true;
  return identityResidues(query, candidate).candidate.size === 0;
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
