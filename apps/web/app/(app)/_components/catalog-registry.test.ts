import { describe, expect, it } from "vitest";
import {
  CATALOG_ALL_SORTS,
  CATALOG_VIEWS,
  catalogUrl,
  hasActiveChip,
  parseView,
  type CatalogState,
} from "./catalog-registry";

// The DESIGN-003 URL contract: the unified grid is the default (no `view` param),
// `brands`/`ledger` are explicit presentations, and legacy `?view=all` normalizes
// to the default. The toolbar drives every navigation through these pure helpers,
// so pinning them here pins the contract itself.

const base: CatalogState = {
  view: "all",
  q: "",
  own: "all",
  sort: "name",
  inStock: false,
  smoked: false,
  favorites: false,
};

describe("parseView", () => {
  it("defaults a missing param to the unified grid", () => {
    expect(parseView(undefined)).toBe("all");
  });

  it("normalizes the legacy ?view=all to the default grid", () => {
    expect(parseView("all")).toBe("all");
  });

  it("normalizes any unknown value to the default grid", () => {
    expect(parseView("posters")).toBe("all");
    expect(parseView("")).toBe("all");
  });

  it("keeps the two explicit presentations", () => {
    expect(parseView("brands")).toBe("brands");
    expect(parseView("ledger")).toBe("ledger");
  });
});

describe("catalog view registry", () => {
  it("orders All (default) · Brands · Ledger", () => {
    expect(CATALOG_VIEWS.map((v) => v.value)).toEqual(["all", "brands", "ledger"]);
    expect(CATALOG_VIEWS.map((v) => v.label)).toEqual(["All", "Brands", "Ledger"]);
  });

  it("carries the un-deferred Price sort", () => {
    expect(CATALOG_ALL_SORTS.map((s) => s.value)).toContain("price");
  });
});

describe("catalogUrl", () => {
  it("emits no params for the bare default grid", () => {
    expect(catalogUrl("/cigars", base)).toBe("/cigars");
  });

  it("emits no `view` param for the default grid, only its facets/sort", () => {
    const url = catalogUrl("/cigars", { ...base, q: "padron", type: "NC", own: "have", sort: "price" });
    expect(url).not.toContain("view=");
    expect(url).toContain("q=padron");
    expect(url).toContain("type=NC");
    expect(url).toContain("own=have");
    expect(url).toContain("sort=price");
  });

  it("omits the default sort (name) from the grid URL", () => {
    expect(catalogUrl("/cigars", { ...base, sort: "name" })).toBe("/cigars");
    expect(catalogUrl("/cigars", { ...base, sort: "my-rating" })).toBe("/cigars?sort=my-rating");
  });

  it("carries q/own/type to Brands but drops sort and chips", () => {
    const url = catalogUrl("/cigars", {
      view: "brands",
      q: "oliva",
      type: "CC",
      own: "want",
      sort: "price",
      brand: "Padron",
      inStock: true,
      smoked: true,
      favorites: true,
    });
    expect(url).toContain("view=brands");
    expect(url).toContain("q=oliva");
    expect(url).toContain("type=CC");
    expect(url).toContain("own=want");
    expect(url).not.toContain("sort=");
    // Chips are grid-only — Brands drops all four.
    expect(url).not.toContain("brand=");
    expect(url).not.toContain("instock");
    expect(url).not.toContain("smoked");
    expect(url).not.toContain("favorites");
  });

  it("drops every facet on Ledger, carrying only the view", () => {
    const url = catalogUrl("/cigars", {
      view: "ledger",
      q: "oliva",
      type: "CC",
      own: "want",
      sort: "price",
      brand: "Padron",
      inStock: true,
      smoked: true,
      favorites: true,
    });
    expect(url).toBe("/cigars?view=ledger");
  });
});

describe("catalogUrl filter chips (grid-only, DESIGN-003 wave 6)", () => {
  it("emits no chip params when every chip is off", () => {
    expect(catalogUrl("/cigars", base)).toBe("/cigars");
  });

  it("carries the exact brand value on the grid", () => {
    const url = catalogUrl("/cigars", { ...base, brand: "Arturo Fuente" });
    expect(url).toContain("brand=Arturo+Fuente");
  });

  it("omits an empty/whitespace brand", () => {
    expect(catalogUrl("/cigars", { ...base, brand: "   " })).toBe("/cigars");
  });

  it("emits each boolean chip as a presence flag when on, nothing when off", () => {
    expect(catalogUrl("/cigars", { ...base, inStock: true })).toBe("/cigars?instock=1");
    expect(catalogUrl("/cigars", { ...base, smoked: true })).toBe("/cigars?smoked=1");
    expect(catalogUrl("/cigars", { ...base, favorites: true })).toBe("/cigars?favorites=1");
  });

  it("composes chips with q/own/type/sort on the grid", () => {
    const url = catalogUrl("/cigars", {
      ...base,
      q: "maduro",
      own: "have",
      type: "NC",
      sort: "price",
      brand: "Oliva",
      inStock: true,
      smoked: true,
      favorites: true,
    });
    expect(url).toContain("q=maduro");
    expect(url).toContain("own=have");
    expect(url).toContain("type=NC");
    expect(url).toContain("sort=price");
    expect(url).toContain("brand=Oliva");
    expect(url).toContain("instock=1");
    expect(url).toContain("smoked=1");
    expect(url).toContain("favorites=1");
  });
});

describe("hasActiveChip", () => {
  it("is false when no chip is set", () => {
    expect(hasActiveChip(base)).toBe(false);
  });

  it("is true for any single active chip", () => {
    expect(hasActiveChip({ ...base, brand: "Padron" })).toBe(true);
    expect(hasActiveChip({ ...base, inStock: true })).toBe(true);
    expect(hasActiveChip({ ...base, smoked: true })).toBe(true);
    expect(hasActiveChip({ ...base, favorites: true })).toBe(true);
  });
});
