import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroPlate } from "./hero-plate";
import { monogram } from "./band-tile";

// One plate, both arms (DESIGN-002 §detail #1): the photo and the BandTile
// render inside the IDENTICAL frame, so a photographed and a photoless cigar
// keep the same hero structure — the #218 sweep's finding was two structurally
// different heroes.
describe("the hero plate", () => {
  it("contains the photo on the plate ground", () => {
    const html = renderToStaticMarkup(
      <HeroPlate photoUrl="/api/product-photos/abc?v=1" name="Bolivar Belicosos Finos" />,
    );
    expect(html).toContain("aspect-[3/4]");
    expect(html).toContain("object-contain");
    expect(html).toContain('src="/api/product-photos/abc?v=1"');
  });

  it("fills the identical frame with the BandTile when no photo exists", () => {
    const html = renderToStaticMarkup(
      <HeroPlate photoUrl={null} name="Bolivar Belicosos Finos" />,
    );
    expect(html).toContain("aspect-[3/4]");
    expect(html).not.toContain("<img");
    expect(html).toContain(monogram("Bolivar Belicosos Finos"));
  });

  it("keeps the frame markup byte-identical across both arms", () => {
    // React hoists a preload <link> ahead of the img arm, so the frame is the
    // first DIV, not the first tag.
    const frameOf = (html: string): string => /<div[^>]*>/.exec(html)?.[0] ?? "";
    const withPhoto = renderToStaticMarkup(<HeroPlate photoUrl="/p.jpg" name="X" />);
    const withoutPhoto = renderToStaticMarkup(<HeroPlate photoUrl={null} name="X" />);
    expect(frameOf(withPhoto)).toBe(frameOf(withoutPhoto));
  });
});
