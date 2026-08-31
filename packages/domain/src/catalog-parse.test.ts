import { describe, it, expect } from "vitest";
import {
  stripPackaging,
  parsePackagingFacts,
  PACKAGING_TOKEN_LABELS,
  extractDims,
  parseDims,
  matchVitola,
  tokenizeTitle,
  parseListingTitle,
  type ParseRegistry,
} from "./catalog-parse.js";

// The pure parse pipeline (ADR-012 Wave 2). No database anywhere in this file:
// every registry lookup is "here are the candidate rows, which does this title
// name?", which is exactly why the whole thing is testable against literals.

describe("parsePackagingFacts", () => {
  // ADR-009's rules, unchanged — the crawler's parsePackaging now delegates here,
  // so these cases pin that the offer's packaging facts did not shift when the
  // vocabulary moved.
  it("reads the offer's packaging, most specific first", () => {
    expect(parsePackagingFacts("Oliva Serie V Box of 24")).toEqual({ packaging: "box", sticksPerPackage: 24 });
    expect(parsePackagingFacts("Oliva Serie V Pack of 5")).toEqual({ packaging: "5-pack", sticksPerPackage: 5 });
    expect(parsePackagingFacts("Oliva Serie V 5-Pack")).toEqual({ packaging: "5-pack", sticksPerPackage: 5 });
    expect(parsePackagingFacts("Oliva Serie V Single")).toEqual({ packaging: "single", sticksPerPackage: 1 });
  });

  it("leaves unstated packaging unknown rather than guessing", () => {
    expect(parsePackagingFacts("Oliva Serie V Melanio Torpedo")).toEqual({
      packaging: null,
      sticksPerPackage: null,
    });
  });
});

describe("stripPackaging", () => {
  // PACKAGING IS NEVER IDENTITY (ADR-012). It describes the offer, so it comes
  // off the title before anything reads that title as a name — and its facts are
  // recorded, not discarded, so nothing is lost by the removal.
  it("removes the packaging phrase and keeps its facts", () => {
    expect(stripPackaging("Padrón 1964 Anniversary Maduro Torpedo Box of 20")).toMatchObject({
      cleaned: "Padrón 1964 Anniversary Maduro Torpedo",
      packaging: "box",
      sticksPerPackage: 20,
    });
  });

  it("removes standalone container words", () => {
    expect(stripPackaging("Davidoff Signature 2000 Tubos").cleaned).toBe("Davidoff Signature 2000");
    expect(stripPackaging("Padron 1964 Tin").cleaned).toBe("Padron 1964");
    expect(stripPackaging("Oliva Serie V Bundle").cleaned).toBe("Oliva Serie V");
  });

  it("removes an explicit stick count without touching an identity number", () => {
    // `1964` is identity and `10 ct` is packaging, and the difference is that a
    // count carries a unit. A bare number is NEVER read as a count — that is
    // precisely where the flat matcher used to destroy a product name.
    expect(stripPackaging("Padron 1964 Anniversary 10 ct").cleaned).toBe("Padron 1964 Anniversary");
    expect(stripPackaging("Padron 1964 Anniversary (5)").cleaned).toBe("Padron 1964 Anniversary");
    expect(stripPackaging("Padron 1926 Serie No. 1").cleaned).toBe("Padron 1926 Serie No. 1");
  });

  // `box-pressed` is a SHAPE attribute of the vitola, not packaging — the
  // industry vocabulary is explicit that a title carrying it is not a new leaf.
  // The word `box` inside it must survive the strip.
  it("protects box-pressed and trunk-pressed from the box token", () => {
    expect(stripPackaging("Liga Privada No. 9 Box-Pressed Toro").cleaned).toBe(
      "Liga Privada No. 9 Box-Pressed Toro",
    );
    expect(stripPackaging("Liga Privada No. 9 Trunk Pressed Toro").cleaned).toBe(
      "Liga Privada No. 9 Trunk-Pressed Toro",
    );
  });

  it("flags a sampler, which names no single leaf", () => {
    expect(stripPackaging("Fox 5 Cigar Sampler").sampler).toBe(true);
    expect(stripPackaging("Oliva Serie V Robusto").sampler).toBe(false);
  });

  it("tidies separators the removal left dangling", () => {
    expect(stripPackaging("Oliva Serie V Melanio - Box of 10").cleaned).toBe("Oliva Serie V Melanio");
  });
});

