import { fold, tokenWindows, anchorByAlias, type AliasCandidate, type AliasAnchor } from "./taxonomy-keys.js";

// The pure half of matching v2 (ADR-012 Wave 2): a vendor listing title in, a
// structured parse out. No database, no I/O — every registry lookup is expressed
// as "here are the candidate rows, which one does this title name?", so the whole
// pipeline is testable against literals and the crawler and the journal resolver
// run the SAME code over the same vocabulary.
//
// The order is fixed and each step narrows the next:
//
//   1. clean      — decode is the caller's (the crawler already does it), then
//                   strip packaging. PACKAGING IS NEVER IDENTITY (ADR-012): it
//                   describes the offer, so it comes off before anything reads
//                   the title as a name.
//   2. anchor     — brand by folded alias, longest window, prefix-preferred.
//                   No anchor, no parse. This is the step that replaces trigram.
//   3. line/blend — by alias WITHIN the level above, over the tokens the level
//                   above did not consume. Absent stays absent, always.
//   4. vitola     — trade vocabulary + dimension patterns, over what is left.
//   5. residue    — the tokens nobody claimed. The most useful field in triage,
//                   because it is precisely the part of the title the catalog
//                   cannot yet explain.

// --------------------------------------------------------------------------
// Packaging — the offer's facts, removed from the name before it is a name.
// --------------------------------------------------------------------------

// Standalone tokens that describe a container rather than a cigar. Migrated here
// from cigar-resolution.ts, which used them for the same purpose from the other
// direction (refusing to strong-link a Tubos Pack to the naked stick) and now
// imports them back from this one vocabulary.
export const PACKAGING_TOKENS = new Set([
  "tubo",
  "tubos",
  "tube",
  "tubed",
  "tubopack",
  "tubospack",
  "pack",
  "pk",
  "tin",
  "jar",
  "sampler",
  "box",
  "cab",
  "bundle",
]);

// `box-pressed` and `trunk-pressed` are SHAPE, not packaging — the vocabulary
// reference is explicit that they describe the leaf's vitola and that a title
// carrying one is not a new leaf (docs/ddd/cigar-industry-vocabulary.md). The
// word `box` inside them has to survive the packaging strip, and it does so for
// free once the phrase is HYPHENATED INTO ONE WORD: the token pass compares
// folded keys, and `box-pressed` is not `box`. So this is a normalization, not a
// protect-and-restore dance — `Box Pressed` and `Box-Pressed` both become the
// single token `Box-Pressed`, which no packaging rule can see, and the title
// gains a consistent spelling of a shape term into the bargain.
const PRESSED = /\b(box|trunk)[\s-]?press(ed)?\b/gi;

// The count/packaging phrases, most specific first, exactly as ADR-009's
// conservative parse has always ordered them: `box of 20` must win over the bare
// `20`. Each carries how the offer should record it.
const PACKAGING_PHRASES: { pattern: RegExp; packaging: (n: string) => string; sticks: (n: string) => number }[] = [
  { pattern: /\bbox\s+of\s+(\d{1,3})\b/i, packaging: () => "box", sticks: (n) => Number(n) },
  { pattern: /\bpack\s+of\s+(\d{1,2})\b/i, packaging: (n) => `${n}-pack`, sticks: (n) => Number(n) },
  { pattern: /\b(\d{1,2})[\s-]?pack\b/i, packaging: (n) => `${n}-pack`, sticks: (n) => Number(n) },
  { pattern: /\b(singles?)\b/i, packaging: () => "single", sticks: () => 1 },
];

export interface PackagingFacts {
  packaging: string | null;
  sticksPerPackage: number | null;
}

// The offer's packaging, unchanged from ADR-009's rules. The crawler's
// `parsePackaging` delegates here so there is one vocabulary rather than two
// that drift: the stripper below and the offer writer must agree about what
// counts as packaging, or a token would come off the name without being recorded
// anywhere.
export function parsePackagingFacts(name: string): PackagingFacts {
  for (const phrase of PACKAGING_PHRASES) {
    const hit = phrase.pattern.exec(name);
    if (hit) return { packaging: phrase.packaging(hit[1]!), sticksPerPackage: phrase.sticks(hit[1]!) };
  }
  return { packaging: null, sticksPerPackage: null };
}

