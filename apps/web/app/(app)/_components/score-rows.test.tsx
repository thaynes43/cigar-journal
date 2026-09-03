import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CatalogCigarTile, SurfaceScores } from "@cj/domain";
import { ScoreRows } from "./score-rows";
import { CigarStillTile } from "./cigar-still-tile";

// DESIGN-006's strings are a contract, and the rule underneath them is ADR-013 §1:
// no surface presents a score without the population it came from and the size of
// that population. These pin the sentences a reader actually sees.

// Rendered TEXT, not markup — the spans carry styling, the design pins the line.
const text = (html: string): string => html.replace(/<[^>]*>/g, "");

const render = (scores: SurfaceScores, blend?: string) =>
  renderToStaticMarkup(<ScoreRows scores={scores} fallbackBlendName={blend ?? null} />);

describe("ScoreRows", () => {
  it("renders both populations labelled, each with its sample count", () => {
    const html = render({
      critics: { score: 91, count: 12, scope: "blend" },
      journal: { score: 86, count: 3, scope: "blend" },
    });
    expect(text(html)).toContain("Critics 91 · 12 reviews");
    expect(text(html)).toContain("Journal 86 · 3 journals");
  });

  // THE CASE THE RULING IS ABOUT. A blend whose journal population is one person
  // must read as one person — the score is theirs, and the count says so on the
  // same line. A bare `86` here would be exactly the misrepresentation ADR-013 §1
  // forbids: one journal's rating standing in for a blend's verdict.
  it("says `Journal 86 · 1 journal` for a blend with one journal — never a bare number", () => {
    const html = render({
      critics: null,
      journal: { score: 86, count: 1, scope: "blend" },
    });
    expect(text(html)).toContain("Journal 86 · 1 journal");
    // Singular, and not the plural with a stray `s`.
    expect(text(html)).not.toContain("1 journals");
    // The score is never emitted without the label and count around it.
    expect(text(html).trim()).toBe("Journal 86 · 1 journal");
  });

  it("counts one review in the singular too", () => {
    const html = render({ critics: { score: 74, count: 1, scope: "cigar" }, journal: null });
    expect(text(html)).toContain("Critics 74 · 1 review");
    expect(text(html)).not.toContain("1 reviews");
  });

  it("renders nothing at all when both populations are empty", () => {
    expect(render({ critics: null, journal: null })).toBe("");
  });

  it("renders one row when only one population has anything to say", () => {
    const html = render({ critics: { score: 91, count: 12, scope: "cigar" }, journal: null });
    expect(text(html)).toContain("Critics 91");
    expect(html).not.toContain("Journal");
  });

  // DESIGN-006 rule 2: the scope is named whenever it is WIDER than the surface.
  describe("the widened-scope caption", () => {
    it("names the blend when the figures are the blend's", () => {
      const html = render(
        {
          critics: { score: 91, count: 12, scope: "blend" },
          journal: { score: 86, count: 3, scope: "blend" },
        },
        "Liga Privada No. 9",
      );
      expect(text(html)).toContain("Across Liga Privada No. 9");
    });

    it("stays silent when the figures are the leaf's own", () => {
      const html = render(
        {
          critics: { score: 91, count: 12, scope: "cigar" },
          journal: { score: 86, count: 3, scope: "cigar" },
        },
        "Liga Privada No. 9",
      );
      expect(html).not.toContain("Across");
    });

    // The two populations resolve their scope independently, so a leaf with its
    // own smokes but no reviews of its own is a legitimate mixed pair. Saying a
    // wider scope is in play beats saying nothing about the widened half.
    it("fires when either half widened", () => {
      const html = render(
        {
          critics: { score: 91, count: 12, scope: "blend" },
          journal: { score: 86, count: 3, scope: "cigar" },
        },
        "Liga Privada No. 9",
      );
      expect(text(html)).toContain("Across Liga Privada No. 9");
    });

    // A drill header IS its scope, so it passes no blend and gets no caption.
    it("is absent with no blend to name", () => {
      const html = render({ critics: { score: 91, count: 12, scope: "blend" }, journal: null });
      expect(html).not.toContain("Across");
    });
  });
});

// The leaf tile's half of the same rule (DESIGN-006 §Surfaces and strings): a
// critic badge only under the critic sort, and NEVER a journal badge — the tile's
// rating seal is the viewer's own per-cigar rating and must stay that.
describe("CigarStillTile scores", () => {
  const tile: CatalogCigarTile = {
    cigarId: "c1",
    canonicalName: "Liga Privada No. 9 Toro",
    brand: "Drew Estate",
    line: "Liga Privada",
    vitola: { name: "Toro", lengthInches: 6, ringGauge: 52 },
    type: "NC",
    verification: "verified",
    userSmokeCount: 2,
    userRating: 88,
    remaining: 0,
    hasProductPhoto: false,
    productPhotoId: null,
    wanted: false,
    favorited: false,
    price: null,
    critics: { score: 91, count: 12 },
    nameSource: "freeform",
    structuralBrand: null,
    structuralLine: null,
    structuralBlend: null,
  };

  const renderTile = (props: { showCriticScore?: boolean; cigar?: Partial<CatalogCigarTile> }) =>
    renderToStaticMarkup(
      <CigarStillTile
        cigar={{ ...tile, ...props.cigar }}
        showCriticScore={props.showCriticScore ?? false}
      />,
    );

  it("badges the critic score only while the grid is sorted by it", () => {
    expect(text(renderTile({ showCriticScore: true }))).toContain("Critics 91");
    expect(renderTile({ showCriticScore: false })).not.toContain("Critics");
  });

  it("never badges a journal figure, under any sort", () => {
    const html = renderTile({ showCriticScore: true });
    expect(html).not.toContain("Journal");
    // The seal is still the viewer's own rating, which is a different claim.
    expect(html).toContain("88");
  });

  it("shows no badge for a cigar nobody has reviewed, even under the critic sort", () => {
    expect(renderTile({ showCriticScore: true, cigar: { critics: null } })).not.toContain("Critics");
  });
});