// THE VOCABULARY INVARIANT, and it is the reason the two passes share one list.
// A stripper that removes a word the parser never records does not MOVE the fact
// from the name to the offer, it DESTROYS it — `Punch Bolos Tin` used to lose its
// `Tin` from the name and record no packaging anywhere. Asserting it over the
// whole vocabulary rather than over examples is what makes the list closed: a
// token added to `PACKAGING_TOKEN_LABELS` without a label fails here, not in
// production six months later.
describe("the packaging vocabulary is closed", () => {
  it("records every standalone container word it is willing to strip", () => {
    for (const token of PACKAGING_TOKEN_LABELS.keys()) {
      const title = `Oliva Serie V Robusto ${token}`;
      const stripped = stripPackaging(title);
      expect(stripped.cleaned, `'${token}' was stripped`).toBe("Oliva Serie V Robusto");
      expect(stripped.packaging, `'${token}' was recorded`).toBe(PACKAGING_TOKEN_LABELS.get(token));
    }
  });

  it("records a count the stripper removes even when no container is named", () => {
    expect(parsePackagingFacts("Padron 1964 Anniversary 10 ct")).toEqual({ packaging: null, sticksPerPackage: 10 });
    expect(parsePackagingFacts("Padron 1964 Anniversary (5)")).toEqual({ packaging: null, sticksPerPackage: 5 });
  });

  it("reads the trade's own bundle words", () => {
    expect(parsePackagingFacts("Oliva Serie V Bundle of 20")).toEqual({ packaging: "bundle", sticksPerPackage: 20 });
    expect(parsePackagingFacts("Oliva Serie V Mazo")).toEqual({ packaging: "mazo", sticksPerPackage: null });
    expect(stripPackaging("Oliva Serie V Mazo").cleaned).toBe("Oliva Serie V");
  });

  // A shape term is not a container, and the `box` inside `Box-Pressed` must not
  // become a box on the offer any more than it may come off the name.
  it("does not read a shape term as a container", () => {
    expect(parsePackagingFacts("Liga Privada No. 9 Box Pressed Toro")).toEqual({
      packaging: null,
      sticksPerPackage: null,
    });
  });

  // The general form of the invariant: nothing is removed silently. If the
  // cleaned name is shorter than the title, the difference is on the offer.
  it("never removes anything without recording a fact", () => {
    const titles = [
      "Padrón 1964 Anniversary Maduro Torpedo Box of 20",
      "Davidoff Signature 2000 Tubos",
      "Punch Bolos Tin",
      "Oliva Serie V Bundle",
      "Fox 5 Cigar Sampler",
      "Padron 1964 Anniversary 10 ct",
      "Padron 1964 Anniversary (5)",
      "Oliva Serie V 5-Pack",
      "Arturo Fuente Hemingway Single",
      "Oliva Serie V Melanio - Box of 10",
      "My Father Le Bijou 1922 Toro Cab",
    ];
    for (const title of titles) {
      const stripped = stripPackaging(title);
      if (stripped.cleaned === title) continue;
      expect(
        stripped.packaging != null || stripped.sticksPerPackage != null,
        `'${title}' lost text without recording a fact`,
      ).toBe(true);
    }
  });

  it("leaves a title carrying no packaging entirely alone", () => {
    expect(stripPackaging("Oliva Serie V Melanio Torpedo")).toMatchObject({
      cleaned: "Oliva Serie V Melanio Torpedo",
      packaging: null,
      sticksPerPackage: null,
    });
  });
});