export interface StrippedTitle extends PackagingFacts {
  cleaned: string;
  // A retailer assortment spanning brands or blends. It matches NO SINGLE LEAF
  // (docs/ddd/cigar-industry-vocabulary.md) — carried here so the resolver can
  // refuse to mint from it rather than creating a catalog row called "Sampler".
  sampler: boolean;
}

// Remove everything that describes the container, leaving the name of the thing
// inside it. Conservative by construction: only the ADR-009 phrases, the token
// vocabulary above, and explicit count suffixes (`10 ct`, `(5)`) come off.
// Anything else stays, because an over-eager strip silently destroys identity
// while an under-eager one merely leaves residue for a curator to read.
export function stripPackaging(name: string): StrippedTitle {
  const facts = parsePackagingFacts(name);
  const sampler = /\bsamplers?\b/i.test(name);

  let working = name.replace(PRESSED, (match) => match.replace(/\s+/g, "-"));

  for (const phrase of PACKAGING_PHRASES) {
    working = working.replace(new RegExp(phrase.pattern.source, "gi"), " ");
  }
  // Explicit counts a vendor appends to a packaged listing: `10 ct`, `5-count`,
  // `(25)`. A bare number is NEVER treated as a count — `1964`, `T52` and `No. 9`
  // are identity, and this is exactly where the flat matcher used to go wrong.
  working = working.replace(/\b\d{1,3}\s*(?:ct|cnt|count|pcs?|pieces?|cigars?)\b/gi, " ");
  working = working.replace(/\(\s*\d{1,3}\s*\)/g, " ");

  working = working
    .split(/\s+/)
    .filter((word) => {
      const key = fold(word);
      return key === "" ? true : !PACKAGING_TOKENS.has(key);
    })
    .join(" ");

  const cleaned = working
    // Separators left dangling by the removals: a trailing `-`, a doubled comma,
    // an emptied bracket. `Padrón 1964 - Box of 20 - Torpedo` loses its middle
    // segment and would otherwise keep both of the dashes that framed it, so a
    // separator immediately followed by another collapses into one. Cosmetic
    // only in the parse — but `cleanedName` becomes a minted row's
    // `canonical_name`, so it is the difference between a catalog entry and a
    // catalog entry that looks like a bug.
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/([-–—,/|])(?:\s*[-–—,/|])+/g, "$1")
    .replace(/\s*[-–—,/|]+\s*$/g, "")
    .replace(/^\s*[-–—,/|]+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return { cleaned, packaging: facts.packaging, sticksPerPackage: facts.sticksPerPackage, sampler };
}

// --------------------------------------------------------------------------
// Vitola — a size label within a blend, never an entity (ADR-012).
// --------------------------------------------------------------------------

// The trade vocabulary, keyed by folded key and valued by the display spelling.
// Two sources: the shared shape terms in docs/ddd/cigar-industry-vocabulary.md,
// and the commercial sizes (vitolas de salida) a vendor title actually carries.
//
// Multi-word entries are here on purpose and the longest-window scan is what
// makes them work: `double-corona` must beat `corona`, `petit-corona` must beat
// both. Accented spellings need no entry — `Pirámide` and `Piramide` fold to the
// same key, which is the whole reason matching runs on folded keys.
const VITOLA_TERMS = new Map<string, string>([
  // Shapes.
  ["parejo", "Parejo"],
  ["figurado", "Figurado"],
  ["torpedo", "Torpedo"],
  ["piramide", "Pirámide"],
  ["pyramid", "Pirámide"],
  ["belicoso", "Belicoso"],
  ["perfecto", "Perfecto"],
  ["culebra", "Culebra"],
  ["salomon", "Salomón"],
  ["diadema", "Diadema"],
  // Commercial sizes.
  ["robusto", "Robusto"],
  ["robustos", "Robusto"],
  ["petit-robusto", "Petit Robusto"],
  ["short-robusto", "Short Robusto"],
  ["double-robusto", "Double Robusto"],
  ["robusto-extra", "Robusto Extra"],
  ["toro", "Toro"],
  ["toro-grande", "Toro Grande"],
  ["gordo", "Gordo"],
  ["gordito", "Gordito"],
  ["churchill", "Churchill"],
  ["churchills", "Churchill"],
  ["double-corona", "Double Corona"],
  ["corona-gorda", "Corona Gorda"],
  ["corona-extra", "Corona Extra"],
  ["gran-corona", "Gran Corona"],
  ["petit-corona", "Petit Corona"],
  ["half-corona", "Half Corona"],
  ["corona", "Corona"],
  ["coronas", "Corona"],
  ["lonsdale", "Lonsdale"],
  ["panetela", "Panetela"],
  ["panatela", "Panetela"],
  ["lancero", "Lancero"],
  ["petit-lancero", "Petit Lancero"],
  ["presidente", "Presidente"],
  ["rothschild", "Rothschild"],
  ["magnum", "Magnum"],
  ["gigante", "Gigante"],
  ["sublime", "Sublime"],
  ["sublimes", "Sublime"],
  ["epicure", "Epicure"],
  ["hermoso", "Hermoso"],
  ["campana", "Campana"],
  ["canonazo", "Cañonazo"],
  ["laguito", "Laguito"],
  ["mareva", "Mareva"],
  ["exclusivo", "Exclusivo"],
  ["exclusivos", "Exclusivo"],
  ["perla", "Perla"],
  ["regalia", "Regalia"],
]);

