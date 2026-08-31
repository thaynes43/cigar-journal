import { brandSlug } from "./catalog-browse.js";
import { HIERARCHY_UNFILED } from "./types.js";

// The matching-key vocabulary shared by the registries, the crawler and the
// journal resolver (ADR-012, migration 0026/0027).
//
// TWO KEYS, ONE RULE APART, and keeping them apart is the whole design:
//
//   brandSlug()  — the LEGACY stored key. `brand_images.brand_slug`, the legacy
//                  brand URL, and `brands.slug` on every row migration 0026
//                  seeded. It never folds accents, so `Padrón` is `padr-n`.
//                  Ugly, and load-bearing: changing it breaks live URLs.
//   fold()       — the MATCHING key. NFKD, drop the combining marks, then
//                  brandSlug. `Padrón` and `Padron` both become `padron`.
//
// A registry row minted TODAY stores the folded key, not the transcription
// (`mintRegistrySlug`, at the foot of this module) — so `brands.slug` holds both
// flavors and `registrySlugCandidates` is what spans them. The two rules stay
// distinct: this is a change to what NEW rows are minted with, not a change to
// `brandSlug()`, which still owns every key that is already published.
//
// `brands.aliases` / `lines.aliases` / `blends.aliases` hold fold() output and
// nothing else — the migration seeds them that way and the GIN probe is an exact
// array containment test, so a display spelling stored there would simply never
// be found. Every key this module produces is fold() output for the same reason.

// The matching normalization. Identical to the `fold()` the crawler has used for
// Wikidata brand reconciliation since before the registries existed; it lives
// here now because @cj/domain cannot import from @cj/crawler and the registry
// probe is domain-side. The crawler re-exports this one, so there is exactly one
// implementation and the alias keys in the database can only ever agree with it.
export function fold(value: string): string {
  return brandSlug(value.normalize("NFKD").replace(/\p{M}+/gu, ""));
}

// A folded key split back into its parts. `"Padrón 1964"` → `["padron","1964"]`.
// Every alias key is a `-`-joined run of these, which is what makes the window
// scan below a plain string equality rather than a fuzzy comparison.
export function foldTokens(value: string): string[] {
  const key = fold(value);
  return key === "" ? [] : key.split("-");
}

// The longest alias any registry level is likely to carry, in tokens.
// `Fuente Fuente OpusX` is 3, `1964 Anniversary Series` is 3, `La Flor
// Dominicana` is 3. Six leaves generous headroom while keeping the probe's key
// set linear and small: a 12-token title yields at most 12 × 6 keys, one array
// literal, one GIN lookup.
export const MAX_ALIAS_TOKENS = 6;

// One contiguous run of title tokens, and where it sat. The position is what
// lets the anchor prefer a prefix match and lets the caller subtract the span it
// consumed before looking for the next level down.
export interface TokenWindow {
  key: string;
  start: number;
  length: number;
}

// Every contiguous token window up to MAX_ALIAS_TOKENS, ordered LONGEST FIRST
// and, within a length, leftmost first. That order IS the matching policy:
//
//   longest first — `la-flor-dominicana` must beat `la`, and `liga-privada`
//                   must beat `liga`. A shorter key that is a prefix of a longer
//                   one is always the weaker claim on the same text.
//   leftmost next — a brand is usually where a title starts, so among equal-
//                   length matches the earlier one is preferred. Only preferred:
//                   an infix match still wins outright when nothing earlier
//                   matches, because vendors do title `Cigars — Padrón 1964`.
export function tokenWindows(tokens: string[], maxLength = MAX_ALIAS_TOKENS): TokenWindow[] {
  const windows: TokenWindow[] = [];
  const cap = Math.min(maxLength, tokens.length);
  for (let length = cap; length >= 1; length--) {
    for (let start = 0; start + length <= tokens.length; start++) {
      windows.push({ key: tokens.slice(start, start + length).join("-"), start, length });
    }
  }
  return windows;
}