describe("extractDims", () => {
  // Both orders are real vendor spellings and no separator says which is which.
  // Magnitude decides, and it can: 3–10 inches and 20–80 sixty-fourths do not
  // overlap.
  it("reads a dimension pair in either order", () => {
    expect(parseDims("Oliva Serie V 6 x 50")).toEqual({ lengthInches: 6, ringGauge: 50 });
    expect(parseDims("Oliva Serie V 60 x 6")).toEqual({ lengthInches: 6, ringGauge: 60 });
    expect(parseDims("Oliva Serie V 7x70")).toEqual({ lengthInches: 7, ringGauge: 70 });
  });

  it("reads fractional and decimal lengths", () => {
    expect(parseDims("Padron 6 1/2 x 52")).toEqual({ lengthInches: 6.5, ringGauge: 52 });
    expect(parseDims("Padron 6.5 x 52")).toEqual({ lengthInches: 6.5, ringGauge: 52 });
  });

  it("reads half a pair when the unit says which half", () => {
    expect(parseDims("Cohiba Robusto 50 ring")).toEqual({ lengthInches: null, ringGauge: 50 });
    expect(parseDims("Cohiba Lancero 7 inch")).toEqual({ lengthInches: 7, ringGauge: null });
  });

  // A pair that resolves to neither shape is not a dimension pair. Left in place:
  // whatever it is, it is more likely identity than measurement.
  it("refuses a pair that is not one length and one ring", () => {
    expect(parseDims("Serie 1 x 2")).toEqual({ lengthInches: null, ringGauge: null });
  });

  it("blanks only the dimension span, never an identity number", () => {
    const { remainder } = extractDims("Padron 1964 Anniversary 6 x 50");
    expect(remainder).toContain("1964");
    expect(remainder).not.toMatch(/\b50\b/);
  });
});

describe("tokenizeTitle", () => {
  it("keeps display words aligned with their folded keys", () => {
    expect(tokenizeTitle("Padrón 1964 Anniversary")).toEqual({
      words: ["Padrón", "1964", "Anniversary"],
      keys: ["padron", "1964", "anniversary"],
      segmentStarts: new Set([0]),
    });
  });

  // `fold()` erases the punctuation a vendor separates its merchandising prefix
  // with, so the boundary is recorded before it is erased. It is what lets a
  // one-token brand alias anchor `Cigars - Padrón 1964` and refuse `La Aroma de
  // Cuba Churchill`, which have the same shape once the punctuation is gone.
  it("records where each punctuation-separated segment begins", () => {
    expect(tokenizeTitle("Cigars - Padrón 1964").segmentStarts).toEqual(new Set([0, 1]));
    expect(tokenizeTitle("La Aroma de Cuba Churchill").segmentStarts).toEqual(new Set([0]));
  });

  // A word folding to a multi-token key would desynchronize the arrays that
  // alias spans and residue reconstruction both index into.
  it("splits a word whose fold is multi-token", () => {
    expect(tokenizeTitle("No.9 Toro").keys).toEqual(["no", "9", "toro"]);
  });

  it("drops words carrying no identity", () => {
    expect(tokenizeTitle("Rocky Patel & Sons").keys).toEqual(["rocky", "patel", "sons"]);
  });
});