// `torpedo` is the least reliable shape label a crawler meets: strictly it means
// closed foot, pointed head, bulged middle, but modern usage has drifted to any
// tapered head, so most "torpedoes" sold are actually pirámides
// (docs/ddd/cigar-industry-vocabulary.md). It still parses — dropping a stated
// size would be worse — but it is flagged so a note rides into triage rather
// than the match being quietly trusted.
const WEAK_VITOLA_KEYS = new Set(["torpedo"]);

export interface VitolaHit {
  name: string;
  start: number;
  length: number;
  weak: boolean;
}

// Longest-window vitola match over the tokens no registry level claimed.
// Restricted to unconsumed tokens on purpose: `Toro` inside a brand named
// `El Toro` is part of the marca, not a size, and the brand anchor has already
// taken those tokens off the table.
export function matchVitola(tokens: string[], consumed: ReadonlySet<number>): VitolaHit | null {
  for (const window of tokenWindows(tokens)) {
    let free = true;
    for (let i = window.start; i < window.start + window.length; i++) {
      if (consumed.has(i)) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    const display = VITOLA_TERMS.get(window.key);
    if (display) {
      return { name: display, start: window.start, length: window.length, weak: WEAK_VITOLA_KEYS.has(window.key) };
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Dimensions — `6 x 50`, `60 x 6`, `7x70`, `6 1/2 x 52`.
// --------------------------------------------------------------------------

export interface Dims {
  lengthInches: number | null;
  ringGauge: number | null;
}

// Whole, decimal, or vulgar fraction: `6`, `6.5`, `6 1/2`, `6-1/2`.
const NUMBER = String.raw`\d{1,3}(?:\.\d+)?(?:[\s-]\d\/\d)?`;
const DIMS_PATTERN = new RegExp(String.raw`\b(${NUMBER})\s*[x×]\s*(${NUMBER})\b`, "i");
const RING_ONLY = /\b(\d{2})\s*(?:ring|rg)\b/i;
const LENGTH_ONLY = new RegExp(String.raw`\b(${NUMBER})\s*(?:in\b|inch|inches|")`, "i");

function toNumber(raw: string): number | null {
  const fraction = /^(\d{1,3})[\s-](\d)\/(\d)$/.exec(raw.trim());
  if (fraction) {
    const denominator = Number(fraction[3]);
    if (denominator === 0) return null;
    return Number(fraction[1]) + Number(fraction[2]) / denominator;
  }
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

const MIN_LENGTH = 3;
const MAX_LENGTH = 10;
const MIN_RING = 20;
const MAX_RING = 80;

// A cigar's two dimensions are told in either order — `6 x 50` and `60 x 6` are
// both real vendor spellings — and there is no separator that says which is
// which. MAGNITUDE decides, and it can, because the ranges do not overlap: a
// length is 3–10 inches and a ring gauge is 20–80 sixty-fourths. A pair that
// does not resolve to one of each is not a dimension pair at all and is dropped
// rather than guessed.
export interface ExtractedDims {
  dims: Dims;
  // The title with the dimension spans blanked out. Everything downstream —
  // aliases, vitola, residue — reads THIS, so a measurement can never be mistaken
  // for identity and, just as importantly, `1964` can never be mistaken for a
  // measurement: nothing is removed unless it matched a pattern that requires an
  // `x` between two numbers or an explicit `ring`/`inch` unit.
  remainder: string;
}

export function extractDims(name: string): ExtractedDims {
  const fits = (value: number, min: number, max: number) => value >= min && value <= max;

  const pair = DIMS_PATTERN.exec(name);
  if (pair) {
    const a = toNumber(pair[1]!);
    const b = toNumber(pair[2]!);
    if (a != null && b != null) {
      const blanked = name.slice(0, pair.index) + " " + name.slice(pair.index + pair[0].length);
      if (fits(a, MIN_LENGTH, MAX_LENGTH) && fits(b, MIN_RING, MAX_RING)) {
        return { dims: { lengthInches: a, ringGauge: Math.round(b) }, remainder: blanked };
      }
      if (fits(b, MIN_LENGTH, MAX_LENGTH) && fits(a, MIN_RING, MAX_RING)) {
        return { dims: { lengthInches: b, ringGauge: Math.round(a) }, remainder: blanked };
      }
      // A pair that resolves to neither shape is not a dimension pair. Left in
      // place: whatever it is, it is more likely identity than measurement.
    }
  }

  // Half a pair is still a fact. `50 ring` and `6 inch` appear alone often
  // enough to be worth reading, and each is unambiguous on its own.
  const dims: Dims = { lengthInches: null, ringGauge: null };
  let remainder = name;

  const ring = RING_ONLY.exec(remainder);
  if (ring) {
    const value = Number(ring[1]);
    if (fits(value, MIN_RING, MAX_RING)) {
      dims.ringGauge = value;
      remainder = remainder.slice(0, ring.index) + " " + remainder.slice(ring.index + ring[0].length);
    }
  }
  const length = LENGTH_ONLY.exec(remainder);
  if (length) {
    const value = toNumber(length[1]!);
    if (value != null && fits(value, MIN_LENGTH, MAX_LENGTH)) {
      dims.lengthInches = value;
      remainder = remainder.slice(0, length.index) + " " + remainder.slice(length.index + length[0].length);
    }
  }
  return { dims, remainder };
}

// Dimensions only, for callers that just want the numbers.
export function parseDims(name: string): Dims {
  return extractDims(name).dims;
}

// --------------------------------------------------------------------------
// Tokenization
// --------------------------------------------------------------------------

export interface TitleTokens {
  // Display words, index-aligned with `keys`.
  words: string[];
  // Folded matching keys — what alias comparison actually runs against.
  keys: string[];
}

// Split a cleaned title into index-aligned display/matching token pairs. Words
// that fold to nothing (`&`, `—`) are dropped from BOTH arrays: they can never
// match an alias key and keeping them would break the window arithmetic that
// alias spans and residue reconstruction both depend on.
export function tokenizeTitle(cleaned: string): TitleTokens {
  const words: string[] = [];
  const keys: string[] = [];
  for (const word of cleaned.split(/\s+/)) {
    if (word === "") continue;
    const key = fold(word);
    if (key === "") continue;
    // One display word can fold to a multi-token key (`No.9` → `no-9`), which
    // would desynchronize the arrays. Split those so one word is one token.
    const parts = key.split("-");
    if (parts.length === 1) {
      words.push(word);
      keys.push(key);
      continue;
    }
    for (const part of parts) {
      words.push(part);
      keys.push(part);
    }
  }
  return { words, keys };
}

// --------------------------------------------------------------------------
// The parse
// --------------------------------------------------------------------------

export interface ListingParse {
  brandId: string | null;
  brandName: string | null;
  lineId: string | null;
  lineName: string | null;
  blendId: string | null;
  blendName: string | null;
  vitolaName: string | null;
  lengthInches: number | null;
  ringGauge: number | null;
  // The title with packaging removed — what this listing would be CALLED if it
  // were minted. Identity never carries packaging (ADR-012).
  cleanedName: string;
  packaging: string | null;
  sticksPerPackage: number | null;
  sampler: boolean;
  // The tokens no level claimed, in title order. Empty means the parse explained
  // the whole title.
  residue: string;
  notes: string[];
}

// What the caller must supply for each level, resolved from the registries. The
// line and blend candidate sets are already scoped by the caller — lines of the
// anchored brand, blends of the anchored line — which is how "within the brand"
// is enforced structurally rather than by a filter this function could forget.
export interface ParseRegistry {
  brands: readonly AliasCandidate[];
  linesOfBrand: (brandId: string) => readonly AliasCandidate[];
  blendsOfLine: (lineId: string) => readonly AliasCandidate[];
}

function markConsumed<T extends AliasCandidate>(anchor: AliasAnchor<T>, consumed: Set<number>): void {
  for (let i = anchor.start; i < anchor.start + anchor.length; i++) consumed.add(i);
}

// The whole pipeline, pure. `categoryPath` is carried through rather than parsed:
// the breadcrumbs are persisted as parse EVIDENCE for a curator (migration 0027),
// and letting them influence the anchor would import a vendor's merchandising
// taxonomy into our identity model — the two disagree often enough that ADR-012
// treats breadcrumbs as a signal to keep, not a signal to trust.
export function parseListingTitle(title: string, registry: ParseRegistry): ListingParse {
  const stripped = stripPackaging(title);
  // Dimensions come out BEFORE tokenizing. `6 x 50` folds into three tokens that
  // no alias will ever claim, and leaving them in would put a measurement in the
  // residue a curator reads as unexplained identity.
  const { dims, remainder } = extractDims(stripped.cleaned);
  const { words, keys } = tokenizeTitle(remainder);
  const consumed = new Set<number>();
  const notes: string[] = [];

  const parse: ListingParse = {
    brandId: null,
    brandName: null,
    lineId: null,
    lineName: null,
    blendId: null,
    blendName: null,
    vitolaName: null,
    lengthInches: dims.lengthInches,
    ringGauge: dims.ringGauge,
    cleanedName: stripped.cleaned,
    packaging: stripped.packaging,
    sticksPerPackage: stripped.sticksPerPackage,
    sampler: stripped.sampler,
    residue: "",
    notes,
  };

  if (stripped.packaging) {
    notes.push(`Packaging '${stripped.packaging}' stripped from the name and recorded on the offer.`);
  }
  if (stripped.sampler) {
    notes.push("Sampler listing — a retailer assortment matches no single leaf.");
  }

  const brand = anchorByAlias(keys, registry.brands);
  if (!brand) {
    notes.push("No brand alias matched — nothing anchors this title.");
    parse.residue = words.join(" ");
    return parse;
  }
  parse.brandId = brand.entity.id;
  parse.brandName = brand.entity.name;
  markConsumed(brand, consumed);
  if (brand.start > 0) {
    // Vendors do title `Cigars - Padrón 1964`. An infix anchor is allowed, and
    // saying so keeps a curator from reading the leading words as a lost brand.
    notes.push(`Brand '${brand.entity.name}' matched mid-title at word ${brand.start + 1}.`);
  }

  // The line is looked for over the tokens AFTER the brand: a line name precedes
  // its brand in no title anyone writes, and searching the whole string would let
  // a leading vendor word anchor a line the brand does not own.
  const line = anchorByAlias(keys, registry.linesOfBrand(brand.entity.id), { from: brand.start + brand.length });
  if (line) {
    parse.lineId = line.entity.id;
    parse.lineName = line.entity.name;
    markConsumed(line, consumed);

    const blend = anchorByAlias(keys, registry.blendsOfLine(line.entity.id), { from: line.start + line.length });
    if (blend) {
      parse.blendId = blend.entity.id;
      parse.blendName = blend.entity.name;
      markConsumed(blend, consumed);
    } else {
      notes.push(`No blend alias matched within '${line.entity.name}'.`);
    }
  } else {
    notes.push(`No line alias matched within '${brand.entity.name}'.`);
  }

  const vitola = matchVitola(keys, consumed);
  if (vitola) {
    parse.vitolaName = vitola.name;
    for (let i = vitola.start; i < vitola.start + vitola.length; i++) consumed.add(i);
    if (vitola.weak) {
      notes.push(`'${vitola.name}' is a drifted trade label — most cigars sold as torpedoes are pirámides.`);
    }
  }

  parse.residue = words.filter((_, index) => !consumed.has(index)).join(" ");
  return parse;
}
