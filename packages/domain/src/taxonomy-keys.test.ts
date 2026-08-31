import { describe, it, expect } from "vitest";
import {
  fold,
  foldTokens,
  tokenWindows,
  windowKeys,
  anchorByAlias,
  composeCanonicalName,
  MIN_ANCHOR_KEY_LENGTH,
} from "./taxonomy-keys.js";

// The matching-key vocabulary (ADR-012, migration 0026/0027). Pure — no database.

describe("fold", () => {
  // The whole reason two key rules exist: `brands.slug` is brandSlug(), which
  // does NOT strip accents and gives `padr-n`; `aliases` holds fold(), which
  // does and gives `padron`. A vendor writing either spelling lands on the same
  // matching key, and the URL contract keeps the ugly one it already published.
  it("folds accents onto their base letters", () => {
    expect(fold("Padrón")).toBe("padron");
    expect(fold("Padron")).toBe("padron");
    expect(fold("Pirámide")).toBe("piramide");
    expect(fold("Salomón")).toBe("salomon");
  });

  it("collapses punctuation and case exactly as the alias seeds do", () => {
    expect(fold("H. Upmann")).toBe("h-upmann");
    expect(fold("Romeo y Julieta")).toBe("romeo-y-julieta");
    expect(fold("  Drew   Estate  ")).toBe("drew-estate");
    expect(fold("No. 9")).toBe("no-9");
  });

  it("yields the empty key for text carrying no identity", () => {
    expect(fold("&")).toBe("");
    expect(fold("—")).toBe("");
    expect(fold("")).toBe("");
  });

  it("splits a folded key back into its tokens", () => {
    expect(foldTokens("Padrón 1964")).toEqual(["padron", "1964"]);
    expect(foldTokens("&")).toEqual([]);
  });
});

describe("tokenWindows", () => {
  // The window ORDER is the matching policy, not an implementation detail:
  // longest first so `liga-privada` beats `liga`, leftmost next so a brand at
  // the start of a title beats the same key appearing later.
  it("orders longest first, then leftmost", () => {
    const windows = tokenWindows(["a", "b", "c"]);
    expect(windows.map((w) => w.key)).toEqual(["a-b-c", "a-b", "b-c", "a", "b", "c"]);
  });

  it("caps window length so the probe key set stays linear", () => {
    const tokens = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(Math.max(...tokenWindows(tokens).map((w) => w.length))).toBe(6);
    expect(Math.max(...tokenWindows(tokens, 2).map((w) => w.length))).toBe(2);
  });

  // One array literal goes into the GIN probe, so a repeated token must not
  // repeat its key.
  it("deduplicates the probe key set", () => {
    expect([...windowKeys(["a", "a"])].sort()).toEqual(["a", "a-a"]);
    expect(windowKeys([])).toEqual([]);
  });
});

