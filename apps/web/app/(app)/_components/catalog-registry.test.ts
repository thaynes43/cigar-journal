import { describe, expect, it } from "vitest";
import {
  CATALOG_DIMENSIONS,
  CATALOG_LEVELS,
  CATALOG_SEGMENTS,
  DEFAULT_GROUP_SORT,
  DEFAULT_LEAF_SORT,
  GROUP_SORTS,
  LEAF_SORTS,
  NO_STORED_PREFERENCES,
  UNFILED_SLUG,
  activeChipCount,
  catalogUrl,
  chipsFor,
  cleanSwitch,
  cleanSwitchWithin,
  cycleSort,
  drillDimension,
  drillInto,
  drillOut,
  groupingsFor,
  hasActiveChip,
  isGrouped,
  legacyViewDimension,
  levelOf,
  parseSortToken,
  parseView,
  resolveCatalogState,
  segmentOf,
  tileCaption,
  type CatalogSearchParams,
  type CatalogState,
} from "./catalog-registry";

// The registry IS the contract (DESIGN-004 D-04/D-07/D-09). Every one of these
// is a pure function, so the URL contract, the per-level table, the precedence
// resolver and the caption-elision rule are all tested directly rather than
// through a rendered page.

const state = (over: Partial<CatalogState> = {}): CatalogState => ({
  view: "grid",
  by: undefined,
  hierarchy: {},
  q: "",
  type: undefined,
  own: "all",
  sort: DEFAULT_LEAF_SORT,
  groupSort: DEFAULT_GROUP_SORT,
  inStock: false,
  smoked: false,
  favorites: false,
  ...over,
});

const resolve = (params: CatalogSearchParams) => resolveCatalogState(params).state;

describe("the seg (D-02)", () => {
  it("reads All · Brands · Lines · Blends · Vitolas · Ledger, in that order", () => {
    expect(CATALOG_SEGMENTS.map((s) => s.label)).toEqual([
      "All",
      "Brands",
      "Lines",
      "Blends",
      "Vitolas",
      "Ledger",
    ]);
  });

  it("treats every non-ledger view as the one grid surface", () => {
    expect(parseView(undefined)).toBe("grid");
    expect(parseView("all")).toBe("grid");
    expect(parseView("brands")).toBe("grid");
    expect(parseView("nonsense")).toBe("grid");
    expect(parseView("ledger")).toBe("ledger");
  });

  it("canonicalizes the legacy ?view=brands onto the brand grouping", () => {
    expect(legacyViewDimension("brands")).toBe("brand");
    expect(legacyViewDimension("ledger")).toBeNull();
    expect(legacyViewDimension(undefined)).toBeNull();
  });

  it("derives the active segment from the shape, not a separate param", () => {
    expect(segmentOf(state())).toBe("all");
    expect(segmentOf(state({ by: "line" }))).toBe("line");
    expect(segmentOf(state({ view: "ledger" }))).toBe("ledger");
    expect(isGrouped(state({ by: "line" }))).toBe(true);
    expect(isGrouped(state({ view: "ledger", by: "line" }))).toBe(false);
  });
});

describe("the per-level table (D-04)", () => {
  it("narrows the groupings offered as the drill descends", () => {
    expect(groupingsFor({})).toEqual(["brand", "line", "blend", "vitola"]);
    expect(groupingsFor({ brand: "drew-estate" })).toEqual(["line", "blend"]);
    expect(groupingsFor({ brand: "drew-estate", line: "liga-privada" })).toEqual(["blend"]);
    expect(groupingsFor({ blend: "no-9" })).toEqual([]);
  });

  it("keys the level off the deepest ANCESTOR, so a vitola slice is not a level", () => {
    expect(levelOf({})).toBe("root");
    expect(levelOf({ vitola: "toro" })).toBe("root");
    expect(levelOf({ brand: "drew-estate", vitola: "toro" })).toBe("brand");
    expect(levelOf({ line: "liga-privada" })).toBe("line");
    expect(levelOf({ brand: "a", line: "b", blend: "c" })).toBe("blend");
  });

  it("hides the drilled dimension's own chip — the drill IS that filter", () => {
    expect(chipsFor({})).toEqual(["brand", "line", "blend", "vitola"]);
    // Descending removes the ancestor's chip by way of the level table: setting
    // brand/line/blend changes the LEVEL, and a header replaces the chip.
    expect(chipsFor({ brand: "drew-estate" })).toEqual(["line", "blend", "vitola"]);
    expect(chipsFor({ brand: "a", line: "b" })).toEqual(["blend", "vitola"]);
    expect(chipsFor({ brand: "a", line: "b", blend: "c" })).toEqual(["vitola"]);
    // A vitola drilled from the root Vitolas screen IS the drill, so its chip hides.
    expect(chipsFor({ vitola: "toro" })).toEqual(["brand", "line", "blend"]);
  });

  it("keeps the Vitola chip when a vitola is a slice rather than the drill", () => {
    // Inside a brand drill the vitola does not change the level, so its chip
    // stays and becomes the one rendering D-06's `Label · Value` pill with a ✕.
    // Filtering chips on "has a value" would delete exactly that affordance.
    expect(chipsFor({ brand: "drew-estate", vitola: "toro" })).toEqual([
      "line",
      "blend",
      "vitola",
    ]);
  });

  it("offers the leaf sort set at every level, and defaults every level to All", () => {
    for (const level of Object.values(CATALOG_LEVELS)) {
      expect(level.sorts).toBe(LEAF_SORTS);
      // The brand drill's default flips to `line` by editing this ONE constant
      // once Wave 3 makes lines meaningful — pinned so that stays deliberate.
      expect(level.defaultBy).toBeUndefined();
    }
  });
});

