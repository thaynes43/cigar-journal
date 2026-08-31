import { fold } from "./taxonomy-keys.js";
import { PACKAGING_TOKENS } from "./catalog-parse.js";

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

function variantTokens(name: string): Set<string> {
  return new Set(tokensOf(name).filter((token) => VARIANT_TOKENS.has(token)));
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

// Incompatible when the two names name different wrapper variants. A name that
// states no variant at all is compatible with anything: silence is not a claim,
// and refusing to link `Padrón 1964 Anniversary` to its Maduro row would invent a
// distinction the vendor did not make.
export function variantCompatible(query: string, candidate: string): boolean {
  const q = variantTokens(query);
  const c = variantTokens(candidate);
  if (q.size === 0 || c.size === 0) return true;
  return mutuallyContained(q, c);
}

// The full disqualifier for a freeform comparison. Also used by the curation
// duplicate queue, which is subject to the same reasoning — a number-, packaging-
// or variant-distinct pair is never a merge candidate either.
export function strongLinkCompatible(query: string, candidate: string): boolean {
  return (
    numbersCompatible(query, candidate) &&
    packagingCompatible(query, candidate) &&
    variantCompatible(query, candidate)
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
