import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrandShelf } from "@cj/domain";
import { BrandPosterTile } from "./brand-poster-tile";

// The wall's cover precedence (issue 127): a member product photo, then the
// brand's Wikimedia cover, then the monogram — and a Wikimedia cover NEVER
// renders without the credit its licence requires.

const base: BrandShelf = {
  brand: "Montecristo",
  slug: "montecristo",
  cigarCount: 4,
  lineCount: 2,
  types: ["CC"],
  coverCigarId: null,
  coverProductPhotoId: null,
  brandImage: null,
};

const cover = {
  // The stored object's version, not the row id — see coverVersion in @cj/domain.
  version: "11111111-1111-1111-1111-111111111111",
  creditLine: "Ana Example · CC BY-SA 4.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:M.jpg",
};

describe("BrandPosterTile", () => {
  it("renders the brand cover with its plain-text credit when no member photo exists", () => {
    const html = renderToStaticMarkup(<BrandPosterTile shelf={{ ...base, brandImage: cover }} />);
    expect(html).toContain(`/api/brand-images/montecristo/thumb?v=${cover.version}`);
    expect(html).toContain("Ana Example · CC BY-SA 4.0");
    // Plain text, not an anchor: the tile body is already inside a <Link>.
    expect(html).not.toContain(`href="${cover.sourceUrl}"`);
  });

  it("prefers a member product photo and drops the brand cover with it", () => {
    const html = renderToStaticMarkup(
      <BrandPosterTile
        shelf={{ ...base, coverCigarId: "c-1", coverProductPhotoId: "p-1", brandImage: cover }}
        imageUrl="/api/product-photos/c-1/thumb"
      />,
    );
    expect(html).toContain("/api/product-photos/c-1/thumb?v=p-1");
    expect(html).not.toContain("/api/brand-images/");
    expect(html).not.toContain("CC BY-SA 4.0");
  });

  it("falls back to the monogram, and shows no credit, when there is no cover at all", () => {
    const html = renderToStaticMarkup(<BrandPosterTile shelf={base} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("CC BY-SA");
  });
});