describe("sort tokens and the two-state cycle (D-04)", () => {
  it("enters name asc-first and everything else desc-first", () => {
    expect(LEAF_SORTS.map((s) => [s.key, s.firstDir])).toEqual([
      ["name", "asc"],
      ["my-rating", "desc"],
      ["recently-added", "desc"],
      ["price", "desc"],
    ]);
    expect(GROUP_SORTS.map((s) => [s.key, s.firstDir])).toEqual([
      ["name", "asc"],
      ["count", "desc"],
    ]);
  });

  it("cycles two states: a new key enters best-first, the active key reverses", () => {
    const start = { field: "name", dir: "asc" } as const;
    expect(cycleSort(start, "price")).toEqual({ field: "price", dir: "desc" });
    expect(cycleSort(start, "name")).toEqual({ field: "name", dir: "desc" });
    expect(cycleSort({ field: "name", dir: "desc" }, "name")).toEqual({ field: "name", dir: "asc" });
  });

  it("parses field:dir, accepts a bare pre-wave field, and reads junk as absent", () => {
    const fields = LEAF_SORTS.map((s) => s.key);
    expect(parseSortToken("price:asc", fields, DEFAULT_LEAF_SORT)).toEqual({
      field: "price",
      dir: "asc",
    });
    // A pre-DESIGN-004 link enters at that key's best-first direction.
    expect(parseSortToken("my-rating", fields, DEFAULT_LEAF_SORT)).toEqual({
      field: "my-rating",
      dir: "desc",
    });
    for (const junk of ["", "nope", "price:sideways", "price:asc:extra", "count"]) {
      expect(parseSortToken(junk, fields, DEFAULT_LEAF_SORT)).toEqual(DEFAULT_LEAF_SORT);
    }
  });
});

describe("the URL contract (D-09)", () => {
  it("emits nothing for the default root grid", () => {
    expect(catalogUrl("/cigars", state())).toBe("/cigars");
  });

  it("round-trips a grouped, drilled, faceted, sorted, searched state", () => {
    const before = state({
      by: "blend",
      hierarchy: { brand: "drew-estate", line: "liga-privada" },
      q: "toro",
      own: "have",
      type: "NC",
      groupSort: { field: "count", dir: "desc" },
    });
    const url = catalogUrl("/cigars", before);
    const params = Object.fromEntries(new URL(url, "http://x").searchParams) as CatalogSearchParams;
    expect(resolve(params)).toEqual(before);
  });

  it("round-trips a drilled leaf grid with every chip and a reversed sort", () => {
    const before = state({
      hierarchy: { brand: "drew-estate", vitola: "toro" },
      sort: { field: "price", dir: "asc" },
      inStock: true,
      smoked: true,
      favorites: true,
    });
    const url = catalogUrl("/cigars", before);
    expect(url).toContain("sort=price%3Aasc");
    const params = Object.fromEntries(new URL(url, "http://x").searchParams) as CatalogSearchParams;
    expect(resolve(params)).toEqual(before);
  });

  it("round-trips every level's own drill, including the reserved unfiled slug", () => {
    for (const dimension of CATALOG_DIMENSIONS) {
      for (const slug of ["something", UNFILED_SLUG]) {
        const before = state({ hierarchy: { [dimension]: slug } });
        const url = catalogUrl("/cigars", before);
        expect(url).toContain(`${dimension}=${slug}`);
        const params = Object.fromEntries(
          new URL(url, "http://x").searchParams,
        ) as CatalogSearchParams;
        expect(resolve(params).hierarchy).toEqual({ [dimension]: slug });
      }
    }
  });

  it("omits every default, so a shared URL stays minimal", () => {
    expect(catalogUrl("/cigars", state({ sort: DEFAULT_LEAF_SORT }))).toBe("/cigars");
    expect(catalogUrl("/cigars", state({ by: "brand", groupSort: DEFAULT_GROUP_SORT }))).toBe(
      "/cigars?by=brand",
    );
    expect(catalogUrl("/cigars", state({ own: "all", type: undefined, q: "  " }))).toBe("/cigars");
  });

  it("gives the ledger only its own param — it is the Have detail and takes no facets", () => {
    const url = catalogUrl(
      "/cigars",
      state({ view: "ledger", q: "toro", own: "have", hierarchy: { brand: "x" } }),
    );
    expect(url).toBe("/cigars?view=ledger");
  });

  it("keeps the leaf chips off a grouped URL — group cards do not facet in v1", () => {
    const url = catalogUrl(
      "/cigars",
      state({ by: "brand", inStock: true, smoked: true, favorites: true }),
    );
    expect(url).toBe("/cigars?by=brand");
  });
});