// Every distinct window key a title could match, for the registry probe. This is
// the array that goes into `aliases && ARRAY[...]`: one GIN lookup answers "which
// registry rows does this title name?" for every window at once, instead of a
// query per window or a scan per row.
export function windowKeys(tokens: string[], maxLength = MAX_ALIAS_TOKENS): string[] {
  return [...new Set(tokenWindows(tokens, maxLength).map((window) => window.key))].filter((key) => key !== "");
}

// A registry row as the anchor step needs it: an id, a display name and the
// folded keys it answers to. Deliberately structural rather than a table type —
// brands, lines and blends are all matched by exactly this shape, so one
// function serves all three levels.
export interface AliasCandidate {
  id: string;
  name: string;
  aliases: string[];
}

export interface AliasAnchor<T extends AliasCandidate> {
  entity: T;
  key: string;
  start: number;
  length: number;
}

// The shortest alias key allowed to anchor a brand. Two characters is an article
// (`la`, `de`, `el`), not a marca, and one of those matching mid-title anchors a
// whole listing on a syllable. Three keeps the real short marcas (CAO, LFD)
// working and is the same floor the scope query's bridge clause uses, for the
// same reason — the two must agree or a brand admitted by one is refused by the
// other.
export const MIN_ANCHOR_KEY_LENGTH = 3;

export interface AnchorOptions {
  // Restrict the scan to a token range. That is how "line within the brand's
  // remaining tokens" and "blend within the line's" are expressed without a
  // second normalization pass.
  from?: number;
  to?: number;
  // THE BRAND-ANCHOR CONSTRAINTS, and only the brand anchor passes them.
  //
  // A single-token alias is the weakest claim any candidate can make on a title,
  // and matched mid-title it is usually a word the marca does not own. All three
  // of these are real vendor titles and all three anchored the wrong brand:
  //
  //   `La Aroma de Cuba Churchill`  → the brand `Cuba`
  //   `Flor de Oliva Robusto`       → the brand `Oliva`
  //   `Xikar 9mm Pull Out Punch`    → the brand `Punch`
  //
  // In each one the token is a fragment of a longer name, or of an accessory.
  // What separates them from the infix anchor that IS right — `Cigars - Padrón
  // 1964`, where a shop's merchandising prefix leads the title — is punctuation:
  // the brand leads a SEGMENT there, and a segment boundary is precisely the
  // signal `fold()` throws away. So a one-token alias must start the title or
  // start one of its segments; a multi-token alias is a strong enough claim to
  // match anywhere, unchanged.
  //
  // Lines and blends are exempt and need no flag: they are already scoped to a
  // parent AND to the token range the level above did not consume, so a short
  // key inside that window is a name, not a claim on the whole title.
  segmentStarts?: ReadonlySet<number>;
  minKeyLength?: number;
}

// Longest-window alias match over a candidate set, honouring the window order
// above.
//
// Returns null rather than a best guess. Every level below the anchor is allowed
// to be absent, and absent is never inferred (ADR-012): a title that names no
// line resolves to a brand and stops there.
export function anchorByAlias<T extends AliasCandidate>(
  tokens: string[],
  candidates: readonly T[],
  options?: AnchorOptions,
): AliasAnchor<T> | null {
  if (candidates.length === 0) return null;
  const from = options?.from ?? 0;
  const to = options?.to ?? tokens.length;
  if (to - from <= 0) return null;

  // One key → one entity. A key claimed by two candidates is dropped rather than
  // arbitrated: the 0026 collision pass already guarantees this for brands, and
  // for lines and blends — scoped to a parent, so collisions are rarer still —
  // an ambiguous key that silently picked the first row would be a confidently
  // wrong anchor, which is the exact failure ADR-012 exists to end.
  const byKey = new Map<string, T | null>();
  for (const candidate of candidates) {
    for (const alias of candidate.aliases) {
      if (alias === "") continue;
      const seen = byKey.get(alias);
      if (seen === undefined) byKey.set(alias, candidate);
      else if (seen !== null && seen.id !== candidate.id) byKey.set(alias, null);
    }
  }

  for (const window of tokenWindows(tokens.slice(from, to))) {
    const entity = byKey.get(window.key);
    if (!entity) continue;
    const start = from + window.start;
    // A refused window does not end the scan: a shorter or later window may
    // still carry a legitimate anchor, and refusing THIS claim is not a
    // statement about the others.
    if (options?.minKeyLength != null && window.key.length < options.minKeyLength) continue;
    if (options?.segmentStarts && window.length === 1 && !options.segmentStarts.has(start)) continue;
    return { entity, key: window.key, start, length: window.length };
  }
  return null;
}

