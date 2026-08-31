import type { CatalogSort, CigarType, OwnershipFacet } from "@cj/domain";

// Level registry (PRD-002 "Design conventions", extended for PRD-003 R-UNI /
// DESIGN-003, then for DESIGN-004's hierarchy): the catalog surface declares
// exactly which groupings, sorts and facets each LEVEL answers, and how the URL
// contract maps to them, in one typed place, so the toolbar, the page, and the
// tests never drift from what the domain read supports. Type-only imports from
// @cj/domain keep this client-safe; the literals are checked against the domain
// unions, and the server re-validates against the domain CATALOG_SORTS /
// ownership enums.
//
// DESIGN-004 D-01: `/cigars` is the ONE catalog surface and hierarchy state is
// URL state. The four levels — brand, line, blend, vitola — are params, each
// holding one slug, and a drill is nothing but setting one of them. Filters,
// sort and search compose with drills by construction because they are all just
// params on the same URL.

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

// The four hierarchy levels, in descent order (ADR-012: Brand → Line → Blend →
// Vitola). `vitola` is NOT a registry entity — ADR-012 rejects a global vitolas
// table — so its key is the slugged `cigars.vitola_name`; the other three key
// off their registry row's slug.
export type CatalogDimension = "brand" | "line" | "blend" | "vitola";

export const CATALOG_DIMENSIONS = ["brand", "line", "blend", "vitola"] as const satisfies readonly CatalogDimension[];

// The reserved hierarchy slug (DESIGN-004 D-05). `line=unfiled` means IS NULL at
// that level, beneath any ancestor params already on the URL — the honest
// divergence from haynesnetwork, which skips null group keys entirely and would
// therefore hide most of this catalog during the Wave 3 backfill.
export const UNFILED_SLUG = "unfiled";

// Every user-visible string a dimension owns, in one row per dimension so the
// seg, the chips, the drill header and the group cards can never disagree
// (DESIGN-004 §Strings). `param` is the URL key; `plural` heads the seg; `back`
// is the drill header's back label when the level above is the root.
export const CATALOG_DIMENSION_META = {
  brand: { param: "brand", chip: "Brand", plural: "Brands", back: "All brands" },
  line: { param: "line", chip: "Line", plural: "Lines", back: "All lines" },
  blend: { param: "blend", chip: "Blend", plural: "Blends", back: "All blends" },
  vitola: { param: "vitola", chip: "Vitola", plural: "Vitolas", back: "All vitolas" },
} as const satisfies Record<CatalogDimension, { param: string; chip: string; plural: string; back: string }>;

// The hierarchy slice of the URL: one slug per level, `unfiled` reserved.
export type CatalogHierarchy = Partial<Record<CatalogDimension, string>>;

// ---------------------------------------------------------------------------
// The seg (DESIGN-004 D-02)
// ---------------------------------------------------------------------------

// The leftmost segmented control grows from `All · Brands · Ledger` to
// `All · Brands · Lines · Blends · Vitolas · Ledger`. `all` is the flat leaf
// grid (no param); the four dimensions are grouped views (`?by=…`); `ledger` is
// the desk-work table (`?view=ledger`), untouched.
export type CatalogSegment = "all" | CatalogDimension | "ledger";

export const CATALOG_SEGMENTS: readonly { value: CatalogSegment; label: string }[] = [
  { value: "all", label: "All" },
  ...CATALOG_DIMENSIONS.map((d) => ({ value: d as CatalogSegment, label: CATALOG_DIMENSION_META[d].plural })),
  { value: "ledger", label: "Ledger" },
];

// The two page shapes behind the seg. `grid` covers both the flat leaf grid and
// every grouped view (they are one surface that swaps its cards — D-03); the
// ledger is a deliberately different shape that takes no facets.
export type CatalogView = "grid" | "ledger";