describe("precedence (D-09, ported from library-preferences.ts)", () => {
  it("lets the URL win per-dimension over a stored preference", () => {
    const stored = {
      by: "blend" as const,
      own: "want" as const,
      type: "CC" as const,
      sort: { field: "price" as const, dir: "asc" as const },
    };
    const resolved = resolveCatalogState({ own: "have" }, stored);
    // The URL answered `own`; every other dimension still fell to the store.
    expect(resolved.state.own).toBe("have");
    expect(resolved.source.own).toBe("url");
    expect(resolved.state.type).toBe("CC");
    expect(resolved.source.type).toBe("stored");
    expect(resolved.state.sort).toEqual({ field: "price", dir: "asc" });
    expect(resolved.source.sort).toBe("stored");
  });

  it("falls through stored to the registry default, and reports which tier answered", () => {
    const resolved = resolveCatalogState({}, NO_STORED_PREFERENCES);
    expect(resolved.state.sort).toEqual(DEFAULT_LEAF_SORT);
    expect(resolved.source).toEqual({
      by: "default",
      own: "default",
      type: "default",
      sort: "default",
    });
  });

  it("ships the stored tier empty in v1, so a bare URL is pure default", () => {
    expect(NO_STORED_PREFERENCES).toEqual({});
    expect(resolve({})).toEqual(state());
  });

  it("reads a grouping the current level does not offer as absent", () => {
    // `by=brand` beneath a blend drill: that level offers no groupings at all,
    // so a stale link degrades to its flat grid rather than asking the domain
    // for a grouping it cannot answer in that scope.
    expect(resolve({ blend: "no-9", by: "brand" }).by).toBeUndefined();
    expect(resolve({ brand: "drew-estate", by: "vitola" }).by).toBeUndefined();
    expect(resolve({ brand: "drew-estate", by: "line" }).by).toBe("line");
  });

  it("reads a grouped sort token against the group vocabulary, not the leaf one", () => {
    expect(resolve({ by: "brand", sort: "count:asc" }).groupSort).toEqual({
      field: "count",
      dir: "asc",
    });
    // `price` is not a group sort; the grouped surface falls to its default.
    expect(resolve({ by: "brand", sort: "price:asc" }).groupSort).toEqual(DEFAULT_GROUP_SORT);
    // And the leaf sort is untouched while a grouping is active.
    expect(resolve({ by: "brand", sort: "count:asc" }).sort).toEqual(DEFAULT_LEAF_SORT);
  });

  it("reads invalid facet tokens as absent", () => {
    expect(resolve({ own: "sideways" }).own).toBe("all");
    expect(resolve({ type: "XX" }).type).toBeUndefined();
    expect(resolve({ brand: "   " }).hierarchy).toEqual({});
  });
});

