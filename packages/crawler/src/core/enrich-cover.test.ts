import { describe, it, expect } from "vitest";
import { identityTokensCompatible, parseListingTitle, type ListingParse, type ParseRegistry } from "@cj/domain";
import {
  coversAsk,
  enrichAsk,
  enrichCandidateKeys,
  rankEnrichCandidates,
  scoreEnrichCandidate,
  type EnrichAsk,
  type EnrichAskRow,
} from "./match.js";

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

  // THE LINE STRIKE IS GATED ON `line_id`, AND THE GATE IS THE TEST. Striking the
  // line says "a vendor that omits `Monster Series` is not naming a different
  // cigar" — true only while the `lineId` contradiction arm in `coversAsk` can
  // still refuse a candidate that names a DIFFERENT family. The two halves are one
  // rule, and a registry with no lines in it holds only the permissive half: prod's
  // fourteen `Tatuaje Monster Smash` rows carry the line as free text and no
  // `line_id`, so an unconditional strike reduced `Monster Smash Frank` to `frank`,
  // which Fox's `Tatuaje Skinny Monsters Frank` covers exactly (the nine live
  // cross-line admits pinned in the `coversAsk` block below).
  //
  // So the strike WAITS for the guard that makes it safe. Both arms are asserted
  // together because neither states the rule alone.
  it("strikes the ask's line span only once a line_id can police it", () => {
    const row = {
      canonicalName: "Tatuaje Monster Series The Bride",
      brand: "Tatuaje",
      line: "Monster Series",
      brandId: "tat",
    } as const;

    // No `line_id` — every catalog row until the Wave 3 backfill. The family stays
    // a REQUIRED key, which is the conservative answer while nothing can check it.
    expect(ask({ ...row, lineId: null }).requiredKeys).toEqual(["monster", "series", "the", "bride"]);

    // With one, the contradiction arm is live and the strike is safe to make.
    expect(ask({ ...row, lineId: "line-monster-series" }).requiredKeys).toEqual(["the", "bride"]);
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
    // coverable, by a title that actually names it and adds a vitola. It has to
    // CARRY THE LINE to do so — with no `line_id` on the row, `monster series`
    // is still required (see the gate above), and a title that drops the family
    // is exactly the cross-line admit the gate exists to refuse.
    expect(coversAsk(bride, parse("Tatuaje Monster Series The Bride Churchill"))).toBe(true);
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
    // The candidate carries the line because the ask still requires it: the row
    // has no `line_id`, so nothing is struck (the gate in the `enrichAsk` block).
    // Coverage has to be satisfiable for the BRAND arm to be the thing deciding.
    const title = "Tatuaje Monster Series The Bride Churchill";
    const anchored = parse(title, registry);
    expect(anchored.brandId).toBe("brand-tatuaje");

    const row = { canonicalName: "Tatuaje Monster Series The Bride", brand: "Tatuaje", line: "Monster Series" };
    expect(coversAsk(ask({ ...row, brandId: "brand-tatuaje" }), anchored)).toBe(true);
    expect(coversAsk(ask({ ...row, brandId: "brand-drew-estate" }), anchored)).toBe(false);
    // Silence on the candidate's side is NOT a contradiction — the same
    // positive-evidence rule the seed path applies when it refuses to unlink on a
    // `no_anchor`.
    expect(coversAsk(ask({ ...row, brandId: "brand-drew-estate" }), parse(title))).toBe(true);
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
  // only the `assortment` flag stops it.
  it("never covers a sampler, however well its remaining keys fit", () => {
    const blend = ask({ canonicalName: "Drew Estate Liga Privada No. 9", brand: "Drew Estate", brandId: "de" });
    const sampler = parse("Liga Privada No. 9 Sampler");

    expect(sampler.assortment).toBe("sampler");
    expect(sampler.cleanedName).toBe("Liga Privada No. 9");
    expect(coversAsk(blend, sampler)).toBe(false);
    // The control: the same cleaned name, sold as a cigar, is covered.
    expect(coversAsk(blend, parse("Liga Privada No. 9"))).toBe(true);
  });

  // WRAPPER VARIANTS ARE SEPARATE PRODUCTS, so they are separate blends (ADR-012)
  // — a Maduro's photo slot must not be filled with the Natural's picture.
  //
  // ISOLATING THAT GATE COSTS TWO PIECES OF STRUCTURE, and supplying them is the
  // point rather than a convenience. The wrapper only gets to decide once every
  // OTHER arm is satisfiable by all three titles, so the ask carries a `line_id`
  // (which licenses the line strike, reducing the required keys to `torpedo`) and
  // the registry anchors Padron (so the candidates clear the no-anchor rule
  // below). Without both, `maduro` stays a required key and the `unstated` title
  // fails on coverage — the wrapper never speaks, and the test would be pinning
  // key coverage while claiming to pin wrapper semantics.
  it("refuses a contradicting wrapper and admits a title that states none", () => {
    const registry: ParseRegistry = {
      brands: [{ id: "brand-padron", name: "Padron", aliases: ["padron"] }],
      linesOfBrand: () => [],
      blendsOfLine: () => [],
    };
    const maduro = ask({
      canonicalName: "Padron 1964 Anniversary Maduro Torpedo",
      brand: "Padron",
      line: "1964 Anniversary Maduro",
      brandId: "brand-padron",
      lineId: "line-1964-anniversary-maduro",
    });
    expect(maduro.requiredKeys).toEqual(["torpedo"]);

    expect(coversAsk(maduro, parse("Padron 1964 Anniversary Maduro Torpedo", registry))).toBe(true);
    expect(coversAsk(maduro, parse("Padron 1964 Anniversary Natural Torpedo", registry))).toBe(false);
    // `unstated` is not a disagreement: a vendor naming no wrapper has made no
    // claim, and refusing it would invent a distinction the vendor did not make.
    expect(coversAsk(maduro, parse("Padron 1964 Anniversary Torpedo", registry))).toBe(true);

    // And the second piece of structure earns its place too: the SAME title, run
    // against a registry that anchors nothing, is refused — `torpedo` alone is
    // vitola vocabulary, not an identity claim (the no-anchor rule below).
    expect(coversAsk(maduro, parse("Padron 1964 Anniversary Maduro Torpedo"))).toBe(false);
  });

  // ==========================================================================
  // THE NINE LIVE CROSS-LINE ADMITS, measured in prod before the line strike was
  // gated on `line_id`. Fourteen `Tatuaje Monster Smash <name>` rows carry
  // `line = 'Monster Smash'` as free text and `line_id = NULL`; Fox stocks the
  // adjacent `Tatuaje Skinny Monsters <name>` family. Struck unconditionally, the
  // ask `Monster Smash Frank` reduced to `frank` — which `Tatuaje Skinny Monsters
  // Frank` covers exactly — and a whole sibling family began answering each
  // other's photo asks, permanently, into the one photo slot ADR-007 allows.
  //
  // Nine of those pairs were live. They are pinned individually rather than as a
  // loop over names because each is a distinct production row, and a loop that
  // silently iterated zero times would pass.
  // ==========================================================================
  const SMASH_SIBLINGS = ["Chuck", "Drac", "Face", "Frank", "Hyde", "Jekyll", "Tiff", "Wolf"] as const;

  const smashAsk = (name: string) =>
    ask({ canonicalName: `Tatuaje Monster Smash ${name}`, brand: "Tatuaje", line: "Monster Smash", brandId: "tat" });

  it.each(SMASH_SIBLINGS)("Monster Smash %s is not covered by its Skinny Monsters namesake", (name) => {
    expect(coversAsk(smashAsk(name), parse(`Tatuaje Skinny Monsters ${name}`))).toBe(false);
  });

  // Fox's real listing for the ninth, phrased as a sentence rather than a title.
  it("does not admit Fox's `Creature from Tatuaje` against Monster Smash Creature", () => {
    expect(coversAsk(smashAsk("Creature"), parse("Creature from Tatuaje"))).toBe(false);
  });

  // THE CONTROL FOR ALL NINE. Without it the zeros above are satisfied by a rule
  // that refuses everything: the ask is coverable, by a title that names its own
  // family and adds packaging and a vitola on top.
  it("still admits a Monster Smash listing for the Monster Smash ask", () => {
    expect(
      coversAsk(smashAsk("Frank"), parse("Tatuaje Monster Smash Frank Box-Pressed Robusto Extra")),
    ).toBe(true);
  });

  // A CANDIDATE THAT ANCHORS NO BRAND MUST BE EARNED BY A REAL NAME. Prod's ask
  // `Diplomaticos No 2` is a Cuban torpedo; struck of its marca its required keys
  // are `["no", "2"]` — one grammar word and one bare ordinal, which is not an
  // identity claim at all. Coverage is the ONLY thing admitting a candidate that
  // anchors nothing, so an ask that claims nothing admits nearly anything: the
  // real prod row `Mark Twain Memoir No. 2 Gordo` covers `no 2` exactly, and a
  // Cuban torpedo's one photo slot would have been filled by an unrelated bundle.
  //
  // This is why coverage alone cannot admit a no-anchor candidate. The rule is
  // narrow on purpose — it asks whether the ASK said anything, not whether the
  // candidate looks plausible — and a candidate that DOES anchor the ask's brand
  // has already cleared a positive check and is never held to it.
  it("refuses a no-anchor candidate when the ask's own keys claim no identity", () => {
    const diplomaticos = ask({ canonicalName: "Diplomaticos No 2", brand: "Diplomaticos", brandId: "dip" });
    expect(diplomaticos.requiredKeys).toEqual(["no", "2"]);

    const markTwain = parse("Mark Twain Memoir No. 2 Gordo – Pack of 20");
    expect(markTwain.brandId).toBeNull();
    expect(coversAsk(diplomaticos, markTwain)).toBe(false);

    // THE CONTROL, and it locates the rule precisely: the same ask, the same
    // empty required keys, admitted the moment a candidate anchors the marca.
    const registry: ParseRegistry = {
      brands: [{ id: "brand-diplomaticos", name: "Diplomaticos", aliases: ["diplomaticos"] }],
      linesOfBrand: () => [],
      blendsOfLine: () => [],
    };
    const anchoredAsk = ask({ canonicalName: "Diplomaticos No 2", brand: "Diplomaticos", brandId: "brand-diplomaticos" });
    const anchoredTitle = parse("Diplomaticos No. 2 Torpedo", registry);
    expect(anchoredTitle.brandId).toBe("brand-diplomaticos");
    expect(coversAsk(anchoredAsk, anchoredTitle)).toBe(true);
  });

  // ONE IDENTITY LANGUAGE FOR THE WHOLE REPO (#235). `coversAsk` and
  // `identityTokensCompatible` must never disagree about product identity: a
  // matcher that admitted a pair the strong-link guard refuses would be a second
  // opinion, and the Face/Bride defect is what having two opinions costs. So the
  // implication is asserted directly — incompatible ⟹ not covered — over a table
  // of pairs that exercises both verdicts.
  //
  // The implication is ONE-WAY, and the last row is the proof. `coversAsk` holds
  // rules `identityTokensCompatible` knows nothing about (the no-anchor rule
  // above, the sampler flag, the id contradictions), so a COMPATIBLE pair may
  // still be refused. The two rules are independent; what they may not do is
  // contradict each other.
  //
  // THIS IS AN INVARIANT TEST, NOT A REGRESSION FIXTURE, and the distinction is
  // worth stating because the invariant currently holds for free. Key coverage is
  // strictly stricter than the guard on the query side — `identityName` IS
  // `requiredKeys.join(" ")`, so coverage passing means every required key was
  // shared, which means an empty query residue, which means compatible. No pair
  // below is refused by the guard alone; deleting the guard from `coversAsk`
  // fails nothing here. It earns its place by making the invariant explicit and
  // by holding if coverage is ever loosened — not by fixing a live miss.
  it("never admits a pair the shared identity guard calls incompatible", () => {
    const liga = () => ask({ canonicalName: "Drew Estate Liga Privada No. 9", brand: "Drew Estate", brandId: "de" });
    const cases: ReadonlyArray<{ ask: EnrichAsk; title: string; compatible: boolean; covers: boolean }> = [
      // The flagship, both of its vitolas: the ask's residue is empty once its
      // brand is struck, so the pair is compatible and coverage carries it.
      { ask: liga(), title: "Liga Privada No. 9 Corona Viva", compatible: true, covers: true },
      { ask: liga(), title: "Liga Privada No. 9 Corona Doble", compatible: true, covers: true },
      // ...and the sibling blend trigram ranks ABOVE those two is refused by both.
      { ask: liga(), title: "Liga Privada T52 Robusto", compatible: false, covers: false },
      // The cross-line admits again, this time as an identity disagreement:
      // `{smash}` against `{skinny}`, which is two different claims.
      { ask: smashAsk("Frank"), title: "Tatuaje Skinny Monsters Frank", compatible: false, covers: false },
      { ask: smashAsk("Tiff"), title: "Tatuaje Skinny Monsters Tiff", compatible: false, covers: false },
      { ask: smashAsk("Creature"), title: "Creature from Tatuaje", compatible: false, covers: false },
      {
        ask: ask({ canonicalName: "Tatuaje Monster Series The Bride", brand: "Tatuaje", line: "Monster Series", brandId: "tat" }),
        title: "Tatuaje Skinny Monsters Tiff",
        compatible: false,
        covers: false,
      },
      // The unaliased marca abbreviation: `hdm` survives into the residue and
      // meets `classic`, so both rules read a disagreement.
      {
        ask: ask({
          canonicalName: "HdM Epicure Especial",
          brand: "Hoyo de Monterrey",
          brandId: "hdm",
          brandAliases: ["hoyo-de-monterrey"],
        }),
        title: "Hoyo De Monterrey Classic No. 450 EMS Robusto",
        compatible: false,
        covers: false,
      },
      // A vitola listing under a blend-level ask, agreed on by both.
      {
        ask: ask({ canonicalName: "Caldwell Long Live the King The Heater", brand: "Caldwell", brandId: "cw" }),
        title: "Caldwell Long Live the King The Heater Robusto",
        compatible: true,
        covers: true,
      },
      // THE INDEPENDENCE PROOF. `no 2` against `Mark Twain Memoir No. 2 Gordo`
      // leaves the ask no residue at all, so the shared guard is content — and
      // `coversAsk` refuses anyway, on the no-anchor rule. Compatible does not
      // imply covered, and only the reverse implication is asserted below.
      {
        ask: ask({ canonicalName: "Diplomaticos No 2", brand: "Diplomaticos", brandId: "dip" }),
        title: "Mark Twain Memoir No. 2 Gordo – Pack of 20",
        compatible: true,
        covers: false,
      },
    ];

    for (const testCase of cases) {
      const parsed = parse(testCase.title);
      const compatible = identityTokensCompatible(testCase.ask.identityName, parsed.cleanedName);
      expect({ title: testCase.title, compatible }).toEqual({ title: testCase.title, compatible: testCase.compatible });
      expect({ title: testCase.title, covers: coversAsk(testCase.ask, parsed) }).toEqual({
        title: testCase.title,
        covers: testCase.covers,
      });
      // The invariant itself, stated once per pair rather than inferred from the
      // table: nothing the guard refuses may ever be covered.
      if (!compatible) expect(coversAsk(testCase.ask, parsed)).toBe(false);
    }
  });
});