// Normalize the `view` param. Only `ledger` is explicit; everything else — a
// missing param, the legacy `?view=all`, the legacy `?view=brands` (which the
// page canonicalizes to `?by=brand`), any unknown value — is the grid.
export function parseView(param: string | undefined): CatalogView {
  return param === "ledger" ? "ledger" : "grid";
}

// The legacy `?view=brands` presentation is now the `?by=brand` grouped view
// (D-02). The page canonicalizes on load with a replace, so no history entry is
// spent and every shared pre-wave link keeps landing on the right screen.
export function legacyViewDimension(param: string | undefined): CatalogDimension | null {
  return param === "brands" ? "brand" : null;
}

// Normalize the `by` param to a grouping dimension. An unknown token reads as
// absent (the flat grid), per the D-04 refinement rule.
export function parseBy(param: string | undefined): CatalogDimension | undefined {
  return (CATALOG_DIMENSIONS as readonly string[]).includes(param ?? "")
    ? (param as CatalogDimension)
    : undefined;
}

// ---------------------------------------------------------------------------
// Sorts, with direction (DESIGN-004 D-04)
// ---------------------------------------------------------------------------

export type CatalogSortDir = "asc" | "desc";

// The leaf sort set is unchanged (DESIGN-003 §Sort row) and gains direction. The
// grouped views sort by the two facts a group card carries.
export type GroupSortField = "name" | "count";
export type CatalogSortField = CatalogSort | GroupSortField;

export interface CatalogSortToken<F extends CatalogSortField = CatalogSortField> {
  field: F;
  dir: CatalogSortDir;
}

// A sort pill enters at its BEST-FIRST direction and the second click reverses
// it (a two-state cycle, never a three-state one that can strand the grid in a
// no-sort state). `name` is asc-first; every other key is desc-first, because
// "my best rated", "newest" and "most stock" are what the key is for. `price` is
// the one that reads oddly as desc-first, so it is called out: cheapest-first is
// what a shopper wants, and DESIGN-004 pins the rule as "name asc-first, the
// rest desc-first" — deviating for one key would make the row unpredictable.
const FIRST_DIR: Record<CatalogSortField, CatalogSortDir> = {
  name: "asc",
  "my-rating": "desc",
  "recently-added": "desc",
  price: "desc",
  count: "desc",
};

export function firstDir(field: CatalogSortField): CatalogSortDir {
  return FIRST_DIR[field];
}

// One declared sort key: what it is, what the pill says, and which way the first
// click points (port of `RegistrySortOf`, library-view-registry.ts:50-55). The
// label is unchanged from DESIGN-003 — direction is the ▲/▼ glyph only, never a
// word (DESIGN-004 §Strings).
export interface RegistrySort<F extends CatalogSortField = CatalogSortField> {
  key: F;
  label: string;
  firstDir: CatalogSortDir;
}

const sortRow = <F extends CatalogSortField>(key: F, label: string): RegistrySort<F> => ({
  key,
  label,
  firstDir: FIRST_DIR[key],
});

// The leaf sort set every level offers (D-04: "leaf set" in every level row).
export const LEAF_SORTS: readonly RegistrySort<CatalogSort>[] = [
  sortRow("name", "Name"),
  sortRow("my-rating", "My rating"),
  sortRow("recently-added", "Recently added"),
  sortRow("price", "Price"),
];

// A grouped view sorts its cards by name or by member count, and takes no chips
// (group cards do not facet in v1 — D-04).
export const GROUP_SORTS: readonly RegistrySort<GroupSortField>[] = [
  sortRow("name", "Name"),
  sortRow("count", "Count"),
];

export const LEAF_SORT_FIELDS = LEAF_SORTS.map((s) => s.key);
export const GROUP_SORT_FIELDS = GROUP_SORTS.map((s) => s.key);