describe("anchorByAlias", () => {
  const drewEstate = { id: "brand-de", name: "Drew Estate", aliases: ["drew-estate"] };
  const drew = { id: "brand-d", name: "Drew", aliases: ["drew"] };
  const padron = { id: "brand-p", name: "Padrón", aliases: ["padron", "padr-n"] };

  it("prefers the longest alias over a shorter one that is its prefix", () => {
    const hit = anchorByAlias(["drew", "estate", "liga", "privada"], [drew, drewEstate]);
    expect(hit?.entity.id).toBe("brand-de");
    expect(hit).toMatchObject({ key: "drew-estate", start: 0, length: 2 });
  });

  // Vendors do title `Cigars - Padrón 1964`. An infix anchor is allowed outright,
  // not merely tolerated — refusing it would send a perfectly parseable listing
  // to triage because of a merchandising prefix.
  it("anchors mid-title when nothing earlier matches", () => {
    const hit = anchorByAlias(["cigars", "padron", "1964"], [padron]);
    expect(hit).toMatchObject({ entity: padron, start: 1, length: 1 });
  });

  // THE BRAND-ANCHOR CONSTRAINTS. Opt-in, and only the brand anchor opts in: a
  // line or blend is already scoped to a parent and to a token range, where a
  // short key is a name rather than a claim on the whole title.
  describe("under the brand-anchor constraints", () => {
    const cuba = { id: "brand-cuba", name: "Cuba", aliases: ["cuba"] };
    const punch = { id: "brand-punch", name: "Punch", aliases: ["punch"] };
    const oliva = { id: "brand-oliva", name: "Oliva", aliases: ["oliva"] };
    const la = { id: "brand-la", name: "La", aliases: ["la"] };
    const constrained = { segmentStarts: new Set([0]), minKeyLength: MIN_ANCHOR_KEY_LENGTH };

    // Each of these is a real vendor title whose one-token infix match anchored a
    // marca the title never named: a fragment of a longer name, or an accessory
    // that happens to share a word with a brand.
    it("refuses a one-token alias buried mid-title", () => {
      expect(anchorByAlias(["la", "aroma", "de", "cuba", "churchill"], [cuba], constrained)).toBeNull();
      expect(anchorByAlias(["flor", "de", "oliva", "robusto"], [oliva], constrained)).toBeNull();
      expect(anchorByAlias(["xikar", "9mm", "pull", "out", "punch"], [punch], constrained)).toBeNull();
    });

    it("accepts a one-token alias that leads the title", () => {
      expect(anchorByAlias(["oliva", "serie", "v", "melanio"], [oliva], constrained)).toMatchObject({
        entity: oliva,
        start: 0,
      });
    });

    // A merchandising prefix is the case the rule must not break, and punctuation
    // is what tells it apart from the three above: the brand leads a SEGMENT.
    // `tokenizeTitle` records where those begin, because `fold()` erases them.
    it("accepts a one-token alias that leads a segment", () => {
      expect(
        anchorByAlias(["cigars", "padron", "1964"], [padron], {
          segmentStarts: new Set([0, 1]),
          minKeyLength: MIN_ANCHOR_KEY_LENGTH,
        }),
      ).toMatchObject({ entity: padron, start: 1, length: 1 });
    });

    // A multi-token alias is a strong enough claim to stand anywhere: it takes
    // more than one word to name a marca by accident.
    it("still lets a multi-token alias match infix", () => {
      expect(anchorByAlias(["cigars", "drew", "estate", "t52"], [drewEstate], constrained)).toMatchObject({
        entity: drewEstate,
        start: 1,
        length: 2,
      });
    });

    // Two characters is an article, not a marca. The same floor the scope query's
    // bridge clause uses, and the two must agree or a brand admitted by one is
    // refused by the other.
    it("never anchors a key below the length floor, even at the start", () => {
      expect(anchorByAlias(["la", "something", "robusto"], [la], constrained)).toBeNull();
    });

    // A refused window is not a verdict on the others: the scan continues and a
    // legitimate anchor further along still wins.
    it("keeps scanning past a refused window", () => {
      expect(anchorByAlias(["flor", "de", "oliva", "drew", "estate"], [oliva, drewEstate], constrained)).toMatchObject(
        { entity: drewEstate, start: 3, length: 2 },
      );
    });
  });

  it("returns null rather than a best guess when nothing matches", () => {
    expect(anchorByAlias(["xikar", "hp3", "lighter"], [padron, drewEstate])).toBeNull();
    expect(anchorByAlias([], [padron])).toBeNull();
    expect(anchorByAlias(["padron"], [])).toBeNull();
  });

  // An ambiguous key is worth LESS than a missing one: a missing key lets the
  // matcher fall through to triage, while a key silently resolved to whichever
  // row came back first anchors confidently on the wrong marca. Same argument
  // 0026's collision pass makes for brands, enforced here for every level.
  it("drops a key two candidates claim rather than picking one", () => {
    const a = { id: "a", name: "A", aliases: ["shared"] };
    const b = { id: "b", name: "B", aliases: ["shared"] };
    expect(anchorByAlias(["shared"], [a, b])).toBeNull();
  });

  it("restricts the scan to a token range, which is how levels nest", () => {
    const tokens = ["padron", "drew", "estate"];
    expect(anchorByAlias(tokens, [drewEstate], { from: 1 })?.entity.id).toBe("brand-de");
    // Same tokens, scanned only before the brand: the line search must not reach
    // back over a level that was already consumed.
    expect(anchorByAlias(tokens, [drewEstate], { from: 0, to: 1 })).toBeNull();
  });
});