// --------------------------------------------------------------------------
// Name recomposition — the `composed` half of `cigars.name_source`.
// --------------------------------------------------------------------------

export interface CanonicalNameParts {
  brand?: string | null;
  line?: string | null;
  blend?: string | null;
  vitola?: string | null;
  edition?: string | null;
}

// Compose a leaf's display name from its parts, in the order the trade says
// them: brand, line, blend, vitola, edition.
//
// THE DEDUPE IS THE POINT. Registry names repeat their ancestors constantly —
// the line `Padrón 1964 Anniversary Series` under the brand `Padrón`, the blend
// `Liga Privada No. 9` under the line `Liga Privada` — because each level is
// named the way a shop says it, standing alone. Concatenating them naively gives
// `Padrón Padrón 1964 Anniversary Series`, which is worse than the freeform
// string it replaced. So each part drops the leading run of tokens already said
// by the parts before it, compared on folded keys so `Padrón` cancels `Padron`.
//
// The rule is a SUFFIX/PREFIX OVERLAP, not a membership test, and the difference
// is a real product: with membership, `Fuente Fuente OpusX` under the brand
// `Arturo Fuente` loses BOTH Fuentes, because each one individually "has already
// been said". Matching the longest run where the tail of what has been said
// equals the head of what is about to be said drops exactly one — leaving
// `Arturo Fuente Fuente OpusX`, which is what is on the band. Same rule, same
// call: `Liga Privada No. 9` under the line `Liga Privada` contributes `No. 9`.
//
// A part that dedupes away entirely contributes nothing, which is how a blend
// named identically to its line stays out of the name instead of stuttering.
export function composeCanonicalName(parts: CanonicalNameParts): string {
  const ordered = [parts.brand, parts.line, parts.blend, parts.vitola, parts.edition];
  const said: string[] = [];
  const out: string[] = [];

  for (const raw of ordered) {
    const value = raw?.trim();
    if (!value) continue;

    const words = value.split(/\s+/).filter(Boolean);
    // A word that folds to nothing (`&`, `—`) carries no identity and therefore
    // matches nothing, which blocks the overlap at that position rather than
    // silently extending it. Conservative in the safe direction: the word stays.
    const keys = words.map((word) => fold(word));

    let overlap = 0;
    for (let k = Math.min(said.length, words.length); k >= 1; k--) {
      let same = true;
      for (let i = 0; i < k; i++) {
        const tail = said[said.length - k + i];
        if (tail === "" || tail !== keys[i]) {
          same = false;
          break;
        }
      }
      if (same) {
        overlap = k;
        break;
      }
    }

    const kept = words.slice(overlap);
    if (kept.length === 0) continue;

    out.push(kept.join(" "));
    for (const key of keys.slice(overlap)) said.push(key);
  }

  return out.join(" ");
}

// --------------------------------------------------------------------------
// Registry slugs — the mint rule and the lookup candidates
// --------------------------------------------------------------------------