// The default sort for each surface. Absent from the URL, per the minimal-param
// rule; `name:asc` on both.
export const DEFAULT_LEAF_SORT: CatalogSortToken<CatalogSort> = { field: "name", dir: "asc" };
export const DEFAULT_GROUP_SORT: CatalogSortToken<GroupSortField> = { field: "name", dir: "asc" };

export function formatSortToken(sort: CatalogSortToken): string {
  return `${sort.field}:${sort.dir}`;
}

// Parse a `field:dir` sort token against the fields a surface offers. A bare
// `field` (the pre-DESIGN-004 shape, and every shared link minted before this
// wave) is accepted and enters at that field's best-first direction, so old URLs
// round-trip rather than silently resetting. An unknown field or an unknown
// direction reads as absent — the caller's default (D-04 refinement rule).
export function parseSortToken<F extends CatalogSortField>(
  param: string | undefined,
  fields: readonly F[],
  fallback: CatalogSortToken<F>,
): CatalogSortToken<F> {
  if (!param) return fallback;
  const [rawField, rawDir, ...rest] = param.split(":");
  if (rest.length > 0) return fallback;
  const field = fields.find((f) => f === rawField);
  if (field === undefined) return fallback;
  if (rawDir === undefined) return { field, dir: firstDir(field) };
  if (rawDir !== "asc" && rawDir !== "desc") return fallback;
  return { field, dir: rawDir };
}

// The two-state pill cycle: clicking an inactive key enters at its best-first
// direction; clicking the active key reverses it. One function so the leaf row
// and the grouped row behave identically.
export function cycleSort<F extends CatalogSortField>(
  active: CatalogSortToken<F>,
  field: F,
): CatalogSortToken<F> {
  return active.field === field
    ? { field, dir: active.dir === "asc" ? "desc" : "asc" }
    : { field, dir: firstDir(field) };
}

export function sameSort(a: CatalogSortToken, b: CatalogSortToken): boolean {
  return a.field === b.field && a.dir === b.dir;
}

// ---------------------------------------------------------------------------
// The per-level table (DESIGN-004 D-04)
// ---------------------------------------------------------------------------

// A level is the deepest ANCESTOR dimension pinned on the URL. `vitola` is not a
// level: it is a leaf-side slice that offers no groupings of its own and only
// ever hides its own chip, so pinning it never changes which groupings or chips
// the screen answers.
export type CatalogLevel = "root" | "brand" | "line" | "blend";

export interface CatalogLevelSpec {
  // Which grouping dimensions this level offers in the seg.
  groupings: readonly CatalogDimension[];
  // The grouping a DRILL INTO this level retargets `by` to (D-04). `undefined`
  // means All — the flat leaf grid. Every level defaults to All today; the
  // brand drill's default flips to `line` by editing this ONE constant once the
  // Wave 3 backfill makes lines meaningful. Revisit then, not before.
  defaultBy: CatalogDimension | undefined;
  // ONLY the sort keys this level can answer — the single enforcement point, so
  // no control for a sort the domain cannot serve at this level can ship (port:
  // registryFor(), library-view-registry.ts:559-562). Identical at every level
  // today; the field exists so a level can narrow it without a new component.
  sorts: readonly RegistrySort<CatalogSort>[];
  // The hierarchy chips this level offers. The drilled dimension's own chip is
  // absent by construction — the drill IS that filter (port:
  // books-browser.tsx's drilled-facet suppression).
  chips: readonly CatalogDimension[];
}

export const CATALOG_LEVELS: Record<CatalogLevel, CatalogLevelSpec> = {
  root: {
    groupings: ["brand", "line", "blend", "vitola"],
    defaultBy: undefined,
    sorts: LEAF_SORTS,
    chips: ["brand", "line", "blend", "vitola"],
  },
  brand: {
    groupings: ["line", "blend"],
    defaultBy: undefined,
    sorts: LEAF_SORTS,
    chips: ["line", "blend", "vitola"],
  },
  line: {
    groupings: ["blend"],
    defaultBy: undefined,
    sorts: LEAF_SORTS,
    chips: ["blend", "vitola"],
  },
  blend: {
    groupings: [],
    defaultBy: undefined,
    sorts: LEAF_SORTS,
    chips: ["vitola"],
  },
};