describe("history behaviours (D-04)", () => {
  const drilled = state({
    by: "line",
    hierarchy: { brand: "drew-estate" },
    q: "toro",
    own: "have",
    type: "NC",
    sort: { field: "price", dir: "asc" },
    inStock: true,
  });

  it("clean-switches the seg: facets, sort and search drop", () => {
    const next = cleanSwitch("blend");
    expect(next).toEqual(state({ by: "blend" }));
  });

  it("keeps the drill scope across a seg switch inside it", () => {
    const next = cleanSwitchWithin(drilled.hierarchy, "blend");
    expect(next.hierarchy).toEqual({ brand: "drew-estate" });
    expect(next.by).toBe("blend");
    // …but everything that was refining the old shape is gone.
    expect(next.q).toBe("");
    expect(next.own).toBe("all");
    expect(next.inStock).toBe(false);
    expect(next.sort).toEqual(DEFAULT_LEAF_SORT);
  });

  it("preserves everything but the one new param on a drill in", () => {
    const next = drillInto(drilled, "line", "liga-privada");
    expect(next.hierarchy).toEqual({ brand: "drew-estate", line: "liga-privada" });
    expect(next.q).toBe("toro");
    expect(next.own).toBe("have");
    expect(next.type).toBe("NC");
    expect(next.sort).toEqual({ field: "price", dir: "asc" });
    expect(next.inStock).toBe(true);
    // The level below offers All by default today, so the drill opens flat.
    expect(next.by).toBeUndefined();
  });

  it("drills the Unfiled card exactly like any other group card", () => {
    const next = drillInto(state({ by: "line" }), "line", UNFILED_SLUG);
    expect(next.hierarchy).toEqual({ line: UNFILED_SLUG });
  });

  it("drills out to the group screen it came from, preserving the rest", () => {
    const out = drillOut(state({ hierarchy: { brand: "a", line: "b" }, q: "toro" }))!;
    expect(out.dimension).toBe("line");
    expect(out.state.hierarchy).toEqual({ brand: "a" });
    expect(out.state.by).toBe("line");
    expect(out.state.q).toBe("toro");
    // An ancestor still frames the screen, so the back label is its NAME.
    expect(out.parent).toBe("brand");
  });

  it("labels the back link All <plural> when Back reaches the root", () => {
    const out = drillOut(state({ hierarchy: { brand: "a" } }))!;
    expect(out.parent).toBeNull();
    expect(out.state.by).toBe("brand");
  });

  it("has nothing to drill out of at the root", () => {
    expect(drillOut(state())).toBeNull();
    expect(drillDimension({})).toBeNull();
  });

  it("lets a lone vitola own the header, but never one set by a chip inside a drill", () => {
    // Drilled from the root Vitolas screen — vitola is the drill.
    expect(drillDimension({ vitola: "toro" })).toBe("vitola");
    // Set by the Vitola chip inside a brand drill — the brand still owns it.
    expect(drillDimension({ brand: "drew-estate", vitola: "toro" })).toBe("brand");
  });
});

describe("active-filter signals", () => {
  it("counts a hierarchy param as an active chip — chip and drill are one state", () => {
    expect(hasActiveChip(state())).toBe(false);
    expect(hasActiveChip(state({ hierarchy: { line: "liga-privada" } }))).toBe(true);
    expect(hasActiveChip(state({ smoked: true }))).toBe(true);
    expect(activeChipCount(state({ hierarchy: { brand: "a", vitola: "t" }, inStock: true }))).toBe(3);
  });
});

describe("caption elision (D-07)", () => {
  const composed = {
    canonicalName: "Drew Estate Liga Privada No. 9 Toro",
    nameSource: "composed",
    structuralLine: "Liga Privada",
    structuralBlend: "No. 9",
    vitola: { name: "Toro" },
  };

  it("drops what the drill header already says", () => {
    expect(tileCaption(composed, "root")).toBe("Drew Estate Liga Privada No. 9 Toro");
    expect(tileCaption(composed, "brand")).toBe("Liga Privada · No. 9 · Toro");
    expect(tileCaption(composed, "line")).toBe("No. 9 · Toro");
    expect(tileCaption(composed, "blend")).toBe("Toro");
  });

  it("renders a freeform name raw at every level — truncated honesty beats bad parsing", () => {
    const freeform = { ...composed, nameSource: "freeform" };
    for (const level of ["root", "brand", "line", "blend"] as const) {
      expect(tileCaption(freeform, level)).toBe("Drew Estate Liga Privada No. 9 Toro");
    }
  });

  it("falls back to the full name rather than rendering an empty caption", () => {
    const bare = {
      canonicalName: "Some Composed Row",
      nameSource: "composed",
      structuralLine: null,
      structuralBlend: null,
      vitola: { name: null },
    };
    expect(tileCaption(bare, "brand")).toBe("Some Composed Row");
  });
});