describe("composeCanonicalName", () => {
  it("says the parts in trade order", () => {
    expect(
      composeCanonicalName({ brand: "Drew Estate", line: "Liga Privada", blend: "No. 9", vitola: "Toro" }),
    ).toBe("Drew Estate Liga Privada No. 9 Toro");
  });

  // Registry names repeat their ancestors because each level is named the way a
  // shop says it, standing alone. Naive concatenation gives
  // "Padrón Padrón 1964 Anniversary Series", which is worse than the freeform
  // string it replaced.
  it("drops the leading run a part repeats from its ancestors", () => {
    expect(
      composeCanonicalName({
        brand: "Padrón",
        line: "Padrón 1964 Anniversary Series",
        blend: "Maduro",
        vitola: "Exclusivo",
      }),
    ).toBe("Padrón 1964 Anniversary Series Maduro Exclusivo");
  });

  it("dedupes a blend that restates its whole line", () => {
    expect(
      composeCanonicalName({ brand: "Drew Estate", line: "Liga Privada", blend: "Liga Privada No. 9" }),
    ).toBe("Drew Estate Liga Privada No. 9");
  });

  // THE CASE THAT FORCED SUFFIX/PREFIX OVERLAP INSTEAD OF A MEMBERSHIP TEST.
  // With membership, both Fuentes cancel because each has "already been said";
  // overlap cancels exactly one, which is what is on the band.
  it("keeps a legitimately repeated word", () => {
    expect(composeCanonicalName({ brand: "Arturo Fuente", line: "Fuente Fuente OpusX" })).toBe(
      "Arturo Fuente Fuente OpusX",
    );
  });

  it("cancels a part entirely when it restates its parent exactly", () => {
    expect(composeCanonicalName({ brand: "Davidoff", line: "Signature", blend: "Davidoff Signature" })).toBe(
      "Davidoff Signature",
    );
  });

  // Overlap is measured against the TAIL of what has been said, so a blend that
  // repeats the word its line just ended on contributes nothing — no stutter.
  it("cancels a blend whose word the line already ended with", () => {
    expect(composeCanonicalName({ brand: "Padrón", line: "1964 Anniversary Maduro", blend: "Maduro" })).toBe(
      "Padrón 1964 Anniversary Maduro",
    );
  });

  // But a repeat that does not sit at the join is a different claim about a
  // different level, and dropping it would lose a fact.
  it("keeps a repeat that is not at the join", () => {
    expect(composeCanonicalName({ brand: "Oliva", line: "Maduro Reserve", blend: "Maduro" })).toBe(
      "Oliva Maduro Reserve Maduro",
    );
  });

  it("skips absent levels without leaving a gap", () => {
    expect(composeCanonicalName({ brand: "Oliva", line: null, blend: undefined, vitola: "Robusto" })).toBe(
      "Oliva Robusto",
    );
    expect(composeCanonicalName({})).toBe("");
  });

  it("appends the edition last", () => {
    expect(
      composeCanonicalName({ brand: "H. Upmann", line: "Magnum 50", edition: "Edición Limitada 2005" }),
    ).toBe("H. Upmann Magnum 50 Edición Limitada 2005");
  });
});