// The deepest ancestor level pinned on the URL. Ancestors above a pinned level
// are irrelevant to this answer: `?line=liga-privada` alone is a line drill,
// exactly as `?brand=drew-estate&line=liga-privada` is.
export function levelOf(hierarchy: CatalogHierarchy): CatalogLevel {
  if (hierarchy.blend) return "blend";
  if (hierarchy.line) return "line";
  if (hierarchy.brand) return "brand";
  return "root";
}

// The chips a state actually renders: the level's offered set, minus the DRILLED
// dimension — the drill is that filter, so a chip for it would be a second
// control over one value, and the drill header is already displaying it (with
// its back link as the clear).
//
// Minus the drilled dimension, NOT minus every dimension that has a value, and
// the difference is the whole reason `vitola` exists as a chip. Setting brand,
// line or blend CHANGES the level, so the level table stops offering that chip
// by itself and a header takes over. Setting a vitola does not change the level,
// so its chip stays — and becomes the one that renders D-06's `Label · Value`
// pill with a ✕. Filtering on "has a value" would delete exactly that.
export function chipsFor(hierarchy: CatalogHierarchy): readonly CatalogDimension[] {
  const drilled = drillDimension(hierarchy);
  return CATALOG_LEVELS[levelOf(hierarchy)].chips.filter((d) => d !== drilled);
}

// The groupings a state offers in the seg. A grouped view offers the same set as
// its level — switching `by` is a lateral move, not a descent.
export function groupingsFor(hierarchy: CatalogHierarchy): readonly CatalogDimension[] {
  return CATALOG_LEVELS[levelOf(hierarchy)].groupings;
}

// ---------------------------------------------------------------------------
// Tile captions inside a drill (DESIGN-004 D-07)
// ---------------------------------------------------------------------------

// The parts that sit BELOW each level — what a composed name still needs to say
// once the header above it has already said the rest.
const PARTS_BELOW: Record<CatalogLevel, readonly ("line" | "blend" | "vitola")[]> = {
  root: [],
  brand: ["line", "blend", "vitola"],
  line: ["blend", "vitola"],
  blend: ["vitola"],
};

// What a tile's caption reads inside a drill. A `composed` name is a projection
// of its parts, so inside Liga Privada the tile says `No. 9 · Toro` rather than
// repeating `Drew Estate Liga Privada` on every card in the grid.
//
// A `freeform` row ALWAYS renders `canonical_name` raw — the string is
// authoritative for those rows and there are no trustworthy parts to subtract,
// so truncated honesty beats wrong parsing. Same fallback if a composed row's
// parts below the level are all empty: better the full name than an empty
// caption.
export function tileCaption(
  cigar: {
    canonicalName: string;
    nameSource: string;
    structuralLine: string | null;
    structuralBlend: string | null;
    vitola: { name: string | null };
  },
  level: CatalogLevel,
): string {
  if (cigar.nameSource !== "composed" || level === "root") return cigar.canonicalName;
  const parts = PARTS_BELOW[level]
    .map((part) =>
      part === "line" ? cigar.structuralLine : part === "blend" ? cigar.structuralBlend : cigar.vitola.name,
    )
    .filter((value): value is string => Boolean(value && value.trim()));
  return parts.length > 0 ? parts.join(" · ") : cigar.canonicalName;
}

// ---------------------------------------------------------------------------
// Grid geometry
// ---------------------------------------------------------------------------