// `unfiled` is not available as a registry slug (DESIGN-004 D-05). At every
// level that value means IS NULL — the population with NO row here — so a row
// wearing it would be permanently unreachable: `?line=unfiled` would select the
// cigars that have no line, never the line called Unfiled, and the group card
// for it would link to a screen excluding all of its own members.
//
// The suffix, not a refusal: "Unfiled" is a legitimate name and the catalog's
// internal vocabulary has no business vetoing it. The slug is a derived
// addressing key, so deriving a different one costs the row nothing — while
// refusing would put the reserved word in front of a curator who never chose it.
// `-1` is the conventional disambiguation suffix and cannot itself fold onto the
// reserved word; a second row that genuinely wants `unfiled-1` still hits the
// per-parent unique pre-check in taxonomy-writes.ts, which is where slug
// collisions belong.
export const RESERVED_SLUG_SUFFIX = "-1";

// MINT-TIME SLUGS FOLD ACCENTS; the stored ones on existing rows do not.
//
// `brandSlug()` collapses every non-ASCII run to a hyphen, so `Padrón` becomes
// `padr-n` and `Don Pepín García` becomes `don-pep-n-garc-a` — a URL key that is
// unreadable, unguessable and unsearchable. That transcription is load-bearing
// for the rows that already wear it (`brands.slug` is what today's brand URLs and
// `brand_images.brand_slug` resolve through), so it is not being changed. It is
// simply not what a NEW row should be minted with: nothing yet links to a slug
// that does not exist, so a row minted from here can have the clean key.
//
// Folding FIRST is the whole change: NFKD, drop the combining marks, then slug —
// the same `fold()` that produces every alias key, so `Don Pepín García` mints
// `don-pepin-garcia`. Two slug flavors therefore coexist in the registry tables,
// which is deliberate and bounded: `padr-n` and its cohort are renamed with
// redirects in Wave 5, and until then every lookup that resolves a name to a row
// probes both flavors (see `registrySlugCandidates`).
//
// A useful consequence, and the reason the alias probe did not have to grow: the
// minted slug is now itself a folded key, so it is exactly the `fold(name)` entry
// `aliasKeysFor` already emits. Slug and folded alias key COINCIDE for every new
// row, so the one GIN containment probe that resolves a spelling also resolves
// the row's own address — no second lookup against `slug`, for accented names as
// well as ASCII ones (pinned in taxonomy-writes.test.ts).
//
// The two guards still bind, and bind on the FOLDED result: the `unfiled`
// reservation this function applies (fold("Unfiled") is still `unfiled`, so it
// is still suffixed — and so is `Unfiléd`, which only reaches the reserved word
// BY folding), and migration 0026's `octet_length(slug) <= 2000` btree bound, which
// folded output cannot newly breach — it is pure `[a-z0-9-]`, one byte per
// character, from names the MCP schemas already cap at 200.
export function mintRegistrySlug(name: string): string {
  const slug = fold(name.trim());
  return slug === HIERARCHY_UNFILED ? `${slug}${RESERVED_SLUG_SUFFIX}` : slug;
}

// The slugs a name could be stored under, most-preferred first: the folded key a
// row minted today wears, and the `brandSlug()` transcription every row minted
// before this change wears. Identical for an ASCII name, which is almost all of
// them — hence the dedupe, so the common case stays a single-value lookup.
//
// Every get-or-create resolves through this rather than through one flavor. With
// one flavor it would be wrong in both directions: probing only the folded key
// would miss the live `padr-n` row and try to mint a duplicate marca (refused by
// the alias rail, so a curator sees a hard error where a reuse belongs), while
// probing only the transcription would miss a row this function itself just
// minted, making a repeat registration of an accented name fail instead of
// returning the row it created.
export function registrySlugCandidates(name: string): string[] {
  const trimmed = name.trim();
  return [...new Set([mintRegistrySlug(trimmed), brandSlug(trimmed)])].filter((slug) => slug !== "");
}