describe("matchVitola", () => {
  it("prefers the longest trade term", () => {
    expect(matchVitola(["double", "corona"], new Set())).toMatchObject({ name: "Double Corona", length: 2 });
    expect(matchVitola(["petit", "corona"], new Set())).toMatchObject({ name: "Petit Corona" });
    expect(matchVitola(["corona"], new Set())).toMatchObject({ name: "Corona" });
  });

  it("normalizes accented and plural spellings to one display label", () => {
    expect(matchVitola(["piramide"], new Set())?.name).toBe("Pirámide");
    expect(matchVitola(["robustos"], new Set())?.name).toBe("Robusto");
  });

  // `torpedo` still parses — dropping a stated size would be worse — but it is
  // flagged, because modern usage has drifted so far that most cigars sold as
  // torpedoes are pirámides.
  it("flags torpedo as a drifted label", () => {
    expect(matchVitola(["torpedo"], new Set())).toMatchObject({ name: "Torpedo", weak: true });
    expect(matchVitola(["robusto"], new Set())?.weak).toBe(false);
  });

  // `Toro` inside a marca named `El Toro` is part of the brand, not a size. The
  // anchor has already claimed those tokens, so the vitola scan cannot see them.
  it("ignores tokens a registry level already consumed", () => {
    expect(matchVitola(["el", "toro", "robusto"], new Set([0, 1]))?.name).toBe("Robusto");
    expect(matchVitola(["el", "toro"], new Set([0, 1]))).toBeNull();
  });
});