// The shared fluid catalog grid (DESIGN-003 §Tile grid-mechanics): fill columns
// with ~160px tiles so they multiply rather than inflate (`auto-fill`, never
// `auto-fit`), with a fixed 3-col floor ≤480px so minmax never overflows a phone.
// Every catalog grid — the cigar grid, its skeleton, the group-card wall, and the
// brand-page line/loose grids — imports this ONE string so their geometry agrees.
// DESIGN-004 D-03 keeps group cards on this grid rather than haynesnetwork's
// 2:3: consistency inside this app wins over fidelity to the reference.
export const CATALOG_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4 max-[480px]:grid-cols-3";

// ---------------------------------------------------------------------------
// Facets that are not hierarchy
// ---------------------------------------------------------------------------

export type CatalogTypeFacet = CigarType | "all";

export const CATALOG_TYPE_FACETS: readonly { value: CatalogTypeFacet; label: string }[] = [
  { value: "all", label: "Both" },
  { value: "NC", label: "NC" },
  { value: "CC", label: "CC" },
];

// The exclusive ownership facet (DESIGN-002 approved strings). `all` carries no
// URL param — like the type facet's default, it is the absence of a filter.
export const CATALOG_OWNERSHIP_FACETS: readonly { value: OwnershipFacet; label: string }[] = [
  { value: "all", label: "All" },
  { value: "have", label: "Have" },
  { value: "want", label: "Want" },
  { value: "dont", label: "Don't have" },
];

// The boolean filter chips (DESIGN-003 §IA) plus the hierarchy chip labels
// (DESIGN-004 §Strings). `Clear all` is the one addition DESIGN-003 flagged and
// DESIGN-004 keeps: our chips are one-tap toggles, so it earns its place.
export const CATALOG_CHIPS = {
  inStock: "In stock",
  smoked: "Smoked",
  favorites: "Favorites",
  clearAll: "Clear all",
} as const;

// The group card's own strings (DESIGN-004 §Strings). `{n} cigars` is the group
// subtitle and the Unfiled card's subtitle both; the badges use the leaf tile's
// row/cap/tone grammar and are absent when zero.
export const CATALOG_GROUP_STRINGS = {
  unfiled: "Unfiled",
  subtitle: (n: number): string => `${n} cigars`,
  inHumidor: (n: number): string => `${n} in humidor`,
  wanted: (n: number): string => `${n} wanted`,
} as const;

// ---------------------------------------------------------------------------
// The full slice state
// ---------------------------------------------------------------------------

export interface CatalogState {
  view: CatalogView;
  by?: CatalogDimension;
  hierarchy: CatalogHierarchy;
  q: string;
  type?: CigarType;
  own: OwnershipFacet;
  // The leaf grid's sort. A grouped view sorts its cards with `groupSort`; the
  // two are separate params-in-one so switching `by` never smuggles `count` into
  // a leaf ordering the domain cannot answer.
  sort: CatalogSortToken<CatalogSort>;
  groupSort: CatalogSortToken<GroupSortField>;
  inStock: boolean;
  smoked: boolean;
  favorites: boolean;
}

// The seg value a state renders as active.
export function segmentOf(state: Pick<CatalogState, "view" | "by">): CatalogSegment {
  return state.view === "ledger" ? "ledger" : (state.by ?? "all");
}

// True when the surface is showing group cards rather than leaf tiles.
export function isGrouped(state: Pick<CatalogState, "view" | "by">): boolean {
  return state.view === "grid" && state.by !== undefined;
}

// True when any filter narrows the grid — a hierarchy param, a boolean chip, an
// ownership/type facet, or a search. The same "non-root" signal the rails carry:
// a narrowed grid collapses the root shelves but is never emptied of content.
// Pure, so the page's `atRoot` test and the toolbar's `Clear all` gate read it
// identically.
export function hasActiveChip(
  state: Pick<CatalogState, "hierarchy" | "inStock" | "smoked" | "favorites">,
): boolean {
  return (
    CATALOG_DIMENSIONS.some((d) => Boolean(state.hierarchy[d])) ||
    state.inStock ||
    state.smoked ||
    state.favorites
  );
}

