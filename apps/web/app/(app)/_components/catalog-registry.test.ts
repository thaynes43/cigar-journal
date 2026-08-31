import { describe, expect, it } from "vitest";
import {
  CATALOG_ALL_TOKEN,
  CATALOG_DIMENSIONS,
  CATALOG_GROUP_STRINGS,
  CATALOG_LEVELS,
  CATALOG_PARENT_DIMENSION,
  CATALOG_SEGMENTS,
  DEFAULT_GROUP_SORT,
  DEFAULT_LEAF_SORT,
  GROUP_SORTS,
  LEAF_SORTS,
  NO_STORED_PREFERENCES,
  UNFILED_SLUG,
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
  clearVisibleChips,
  parseBy,
  parseSortToken,
  parseView,
  resolveCatalogState,
  segmentOf,
  tileCaption,
  visibleChipCount,
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

// Read a URL this module built back into the params Next would hand the page, so
// a round-trip assertion crosses the real boundary rather than comparing two
// state objects that never touched a query string.
const paramsOf = (url: string): CatalogSearchParams =>
  Object.fromEntries(new URL(url, "http://x").searchParams) as CatalogSearchParams;

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
    // A vitola never hides its own chip, at the root or anywhere else: it changes
    // no level, so there is no header to take the chip's place and no back link
    // to clear it. The pill IS the control.
    expect(chipsFor({ vitola: "toro" })).toEqual(["brand", "line", "blend", "vitola"]);
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

  it("carries the leaf chips and the leaf sort across a grouped URL", () => {
    // Group cards do not RENDER a chip row (D-06), but the state still rides the
    // URL: `by` is a rung of the same navigation, and a param the grouped screen
    // dropped could never come back when the drill cleared `by` on the way down.
    const url = catalogUrl(
      "/cigars",
      state({
        by: "brand",
        inStock: true,
        smoked: true,
        favorites: true,
        sort: { field: "price", dir: "asc" },
      }),
    );
    expect(url).toContain("by=brand");
    expect(url).toContain("instock=1");
    expect(url).toContain("smoked=1");
    expect(url).toContain("favorites=1");
    expect(url).toContain("sort=price%3Aasc");
  });

  it("gives the two sort vocabularies separate keys, so neither can reset the other", () => {
    const grouped = state({ by: "brand", groupSort: { field: "count", dir: "desc" } });
    const url = catalogUrl("/cigars", grouped);
    const groupedParams = new URL(url, "http://x").searchParams;
    expect(groupedParams.get("gsort")).toBe("count:desc");
    // `count` is not a leaf field and must never be written under the leaf key.
    expect(groupedParams.get("sort")).toBeNull();

    // `gsort` rides only a grouped URL — it orders nothing on a leaf grid.
    expect(catalogUrl("/cigars", state({ groupSort: { field: "count", dir: "desc" } }))).toBe(
      "/cigars",
    );

    // And the two coexist without collision.
    const both = catalogUrl(
      "/cigars",
      state({ by: "line", sort: { field: "price", dir: "desc" }, groupSort: { field: "count", dir: "asc" } }),
    );
    const params = new URL(both, "http://x").searchParams;
    expect(params.get("sort")).toBe("price:desc");
    expect(params.get("gsort")).toBe("count:asc");
    expect(resolve(Object.fromEntries(params) as CatalogSearchParams)).toEqual(
      state({ by: "line", sort: { field: "price", dir: "desc" }, groupSort: { field: "count", dir: "asc" } }),
    );
  });

  it("keeps every facet across a drill in and back out again", () => {
    // The round trip D-04 promises, run through the URL both ways rather than
    // asserted on the state objects: a param dropped by `catalogUrl` on the way
    // down cannot be restored on the way up, however faithful `drillOut` is.
    const grouped = state({
      by: "brand",
      inStock: true,
      smoked: true,
      favorites: true,
      sort: { field: "price", dir: "asc" },
    });

    const down = resolve(paramsOf(catalogUrl("/cigars", drillInto(grouped, "brand", "drew-estate"))));
    expect(down.hierarchy).toEqual({ brand: "drew-estate" });
    expect(down.inStock).toBe(true);
    expect(down.smoked).toBe(true);
    expect(down.favorites).toBe(true);
    expect(down.sort).toEqual({ field: "price", dir: "asc" });

    const up = resolve(paramsOf(catalogUrl("/cigars", drillOut(down)!.state)));
    expect(up.hierarchy).toEqual({});
    expect(up.by).toBe("brand");
    expect(up.inStock).toBe(true);
    expect(up.smoked).toBe(true);
    expect(up.favorites).toBe(true);
    expect(up.sort).toEqual({ field: "price", dir: "asc" });
  });

  it("canonicalizes the legacy ?view=brands without dropping the facets on the link", () => {
    // The page's server-side redirect, composed exactly as it runs it.
    const { state: canonical } = resolveCatalogState({
      view: undefined,
      by: "brand",
      type: "NC",
      instock: "1",
    });
    const url = catalogUrl("/cigars", canonical);
    expect(url).toContain("by=brand");
    expect(url).toContain("type=NC");
    expect(url).toContain("instock=1");
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

  it("reads each sort param against its own vocabulary and never the other's", () => {
    expect(resolve({ by: "brand", gsort: "count:asc" }).groupSort).toEqual({
      field: "count",
      dir: "asc",
    });
    // `price` is not a group sort; the grouped surface falls to its default.
    expect(resolve({ by: "brand", gsort: "price:asc" }).groupSort).toEqual(DEFAULT_GROUP_SORT);
    // `sort` is the LEAF vocabulary on every surface, grouped or not, so a leaf
    // ordering survives a grouped screen instead of being read as junk.
    expect(resolve({ by: "brand", sort: "price:desc" }).sort).toEqual({
      field: "price",
      dir: "desc",
    });
    // …and a group field left in `sort` is simply unknown there.
    expect(resolve({ by: "brand", sort: "count:asc" }).sort).toEqual(DEFAULT_LEAF_SORT);
  });

  it("accepts the explicit-default tokens as a URL-tier answer, distinct from absence", () => {
    // The distinction only a stored tier can act on: an explicit token means the
    // user chose the default, absence means they chose nothing. Nothing writes
    // these today — `catalogUrl` still omits every default.
    const stored = {
      by: "brand" as const,
      own: "want" as const,
      type: "CC" as const,
      sort: { field: "price" as const, dir: "asc" as const },
    };

    expect(parseBy(CATALOG_ALL_TOKEN)).toBe(CATALOG_ALL_TOKEN);
    const explicit = resolveCatalogState(
      { by: "all", own: "all", type: "all", sort: "name:asc" },
      stored,
    );
    expect(explicit.state.by).toBeUndefined();
    expect(explicit.state.own).toBe("all");
    expect(explicit.state.type).toBeUndefined();
    expect(explicit.state.sort).toEqual(DEFAULT_LEAF_SORT);
    expect(explicit.source).toEqual({ by: "url", own: "url", type: "url", sort: "url" });

    // The same URL with those params ABSENT falls through to the store instead.
    const absent = resolveCatalogState({}, stored);
    expect(absent.state.by).toBe("brand");
    expect(absent.state.own).toBe("want");
    expect(absent.state.type).toBe("CC");
    expect(absent.source).toEqual({ by: "stored", own: "stored", type: "stored", sort: "stored" });

    // And they are still omitted when written back out.
    expect(catalogUrl("/cigars", explicit.state)).toBe("/cigars");
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

  it("never lets a vitola own the header — it changes no level, however it was set", () => {
    // At the root, whether it arrived from the Vitolas grouping or from the chip.
    // The two produce the identical URL, so they must produce the identical
    // screen: the D-06 pill, in a chip row that is also its only exit.
    expect(drillDimension({ vitola: "toro" })).toBeNull();
    expect(drillOut(state({ hierarchy: { vitola: "toro" } }))).toBeNull();
    expect(chipsFor({ vitola: "toro" })).toContain("vitola");

    // Inside a drill the ancestor still owns the header, and the vitola is still
    // the chip — which is what makes it the only one that renders `Label · Value`.
    expect(drillDimension({ brand: "drew-estate", vitola: "toro" })).toBe("brand");
    expect(chipsFor({ brand: "drew-estate", vitola: "toro" })).toContain("vitola");
  });

  it("lands the root Vitolas grouping drill on that same pill state", () => {
    const fromGrouping = drillInto(state({ by: "vitola" }), "vitola", "toro");
    const fromChip = state({ hierarchy: { vitola: "toro" } });
    expect(fromGrouping).toEqual(fromChip);
    expect(catalogUrl("/cigars", fromGrouping)).toBe(catalogUrl("/cigars", fromChip));
  });

  it("scopes a root-level line or blend drill by the card's own parent", () => {
    // `lines.slug` is unique per BRAND. Two marcas' `Reserva` cards must open two
    // screens, not one merged screen showing more than either card counted.
    const root = state({ by: "line" });
    const one = drillInto(root, "line", "reserva", { dimension: "brand", slug: "drew-estate" });
    const two = drillInto(root, "line", "reserva", { dimension: "brand", slug: "padr-n" });
    expect(one.hierarchy).toEqual({ brand: "drew-estate", line: "reserva" });
    expect(two.hierarchy).toEqual({ brand: "padr-n", line: "reserva" });
    expect(catalogUrl("/cigars", one)).not.toBe(catalogUrl("/cigars", two));

    // Inside the brand the ancestor is already pinned, so the drill adds one param.
    const inside = drillInto(state({ hierarchy: { brand: "drew-estate" }, by: "line" }), "line", "reserva", {
      dimension: "brand",
      slug: "drew-estate",
    });
    expect(inside.hierarchy).toEqual({ brand: "drew-estate", line: "reserva" });

    // A row with no parent link cannot be scoped by one, and is not invented.
    expect(drillInto(root, "line", "reserva", null).hierarchy).toEqual({ line: "reserva" });
    // Brand and vitola have no level above them to scope by at all.
    expect(CATALOG_PARENT_DIMENSION.brand).toBeNull();
    expect(CATALOG_PARENT_DIMENSION.vitola).toBeNull();
    expect(CATALOG_PARENT_DIMENSION.line).toBe("brand");
    expect(CATALOG_PARENT_DIMENSION.blend).toBe("line");
  });
});

describe("active-filter signals", () => {
  it("counts a hierarchy param as an active chip — chip and drill are one state", () => {
    // `hasActiveChip` is the page's root test: ANY narrowing collapses the root
    // shelves, a drill included.
    expect(hasActiveChip(state())).toBe(false);
    expect(hasActiveChip(state({ hierarchy: { line: "liga-privada" } }))).toBe(true);
    expect(hasActiveChip(state({ smoked: true }))).toBe(true);
  });

  it("gates Clear all on the chips the row actually renders, never the drill", () => {
    // At the root every dimension is still a chip, so every one of them counts.
    expect(visibleChipCount(state({ hierarchy: { vitola: "t" }, inStock: true, smoked: true }))).toBe(3);

    // Inside a brand drill the brand is not a chip: one vitola plus one toggle is
    // two, and the drilled brand adds nothing to the gate.
    expect(
      visibleChipCount(state({ hierarchy: { brand: "a", vitola: "t" }, inStock: true })),
    ).toBe(2);
    // …so a drill carrying a SINGLE other chip stays below the ≥2 gate the
    // toolbar applies, rather than offering a Clear all that clears one thing.
    expect(visibleChipCount(state({ hierarchy: { brand: "a", vitola: "t" } }))).toBe(1);
    // A bare drill offers nothing to clear at all.
    expect(visibleChipCount(state({ hierarchy: { brand: "a" } }))).toBe(0);
  });

  it("clears the visible chips and leaves the drill standing", () => {
    const cleared = clearVisibleChips(
      state({
        hierarchy: { brand: "a", vitola: "t" },
        inStock: true,
        smoked: true,
        favorites: true,
        q: "toro",
        sort: { field: "price", dir: "asc" },
      }),
    );
    // The drill survives — its back link is a PUSH and the only honest exit.
    expect(cleared.hierarchy).toEqual({ brand: "a" });
    expect(cleared.inStock).toBe(false);
    expect(cleared.smoked).toBe(false);
    expect(cleared.favorites).toBe(false);
    // Clear all is a chip control: it does not touch search or sort.
    expect(cleared.q).toBe("toro");
    expect(cleared.sort).toEqual({ field: "price", dir: "asc" });

    // At the root there is no drill to spare, so every dimension the row shows
    // goes — which at the root is all four.
    expect(clearVisibleChips(state({ hierarchy: { vitola: "t" } })).hierarchy).toEqual({});
  });
});

describe("strings (§Strings)", () => {
  it("counts one cigar in the singular", () => {
    expect(CATALOG_GROUP_STRINGS.subtitle(1)).toBe("1 cigar");
    expect(CATALOG_GROUP_STRINGS.subtitle(0)).toBe("0 cigars");
    expect(CATALOG_GROUP_STRINGS.subtitle(2)).toBe("2 cigars");
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
