import { describe, expect, it } from "vitest";
import {
  CATALOG_ALL_SORTS,
  CATALOG_VIEWS,
  catalogUrl,
  parseView,
  type CatalogState,
} from "./catalog-registry";

// The DESIGN-003 URL contract: the unified grid is the default (no `view` param),
// `brands`/`ledger` are explicit presentations, and legacy `?view=all` normalizes
// to the default. The toolbar drives every navigation through these pure helpers,
// so pinning them here pins the contract itself.

const base: CatalogState = { view: "all", q: "", own: "all", sort: "name" };

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

  it("carries q/own/type to Brands but drops sort", () => {
    const url = catalogUrl("/cigars", {
      view: "brands",
      q: "oliva",
      type: "CC",
      own: "want",
      sort: "price",
    });
    expect(url).toContain("view=brands");
    expect(url).toContain("q=oliva");
    expect(url).toContain("type=CC");
    expect(url).toContain("own=want");
    expect(url).not.toContain("sort=");
  });

  it("drops every facet on Ledger, carrying only the view", () => {
    const url = catalogUrl("/cigars", {
      view: "ledger",
      q: "oliva",
      type: "CC",
      own: "want",
      sort: "price",
    });
    expect(url).toBe("/cigars?view=ledger");
  });
});
