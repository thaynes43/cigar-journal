import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CatalogGroupCard as GroupCardData } from "@cj/domain";
import { CatalogGroupCard, CatalogUnfiledCard } from "./catalog-group-card";

// The group card's anatomy is a contract (DESIGN-004 D-03), so the parts that
// carry meaning — the fan ladder, the never-fake-art rule, the badge grammar and
// the parent sub-label — are pinned here rather than left to a visual review.

const base: GroupCardData = {
  dimension: "line",
  id: "11111111-1111-4111-8111-111111111111",
  slug: "liga-privada",
  name: "Liga Privada",
  parentName: "Drew Estate",
  parentSlug: "drew-estate",
  cigarCount: 12,
  inHumidorCount: 0,
  wantedCount: 0,
  covers: [],
};

const cover = (n: number) => ({ cigarId: `cigar-${n}`, productPhotoId: `photo-${n}` });

const render = (card: Partial<GroupCardData>) =>
  renderToStaticMarkup(<CatalogGroupCard card={{ ...base, ...card }} href="/cigars?line=liga-privada" />);

describe("CatalogGroupCard", () => {
  it("fans up to three covers on the ported transform ladder", () => {
    const html = render({ covers: [cover(1), cover(2), cover(3)] });
    expect(html).toContain("-rotate-[7deg]");
    expect(html).toContain("rotate-[6deg]");
    expect(html).toContain("-rotate-[1deg]");
    // Ascending z-index, so the last cover reads as the front of a stack.
    expect(html).toContain("z-[1]");
    expect(html).toContain("z-[2]");
    expect(html).toContain("z-[3]");
  });

  it("centres a single cover instead of leaving a lopsided fan", () => {
    const html = render({ covers: [cover(1)] });
    expect(html).not.toContain("rotate-[");
    expect(html).toContain("left-[14%]");
  });

  it("fingerprints each cover so a replaced photo is seen at once", () => {
    expect(render({ covers: [cover(7)] })).toContain(
      "/api/product-photos/cigar-7/thumb?v=photo-7",
    );
  });

  it("falls back to the monogram tile when no member has a photo", () => {
    const html = render({ covers: [] });
    expect(html).not.toContain("<img");
    // BandTile's hashed wrapper-shade ground — a letterform, never fake art.
    expect(html).toContain("--tobacco-");
  });

  it("keeps the catalog's 3:4 frame, not the reference app's 2:3", () => {
    expect(render({})).toContain("aspect-[3/4]");
  });

  it("carries the parent as a sub-label, and drops it once the parent is pinned", () => {
    expect(render({ parentName: "Drew Estate" })).toContain("Drew Estate");
    expect(render({ parentName: null })).not.toContain("Drew Estate");
  });

  it("subtitles the member count, and counts one in the singular", () => {
    expect(render({ cigarCount: 12 })).toContain("12 cigars");
    expect(render({ cigarCount: 1 })).toContain("1 cigar<");
  });

  it("renders each badge only when non-zero, in the leaf tile's tone grammar", () => {
    const none = render({ inHumidorCount: 0, wantedCount: 0 });
    expect(none).not.toContain("in humidor");
    expect(none).not.toContain("wanted");

    const both = render({ inHumidorCount: 4, wantedCount: 2 });
    expect(both).toContain("4 in humidor");
    expect(both).toContain("2 wanted");
  });

  it("drills through the href it is given", () => {
    expect(render({})).toContain('href="/cigars?line=liga-privada"');
  });
});

describe("CatalogUnfiledCard", () => {
  const unfiled = (over: { count?: number; inHumidorCount?: number; wantedCount?: number } = {}) =>
    renderToStaticMarkup(
      <CatalogUnfiledCard
        count={over.count ?? 530}
        inHumidorCount={over.inHumidorCount ?? 0}
        wantedCount={over.wantedCount ?? 0}
        href="/cigars?line=unfiled"
      />,
    );

  it("labels itself Unfiled and counts what is missing", () => {
    const html = unfiled({ count: 530 });
    expect(html).toContain("Unfiled");
    expect(html).toContain("530 cigars");
    expect(unfiled({ count: 1 })).toContain("1 cigar<");
  });

  it("drills through the reserved unfiled slug", () => {
    expect(unfiled()).toContain('href="/cigars?line=unfiled"');
  });

  it("never borrows a brand's identity for the absence of one", () => {
    // No hashed tobacco ground here: giving "no line" its own house colour would
    // make a gap look like a group.
    expect(unfiled()).not.toContain("--tobacco-");
  });

  it("still badges what the gap holds", () => {
    expect(unfiled({ inHumidorCount: 3, wantedCount: 1 })).toContain("3 in humidor");
    expect(unfiled({ inHumidorCount: 3, wantedCount: 1 })).toContain("1 wanted");
  });
});