describe("parseListingTitle", () => {
  const padron = { id: "brand-padron", name: "Padrón", aliases: ["padron", "padr-n"] };
  const drewEstate = { id: "brand-de", name: "Drew Estate", aliases: ["drew-estate"] };
  const anniversary = { id: "line-1964", name: "1964 Anniversary Series", aliases: ["1964-anniversary-series", "1964-anniversary", "1964"] };
  const ligaPrivada = { id: "line-lp", name: "Liga Privada", aliases: ["liga-privada"] };
  const maduro = { id: "blend-maduro", name: "Maduro", aliases: ["maduro"] };
  const natural = { id: "blend-natural", name: "Natural", aliases: ["natural"] };
  const noNine = { id: "blend-9", name: "No. 9", aliases: ["no-9"] };
  const t52 = { id: "blend-t52", name: "T52", aliases: ["t52"] };

  const registry: ParseRegistry = {
    brands: [padron, drewEstate],
    linesOfBrand: (id) =>
      id === padron.id ? [anniversary] : id === drewEstate.id ? [ligaPrivada] : [],
    blendsOfLine: (id) =>
      id === anniversary.id ? [maduro, natural] : id === ligaPrivada.id ? [noNine, t52] : [],
  };

  it("resolves brand, line, blend and vitola from one title", () => {
    const parse = parseListingTitle("Padrón 1964 Anniversary Series Maduro Torpedo", registry);
    expect(parse).toMatchObject({
      brandId: "brand-padron",
      brandName: "Padrón",
      lineId: "line-1964",
      blendId: "blend-maduro",
      vitolaName: "Torpedo",
      residue: "",
    });
  });

  // THE TRIGRAM-INVERSION CASE FROM ADR-012, at the parse level: `No. 9` and
  // `T52` are the two most similar-looking names in the catalog by trigram and
  // are different products. Aliases make them different keys, so they can never
  // be confused however close their strings.
  it("distinguishes No. 9 from T52 by alias, not by string distance", () => {
    expect(parseListingTitle("Drew Estate Liga Privada No. 9 Toro", registry).blendId).toBe("blend-9");
    expect(parseListingTitle("Drew Estate Liga Privada T52 Toro", registry).blendId).toBe("blend-t52");
  });

  // Wrapper variants marketed as separate products ARE distinct blends, because
  // that is how they are sold (ADR-012). The parse must land on different ids.
  it("distinguishes the Maduro and Natural wrapper variants", () => {
    const maduroParse = parseListingTitle("Padron 1964 Anniversary Maduro Exclusivo", registry);
    const naturalParse = parseListingTitle("Padron 1964 Anniversary Natural Exclusivo", registry);
    expect(maduroParse.blendId).toBe("blend-maduro");
    expect(naturalParse.blendId).toBe("blend-natural");
    expect(maduroParse.blendId).not.toBe(naturalParse.blendId);
  });

  // ABSENT STAYS ABSENT — the house rule ADR-012 reaffirms. A title naming only
  // its marca resolves to that marca and stops, with a note saying where it
  // stopped rather than a guess at the rest.
  it("stops at the level the title actually names", () => {
    const parse = parseListingTitle("Padrón Something Unknown", registry);
    expect(parse).toMatchObject({ brandId: "brand-padron", lineId: null, blendId: null });
    expect(parse.residue).toBe("Something Unknown");
    expect(parse.notes.join(" ")).toContain("No line alias matched");
  });

  // No anchor, no parse. This is the state seed mode used to MINT from, which is
  // how every new vendor grew a parallel catalog.
  it("yields no anchor at all for an unrecognised marca", () => {
    const parse = parseListingTitle("Xikar HP3 Lighter", registry);
    expect(parse.brandId).toBeNull();
    expect(parse.residue).toBe("Xikar HP3 Lighter");
    expect(parse.notes.join(" ")).toContain("No brand alias matched");
  });

  it("strips packaging out of the name and records it on the parse", () => {
    const parse = parseListingTitle("Padrón 1964 Anniversary Series Maduro Torpedo Box of 20", registry);
    expect(parse.cleanedName).toBe("Padrón 1964 Anniversary Series Maduro Torpedo");
    expect(parse).toMatchObject({ packaging: "box", sticksPerPackage: 20, blendId: "blend-maduro" });
    expect(parse.notes.join(" ")).toContain("stripped from the name");
  });

  it("reads dimensions without letting them reach the residue", () => {
    const parse = parseListingTitle("Padrón 1964 Anniversary Series Maduro 6 x 52", registry);
    expect(parse).toMatchObject({ lengthInches: 6, ringGauge: 52, residue: "" });
  });

  it("anchors a brand that appears mid-title", () => {
    const parse = parseListingTitle("Cigars - Padrón 1964 Anniversary Series Maduro", registry);
    expect(parse.brandId).toBe("brand-padron");
    expect(parse.notes.join(" ")).toContain("matched mid-title");
  });

  // A ONE-WORD MARCA IS THE EASIEST THING IN THE WORLD TO SAY BY ACCIDENT, and
  // every title below says one without naming it: two are fragments of a longer
  // marca, the third is an accessory. Anchoring any of them would scope the whole
  // match to the wrong brand and, in seed mode, mint under it.
  it("refuses a one-word marca buried inside a longer name", () => {
    const shortBrands: ParseRegistry = {
      brands: [
        { id: "brand-cuba", name: "Cuba", aliases: ["cuba"] },
        { id: "brand-punch", name: "Punch", aliases: ["punch"] },
        { id: "brand-oliva", name: "Oliva", aliases: ["oliva"] },
      ],
      linesOfBrand: () => [],
      blendsOfLine: () => [],
    };
    expect(parseListingTitle("La Aroma de Cuba Churchill", shortBrands).brandId).toBeNull();
    expect(parseListingTitle("Xikar 9mm Pull Out Punch", shortBrands).brandId).toBeNull();
    expect(parseListingTitle("Flor de Oliva Robusto", shortBrands).brandId).toBeNull();
    // And the same alias still anchors the titles it genuinely leads.
    expect(parseListingTitle("Oliva Serie V Melanio", shortBrands).brandId).toBe("brand-oliva");
  });

  // A line belongs to its brand structurally: the candidate set handed in is
  // already scoped, so a Drew Estate line can never attach to Padrón.
  it("never resolves a line outside the anchored brand", () => {
    const parse = parseListingTitle("Padrón Liga Privada No. 9", registry);
    expect(parse).toMatchObject({ brandId: "brand-padron", lineId: null, blendId: null });
  });
});

describe("stripPackaging separator tidying", () => {
  // `cleanedName` becomes a minted row's canonical_name, so a dash left framing
  // a segment that was removed is the difference between a catalog entry and a
  // catalog entry that looks like a bug.
  it("collapses separators left framing a removed segment", () => {
    expect(stripPackaging("Padrón 1964 Anniversary - Box of 20 - Torpedo").cleaned).toBe(
      "Padrón 1964 Anniversary - Torpedo",
    );
  });
});
