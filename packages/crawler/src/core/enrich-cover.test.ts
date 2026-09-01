import { describe, it, expect } from "vitest";
import { parseListingTitle, type ListingParse, type ParseRegistry } from "@cj/domain";
import { coversAsk, enrichAsk, type EnrichAskRow } from "./match.js";

// THE ENRICH DRAIN'S ADMISSION RULE, pure (#233, ADR-012). `coversAsk` is what
// replaced `similarity(canonical_name, title) > 0.55` as the thing that decides
// whether a vendor listing may be linked to an open enrichment request, and the
// whole point of that swap is that the decision is now STRUCTURAL. So it is
// asserted here as structure, over literals, with no database anywhere near it —
// the drain's own end-to-end behaviour is pinned separately in ingest.test.ts.
//
// EVERY PARSE BELOW IS BUILT WITH AN EMPTY REGISTRY, and that is the production
// configuration rather than a convenience. Prod's registry holds 96 brands and —
// until the Wave 3 backfill — ZERO lines and ZERO blends, and none of those 96
// brands is the marca of `Liga Privada No. 9 Corona Viva` (the marca is Drew
// Estate; the title never says so). A rule that only works once the registry is
// complete would not have fixed the miss prod actually recorded, so the cases
// that matter are run against a registry that knows nothing. The few that are
// ABOUT the id gates supply a registry explicitly, and say so.
const EMPTY_REGISTRY: ParseRegistry = { brands: [], linesOfBrand: () => [], blendsOfLine: () => [] };

const parse = (title: string, registry: ParseRegistry = EMPTY_REGISTRY): ListingParse =>
  parseListingTitle(title, registry);

// An ask row as the drain's open-set SELECT hands it over: the catalog row's own
// name and taxonomy, never a re-parse of its name.
const ask = (row: Partial<EnrichAskRow> & { canonicalName: string }) =>
  enrichAsk({
    cigarId: "cigar-under-test",
    brand: null,
    line: null,
    brandId: null,
    lineId: null,
    blendId: null,
    ...row,
  });

describe("enrichAsk", () => {
  // THE FLAGSHIP MISS, in one assertion. The ask is blend-level and its name
  // carries the marca; what a candidate must state is the BLEND, so the brand
  // span comes off and `liga privada no 9` is what is left to satisfy.
  it("strikes the ask's own brand span from its required keys", () => {
    expect(
      ask({ canonicalName: "Drew Estate Liga Privada No. 9", brand: "Drew Estate", brandId: "de" }).requiredKeys,
    ).toEqual(["liga", "privada", "no", "9"]);
  });

  // Line as well as brand, and for the same reason: a vendor that omits `Monster
  // Series` from its title is not naming a different cigar, it is naming the same
  // one more briefly.
  it("strikes the ask's line span too", () => {
    expect(
      ask({
        canonicalName: "Tatuaje Monster Series The Bride",
        brand: "Tatuaje",
        line: "Monster Series",
        brandId: "tat",
      }).requiredKeys,
    ).toEqual(["the", "bride"]);
  });

  // A ROW WHOSE NAME ABBREVIATES ITS OWN MARCA, which is a registry problem
  // wearing a matcher's clothes — see the alias pair in the coversAsk block below.
  it("leaves an unrecognised marca abbreviation standing as a required key", () => {
    expect(
      ask({
        canonicalName: "HdM Epicure Especial",
        brand: "Hoyo de Monterrey",
        brandId: "hdm",
        brandAliases: ["hoyo-de-monterrey"],
      }).requiredKeys,
    ).toEqual(["hdm", "epicure", "especial"]);
  });
});