// THE PREFILTER (#240) — the step BEFORE `coversAsk`, which decides which of a
// vendor's ~2,000 product URLs are worth a page fetch for one ask. It is not a
// verdict, but it is the only reason a look ever reaches `coversAsk` at all, and
// on prod it was quietly deciding everything: four nights of drains, 58 of 58
// attempts `miss`, 0 cigars enriched, while the offers path auto-matched 992
// listings over the same vendors and the same URLs.
//
// EVERY SLUG BELOW IS A REAL ONE, read off prod's `listing_matches` for Fox Cigar
// and Cuban Lou's on 2026-09-01, and every ask is a real open row from
// `enrichment_requests`. The old prefilter's four defects are one case each.
describe("rankEnrichCandidates", () => {
  // The candidate as the drain builds it: a product URL path and the folded keys
  // of its last segment.
  const candidate = (path: string) => ({ path, keys: enrichCandidateKeys(path) });

  const rank = (a: EnrichAsk, paths: string[], limit = 8): string[] =>
    rankEnrichCandidates(a, paths.map(candidate), limit).map((c) => c.path);

  // ACCENTS SPLIT WORDS. The old prefilter lowercased and split on `[^a-z0-9]+`,
  // which treats `ó` as a separator — so the ask's own marca arrived as `bol` and
  // `var` and met `bolivar` on neither. `fold()` is the projection every alias key
  // in the database is made with; both sides go through it now.
  it("folds accents on both sides, so the marca meets the vendor's slug", () => {
    const bolivar = ask({ canonicalName: "Bolívar Belicosos Finos", brand: "Bolívar", brandId: "bol" });

    expect(bolivar.brandKeys).toEqual(["bolivar"]);
    expect(scoreEnrichCandidate(bolivar, enrichCandidateKeys("/cuban-cigars/bolivar-belicosos-finos/"))).toEqual({
      identity: 2,
      detail: 0,
      brand: 1,
    });
  });

  // THE THREE-CHARACTER FLOOR ATE THE DISCRIMINATORS. `vi` is the whole of what
  // separates a Siglo VI from a Siglo I, and the old filter dropped both.
  it("scores the short tokens that are the entire identity claim", () => {
    const siglo = ask({ canonicalName: "Cohiba Siglo VI", brand: "Cohiba", brandId: "coh" });

    expect(rank(siglo, ["/cuban-cigars/cohiba-siglo-i/", "/cuban-cigars/cohiba-siglo-vi/"])).toEqual([
      "/cuban-cigars/cohiba-siglo-vi/",
      "/cuban-cigars/cohiba-siglo-i/",
    ]);
  });

  // THE FLAGSHIP, and the one that cost prod four nights. Unweighted overlap
  // scored a brand word exactly as high as an identity word, so Fox's five Tabak
  // Especials scored 2 on `{drew, estate}` — the same 2 the real answer scores on
  // `{liga, privada}` — and ties keep enumeration order, so eight of them filled
  // the shortlist and `liga-privada-no-9-corona-doble-2` was never fetched. That
  // is ADR-012's own flagship case being lost one step before the rule written to
  // fix it ever saw a candidate.
  it("ranks identity words above the marca, so the ask's own blend is not crowded out", () => {
    const liga = ask({ canonicalName: "Drew Estate Liga Privada No. 9", brand: "Drew Estate", brandId: "de" });
    const fox = [
      "/shop/cigars/drew-estate-tabak-especial-cafecita-dulce/",
      "/shop/cigars/drew-estate-tabak-especial-toro-negra/",
      "/shop/cigars/drew-estate-tabak-especial-cafecita-negra/",
      "/shop/cigars/drew-estate-tabak-especial-gordito-negra/",
      "/shop/cigars/drew-estate-tabak-especial-robusto-negra/",
      "/shop/cigars/liga-privada-t52-robusto-2/",
      "/shop/cigars/liga-privada-h99-super-ancho-3/",
      "/shop/cigars/liga-privada-10-aniversario-toro-2/",
      "/shop/cigars/liga-privada-no-9-corona-doble-2/",
    ];

    // The bare ordinal is the tie-break among the Liga Privadas — `no` and `9`
    // say which blend, and nothing else in the ask does.
    expect(rank(liga, fox)[0]).toBe("/shop/cigars/liga-privada-no-9-corona-doble-2/");
    expect(rank(liga, fox).slice(0, 4)).not.toContain(
      "/shop/cigars/drew-estate-tabak-especial-cafecita-dulce/",
    );
  });

  // TRADE VOCABULARY SCORED AT ALL. Fox has never stocked Caldwell, and the old
  // prefilter still drew it eight pages of unrelated cigars on `robusto` alone,
  // spent the fetches, and retired the ask as looked-at. `robusto` is a vitola on
  // half the catalogue, so it says nothing about which cigar this is — the same
  // list `coversAsk` uses to decide that is the list used here.
  it("gives no candidate to an ask whose only shared words are the trade's", () => {
    const caldwell = ask({
      canonicalName: "Caldwell Midnight Express Robusto",
      brand: "Caldwell",
      brandId: "cw",
    });

    expect(
      rank(caldwell, [
        "/shop/cigars/tatuaje-black-label-robusto/",
        "/shop/cigars/cao-zocalo-robusto-2/",
        "/shop/cigars/undercrown-el-tigre-dominicano-robusto/",
      ]),
    ).toEqual([]);
  });

  // ...AND THE MARCA STILL BUYS A LOOK, which is what keeps `miss` reachable. Fox
  // stocks Red Anchor — the Admiral, not the Captain — so the ask deserves a page
  // fetch and the honest answer "we read this shop's Red Anchors". An empty
  // shortlist here would record `no_candidate` and the ask would never retire.
  it("admits the marca's own shelf, so a real miss stays reachable", () => {
    const captain = ask({ canonicalName: "Red Anchor Captain", brand: "Red Anchor", brandId: "ra" });

    expect(rank(captain, ["/shop/cigars/red-anchor-admiral-2/", "/shop/cigars/cohiba-blue-toro-2/"])).toEqual([
      "/shop/cigars/red-anchor-admiral-2/",
    ]);
  });

  // The last path segment is the product slug; everything above it is the vendor's
  // merchandising taxonomy, which ADR-012 keeps as evidence and refuses to match
  // on. Cuban Lou's files Habanos under `/cuban-cigars/`, and letting that segment
  // score would hand every Cuban ask the same 985 candidates.
  it("reads the product slug only, never the category path above it", () => {
    const media = ask({ canonicalName: "Trinidad Media Luna", brand: "Trinidad", brandId: "tri" });

    expect(enrichCandidateKeys("/cuban-cigars/trinidad-media-luna/")).toEqual(
      new Set(["trinidad", "media", "luna"]),
    );
    expect(rank(media, ["/cuban-cigars/trinidad-espiritu-series-3-toro-2/", "/cuban-cigars/trinidad-media-luna/"])[0])
      .toBe("/cuban-cigars/trinidad-media-luna/");
  });

  // THE INVARIANT THAT MAKES THIS A PREFILTER AND NOT A SECOND MATCHER: the
  // shortlist may never drop a listing `coversAsk` would have linked. Both sides
  // read the same folded keys, so a covering candidate's slug carries every one of
  // the ask's required keys — and either one of them is identity-bearing (the
  // first arm) or the ask has no identity claim of its own and rides on its marca
  // (the second, which is `Diplomaticos No 2`). Asserted over the same pairs the
  // coverage table above admits, from their vendor slugs.
  it("never drops a candidate coversAsk would have linked", () => {
    const pairs: { ask: EnrichAsk; path: string }[] = [
      {
        ask: ask({ canonicalName: "Drew Estate Liga Privada No. 9", brand: "Drew Estate", brandId: "de" }),
        path: "/shop/cigars/liga-privada-no-9-corona-viva/",
      },
      {
        ask: ask({ canonicalName: "Bolívar Belicosos Finos", brand: "Bolívar", brandId: "bol" }),
        path: "/cuban-cigars/bolivar-belicosos-finos/",
      },
      {
        ask: ask({ canonicalName: "Cohiba Siglo VI", brand: "Cohiba", brandId: "coh" }),
        path: "/cuban-cigars/cohiba-siglo-vi-box-of-25/",
      },
      // No identity claim of its own once the marca comes off (`no 2` is grammar
      // and a bare ordinal), so the brand arm is the one that has to admit it.
      {
        ask: ask({ canonicalName: "Diplomaticos No 2", brand: "Diplomaticos", brandId: "dip" }),
        path: "/cuban-cigars/diplomaticos-no-2/",
      },
    ];

    for (const pair of pairs) {
      const keys = enrichCandidateKeys(pair.path);
      // The coverage rule itself, read off the same keys: every required key is
      // there, which is what makes this pair one `coversAsk` would admit.
      expect({ path: pair.path, covered: pair.ask.requiredKeys.every((k) => keys.has(k)) }).toEqual({
        path: pair.path,
        covered: true,
      });
      expect({ path: pair.path, ranked: rank(pair.ask, [pair.path]) }).toEqual({
        path: pair.path,
        ranked: [pair.path],
      });
    }
  });
});