export function activeChipCount(
  state: Pick<CatalogState, "hierarchy" | "inStock" | "smoked" | "favorites">,
): number {
  return (
    CATALOG_DIMENSIONS.filter((d) => Boolean(state.hierarchy[d])).length +
    (state.inStock ? 1 : 0) +
    (state.smoked ? 1 : 0) +
    (state.favorites ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// The URL contract (DESIGN-004 D-09)
// ---------------------------------------------------------------------------
//
//   ?by=brand|line|blend|vitola      grouped view (absent = flat All)
//   ?view=ledger                     the ledger table (unchanged)
//   ?brand= ?line= ?blend= ?vitola=  hierarchy state — drill or chip
//      value `unfiled`               IS NULL at that level (D-05)
//   ?sort=field:dir                  leaf sorts + direction (absent = name:asc)
//   ?q= ?own= ?type= ?instock= ?smoked= ?favorites=   unchanged
//
// Build the target URL for a slice state, emitting only the params the active
// surface answers and omitting every default so a shared URL stays minimal. Pure,
// so the contract is unit-tested directly.
export function catalogUrl(pathname: string, next: CatalogState): string {
  const params = new URLSearchParams();
  if (next.view === "ledger") {
    // The ledger is the Have detail and takes no facets (DESIGN-002 §IA).
    params.set("view", "ledger");
    return `${pathname}?${params.toString()}`;
  }

  if (next.by) params.set("by", next.by);

  // Hierarchy params ride every grid surface — a grouped view is still scoped by
  // the levels above it (`?brand=drew-estate&by=line` is Drew Estate's lines).
  for (const dimension of CATALOG_DIMENSIONS) {
    const slug = next.hierarchy[dimension]?.trim();
    if (slug) params.set(CATALOG_DIMENSION_META[dimension].param, slug);
  }

  if (next.q.trim()) params.set("q", next.q.trim());
  if (next.own !== "all") params.set("own", next.own);
  if (next.type) params.set("type", next.type);

  if (next.by) {
    // Grouped: the cards carry their own two-key sort and take no chips.
    if (!sameSort(next.groupSort, DEFAULT_GROUP_SORT)) {
      params.set("sort", formatSortToken(next.groupSort));
    }
  } else {
    if (!sameSort(next.sort, DEFAULT_LEAF_SORT)) params.set("sort", formatSortToken(next.sort));
    // The boolean chips are presence flags (present=on, absent=off) — the "1" is
    // a placeholder, the parse only tests presence.
    if (next.inStock) params.set("instock", "1");
    if (next.smoked) params.set("smoked", "1");
    if (next.favorites) params.set("favorites", "1");
  }

  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

// The raw query params a catalog URL can carry, as Next hands them over.
export interface CatalogSearchParams {
  view?: string;
  by?: string;
  brand?: string;
  line?: string;
  blend?: string;
  vitola?: string;
  q?: string;
  type?: string;
  own?: string;
  sort?: string;
  instock?: string;
  smoked?: string;
  favorites?: string;
}

// ---------------------------------------------------------------------------
// Precedence (DESIGN-004 D-09, ported from library-preferences.ts)
// ---------------------------------------------------------------------------

// URL wins per-dimension → stored preference → default, and a URL-derived
// resolution is NEVER written back. v1 has no stored preferences (DESIGN-003's
// URL-only rule stands), so the resolver ships with this tier empty and
// preferences can land later without a contract change.
export interface StoredCatalogPreferences {
  by?: CatalogDimension;
  own?: OwnershipFacet;
  type?: CigarType;
  sort?: CatalogSortToken<CatalogSort>;
}

export const NO_STORED_PREFERENCES: StoredCatalogPreferences = {};

// Which tier answered each preference-bearing dimension. The point of tracking
// it is the second half of the rule: a preference writer may persist only what
// the USER chose, never a value this resolver derived from a shared URL — which
// is how a link someone opened once would otherwise become their default.
export type PreferenceSource = "url" | "stored" | "default";

export interface ResolvedCatalogState {
  state: CatalogState;
  source: Record<"by" | "own" | "type" | "sort", PreferenceSource>;
}

function pick<T>(
  fromUrl: T | undefined,
  stored: T | undefined,
  fallback: T,
): { value: T; source: PreferenceSource } {
  if (fromUrl !== undefined) return { value: fromUrl, source: "url" };
  if (stored !== undefined) return { value: stored, source: "stored" };
  return { value: fallback, source: "default" };
}

// Read one hierarchy slug. Trimmed; blank reads as absent. `unfiled` is passed
// through as the reserved slug — the domain, not the parser, turns it into an
// IS NULL at that level.
function parseSlug(param: string | undefined): string | undefined {
  const value = param?.trim();
  return value ? value : undefined;
}

// Resolve the whole slice state from the URL, a stored-preference tier, and the
// registry defaults. The single place the contract is enforced: the page, the
// toolbar and the tests all read this rather than re-deriving params.
export function resolveCatalogState(
  params: CatalogSearchParams,
  stored: StoredCatalogPreferences = NO_STORED_PREFERENCES,
): ResolvedCatalogState {
  const view = parseView(params.view);

  const hierarchy: CatalogHierarchy = {};
  for (const dimension of CATALOG_DIMENSIONS) {
    const slug = parseSlug(params[dimension]);
    if (slug) hierarchy[dimension] = slug;
  }

  // A grouping the current level does not offer reads as absent, so a stale link
  // (`?blend=…&by=brand`) degrades to that level's flat grid rather than asking
  // the domain for a grouping it cannot answer beneath that scope.
  const offered = groupingsFor(hierarchy);
  const urlBy = parseBy(params.by);
  const by = pick(
    urlBy !== undefined && offered.includes(urlBy) ? urlBy : undefined,
    stored.by !== undefined && offered.includes(stored.by) ? stored.by : undefined,
    CATALOG_LEVELS[levelOf(hierarchy)].defaultBy,
  );

  const urlOwn =
    params.own === "have" || params.own === "want" || params.own === "dont" || params.own === "all"
      ? params.own
      : undefined;
  const own = pick<OwnershipFacet>(urlOwn, stored.own, "all");

  const urlType: CigarType | undefined =
    params.type === "NC" || params.type === "CC" ? params.type : undefined;
  const type = pick<CigarType | undefined>(
    params.type !== undefined ? urlType : undefined,
    stored.type,
    undefined,
  );

  // One `sort` param serves both surfaces; which vocabulary it is read against
  // depends on whether a grouping is active. A token from the other surface is
  // an unknown field there and reads as that surface's default.
  const grouped = view === "grid" && by.value !== undefined;
  const urlSort = params.sort
    ? parseSortToken(params.sort, LEAF_SORT_FIELDS, DEFAULT_LEAF_SORT)
    : undefined;
  const sort = pick<CatalogSortToken<CatalogSort>>(
    params.sort && !grouped ? urlSort : undefined,
    stored.sort,
    DEFAULT_LEAF_SORT,
  );
  const groupSort = grouped
    ? parseSortToken(params.sort, GROUP_SORT_FIELDS, DEFAULT_GROUP_SORT)
    : DEFAULT_GROUP_SORT;

  return {
    state: {
      view,
      by: by.value,
      hierarchy,
      q: (params.q ?? "").trim(),
      type: type.value,
      own: own.value,
      sort: sort.value,
      groupSort,
      inStock: params.instock !== undefined,
      smoked: params.smoked !== undefined,
      favorites: params.favorites !== undefined,
    },
    source: { by: by.source, own: own.source, type: type.source, sort: sort.source },
  };
}

// ---------------------------------------------------------------------------
// History behaviours (DESIGN-004 D-04)
// ---------------------------------------------------------------------------
//
// Three, and they are the whole navigation model:
//
//   dimension/view switch  → clean PUSH: facets, sort and search drop; the new
//                            shape starts fresh.
//   drill in / drill out   → preserving PUSH: exactly one hierarchy param moves
//                            and everything else on the URL survives.
//   refinement             → REPLACE: a facet, sort or search edit, scroll:false.

// A clean slate for a seg switch: the chosen shape, nothing else. Hierarchy goes
// too — switching the grouping dimension is a lateral move at the ROOT, not
// inside a drill (a drilled screen offers only the groupings its level answers,
// and switching between those keeps the drill; see cleanSwitchWithin).
export function cleanSwitch(segment: CatalogSegment): CatalogState {
  return {
    view: segment === "ledger" ? "ledger" : "grid",
    by: segment === "ledger" || segment === "all" ? undefined : segment,
    hierarchy: {},
    q: "",
    type: undefined,
    own: "all",
    sort: DEFAULT_LEAF_SORT,
    groupSort: DEFAULT_GROUP_SORT,
    inStock: false,
    smoked: false,
    favorites: false,
  };
}

// The same clean switch INSIDE a drill: the hierarchy scope is the screen you
// are on, so it survives; the facets, sort and search that were refining the old
// shape do not. Without this, switching Lines→Blends inside a brand would throw
// you back to the root — the "drop everything" rule read one level too broadly.
export function cleanSwitchWithin(hierarchy: CatalogHierarchy, segment: CatalogSegment): CatalogState {
  return { ...cleanSwitch(segment), hierarchy: { ...hierarchy } };
}

// Drill in: add exactly one hierarchy param and retarget `by` to the level
// below's registry default; everything else survives. `slug` may be UNFILED_SLUG
// — the Unfiled card drills the same way any group card does.
export function drillInto(
  state: CatalogState,
  dimension: CatalogDimension,
  slug: string,
): CatalogState {
  const hierarchy: CatalogHierarchy = { ...state.hierarchy, [dimension]: slug };
  return { ...state, hierarchy, by: CATALOG_LEVELS[levelOf(hierarchy)].defaultBy };
}

// Which dimension the drill header is ABOUT — the one whose group screen Back
// returns to.
//
// It is not simply "the deepest pinned param", and the difference matters. A
// `vitola` can be pinned two ways: by drilling the root Vitolas screen, or by the
// Vitola CHIP inside a brand drill. The first is a drill and owns the header; the
// second is a refinement of the brand screen, whose header must keep saying
// `Drew Estate`. So the ancestor level wins whenever there is one, and a lone
// `vitola` claims the header only at the root — which is exactly the case where
// it was reached by drilling.
export function drillDimension(hierarchy: CatalogHierarchy): CatalogDimension | null {
  const level = levelOf(hierarchy);
  if (level !== "root") return level;
  return hierarchy.vitola ? "vitola" : null;
}

// Drill out: drop that one param and land back on the group screen that showed
// it, preserving everything else on the URL (D-04's preserving push, run in
// reverse). Returns null at the root, where there is nothing to leave.
export function drillOut(
  state: CatalogState,
): { state: CatalogState; dimension: CatalogDimension; parent: CatalogDimension | null } | null {
  const dimension = drillDimension(state.hierarchy);
  if (dimension === null) return null;
  const hierarchy: CatalogHierarchy = { ...state.hierarchy };
  delete hierarchy[dimension];
  return {
    state: { ...state, hierarchy, by: dimension },
    dimension,
    // Which level still frames the screen Back lands on. Non-null means the back
    // label is that entity's NAME (leaving Liga Privada under a Drew Estate drill
    // goes back to Drew Estate); null means the label is `All <plural>`. The name
    // itself comes from the caller, which has the resolved rows.
    parent: drillDimension(hierarchy),
  };
}