describe("coversAsk", () => {
  // COVERAGE IS ONE-WAY, and this is the case #233 exists for. Prod's ask is
  // blend-level and every Fox title is vitola-level; a blend-level ask wants a
  // photo of ANY of its vitolas (one catalogue photo per row, ADR-007), so a
  // candidate carrying MORE than the ask is a match.
  it("a blend-level ask is covered by any of its vitolas", () => {
    const blend = ask({ canonicalName: "Drew Estate Liga Privada No. 9", brand: "Drew Estate", brandId: "de" });

    expect(coversAsk(blend, parse("Liga Privada No. 9 Corona Viva"))).toBe(true);
    expect(coversAsk(blend, parse("Liga Privada No. 9 Corona Doble"))).toBe(true);
  });

  // ...AND THE SIBLING BLENDS ARE STILL REFUSED. `Liga Privada No. 9` and `T52`
  // are the two highest-scoring "duplicate" names in the entire catalog under
  // trigram (ADR-012) and they are four different cigars. Structure separates
  // them without a threshold: `no` and `9` are required keys and neither title
  // carries them.
  it("does not cover a sibling blend of the same line", () => {
    const blend = ask({ canonicalName: "Drew Estate Liga Privada No. 9", brand: "Drew Estate", brandId: "de" });

    expect(coversAsk(blend, parse("Liga Privada T52 Robusto"))).toBe(false);
    expect(coversAsk(blend, parse("Liga Privada H99 Robusto"))).toBe(false);
  });

  // The other direction of the same rule. A vitola-level ask names a specific
  // stick, so a blend-level listing does not depict it — it is missing `corona
  // viva`, and inferring which vitola the shop meant is exactly the guess ADR-012
  // forbids.
  it("a vitola-level ask is NOT covered by a blend-level title", () => {
    const vitola = ask({ canonicalName: "Liga Privada No. 9 Corona Viva", brand: "Drew Estate", brandId: "de" });

    expect(coversAsk(vitola, parse("Liga Privada No. 9 Corona Viva"))).toBe(true);
    expect(coversAsk(vitola, parse("Liga Privada No. 9"))).toBe(false);
  });

  // THE ONE PHOTO SLOT IS PERMANENT (ADR-007), so a monster is not a substitute
  // for another monster. Fox stocks the Skinny Monsters and does not stock The
  // Bride; the required keys `the bride` are what says so.
  it("does not cover a sibling release under the same line", () => {
    const bride = ask({
      canonicalName: "Tatuaje Monster Series The Bride",
      brand: "Tatuaje",
      line: "Monster Series",
      brandId: "tat",
    });

    expect(coversAsk(bride, parse("Tatuaje Skinny Monsters Tiff"))).toBe(false);
    expect(coversAsk(bride, parse("Tatuaje Skinny Monsters Frank"))).toBe(false);
    // The control, without which both zeros above are unfalsifiable: the ask is
    // coverable, by a title that actually names it and adds a vitola.
    expect(coversAsk(bride, parse("Tatuaje The Bride Churchill"))).toBe(true);
  });

  // A MISS OF THIS SHAPE IS CLOSED BY A CURATOR ADDING AN ALIAS, NEVER BY
  // LOOSENING THE MATCHER — the pair below is the whole argument.
  //
  // Prod's ask `HdM Epicure Especial` carries `brand = 'Hoyo de Monterrey'`, a
  // spelling that appears nowhere in its own name. Without an alias for the
  // abbreviation, `hdm` survives as a REQUIRED key and no vendor title on earth
  // can cover the ask: not the vendor's fault, not the matcher's, and not fixable
  // by any threshold. With `hdm` in `brands.aliases` the span is struck and the
  // ask asks for what it means — `epicure especial` — while the two near-miss
  // Hoyos stay refused. Data closes it; the rule does not move.
  it("an unaliased marca abbreviation covers nothing, and an alias closes it", () => {
    const row = {
      canonicalName: "HdM Epicure Especial",
      brand: "Hoyo de Monterrey",
      brandId: "hdm",
    } as const;

    const unaliased = ask({ ...row, brandAliases: ["hoyo-de-monterrey"] });
    expect(unaliased.requiredKeys).toEqual(["hdm", "epicure", "especial"]);
    expect(coversAsk(unaliased, parse("Hoyo de Monterrey Epicure Especial"))).toBe(false);

    const aliased = ask({ ...row, brandAliases: ["hoyo-de-monterrey", "hdm"] });
    expect(aliased.requiredKeys).toEqual(["epicure", "especial"]);
    expect(coversAsk(aliased, parse("Hoyo de Monterrey Epicure Especial"))).toBe(true);
    // And the alias buys precision, not reach: the marca's other listings — a
    // different blend, and a different vitola of the same blend — are still
    // refused on their own keys.
    expect(coversAsk(aliased, parse("Hoyo De Monterrey Classic No. 450 EMS Robusto"))).toBe(false);
    expect(coversAsk(aliased, parse("Hoyo de Monterrey Epicure No. 2"))).toBe(false);
  });

  // THE BRAND GATE IS A CONTRADICTION TEST, NOT AN ANCHOR REQUIREMENT. A
  // candidate that anchors a DIFFERENT marca is positive evidence of a different
  // product and is refused; a candidate that anchors NOTHING — which is what
  // every Liga Privada title does against prod's registry — is carried on its key
  // coverage alone. Requiring the candidate to self-anchor the ask's brand would
  // leave the flagship miss exactly as broken as the trigram floor left it.
  it("refuses a candidate that anchors a different brand, and carries one that anchors none", () => {
    const registry: ParseRegistry = {
      brands: [{ id: "brand-tatuaje", name: "Tatuaje", aliases: ["tatuaje"] }],
      linesOfBrand: () => [],
      blendsOfLine: () => [],
    };
    const anchored = parse("Tatuaje The Bride Churchill", registry);
    expect(anchored.brandId).toBe("brand-tatuaje");

    const row = { canonicalName: "Tatuaje Monster Series The Bride", brand: "Tatuaje", line: "Monster Series" };
    expect(coversAsk(ask({ ...row, brandId: "brand-tatuaje" }), anchored)).toBe(true);
    expect(coversAsk(ask({ ...row, brandId: "brand-drew-estate" }), anchored)).toBe(false);
    // Silence on the candidate's side is NOT a contradiction — the same
    // positive-evidence rule the seed path applies when it refuses to unlink on a
    // `no_anchor`.
    expect(coversAsk(ask({ ...row, brandId: "brand-drew-estate" }), parse("Tatuaje The Bride Churchill"))).toBe(true);
  });

  // The line arm of the same gate. Inert today — nothing carries a `line_id` yet
  // — and live the day the Wave 3 backfill lands, with no further edit to the
  // matcher, which is why it is pinned now rather than then.
  it("refuses a candidate that resolves to a different line", () => {
    const registry: ParseRegistry = {
      brands: [{ id: "brand-tatuaje", name: "Tatuaje", aliases: ["tatuaje"] }],
      linesOfBrand: () => [{ id: "line-standalone", name: "The Bride", aliases: ["the-bride"] }],
      blendsOfLine: () => [],
    };
    const anchored = parse("Tatuaje The Bride Churchill", registry);
    expect(anchored.lineId).toBe("line-standalone");

    const row = {
      canonicalName: "Tatuaje Monster Series The Bride",
      brand: "Tatuaje",
      line: "Monster Series",
      brandId: "brand-tatuaje",
    };
    expect(coversAsk(ask({ ...row, lineId: "line-monster-series" }), anchored)).toBe(false);
    expect(coversAsk(ask({ ...row, lineId: "line-standalone" }), anchored)).toBe(true);
    // Silence again: an ask that names a line is still covered by a candidate
    // that resolves none.
    expect(coversAsk(ask({ ...row, lineId: "line-monster-series" }), parse("Tatuaje The Bride Churchill"))).toBe(true);
  });

  // A mixed box is not one cigar, so it depicts no single catalog row — the same
  // ruling `chooseLeaf` makes on the seed path. The packaging strip makes this
  // non-obvious and therefore worth pinning: `Sampler` comes OFF the name before
  // the keys are read, so a sampler's remaining keys cover the ask perfectly and
  // only the `sampler` flag stops it.
  it("never covers a sampler, however well its remaining keys fit", () => {
    const blend = ask({ canonicalName: "Drew Estate Liga Privada No. 9", brand: "Drew Estate", brandId: "de" });
    const sampler = parse("Liga Privada No. 9 Sampler");

    expect(sampler.sampler).toBe(true);
    expect(sampler.cleanedName).toBe("Liga Privada No. 9");
    expect(coversAsk(blend, sampler)).toBe(false);
    // The control: the same cleaned name, sold as a cigar, is covered.
    expect(coversAsk(blend, parse("Liga Privada No. 9"))).toBe(true);
  });

  // WRAPPER VARIANTS ARE SEPARATE PRODUCTS, so they are separate blends (ADR-012)
  // — a Maduro's photo slot must not be filled with the Natural's picture. The
  // line strike is what makes this gate visible on its own: with `1964
  // Anniversary Maduro` accounted for as the line, all three titles below satisfy
  // the required keys, and only the wrapper decides.
  it("refuses a contradicting wrapper and admits a title that states none", () => {
    const maduro = ask({
      canonicalName: "Padron 1964 Anniversary Maduro Torpedo",
      brand: "Padron",
      line: "1964 Anniversary Maduro",
      brandId: "pad",
    });
    expect(maduro.requiredKeys).toEqual(["torpedo"]);

    expect(coversAsk(maduro, parse("Padron 1964 Anniversary Maduro Torpedo"))).toBe(true);
    expect(coversAsk(maduro, parse("Padron 1964 Anniversary Natural Torpedo"))).toBe(false);
    // `unstated` is not a disagreement: a vendor naming no wrapper has made no
    // claim, and refusing it would invent a distinction the vendor did not make.
    expect(coversAsk(maduro, parse("Padron 1964 Anniversary Torpedo"))).toBe(true);
  });
});
