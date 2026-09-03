import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { blends, brands, cigars, lines } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { brandSlug } from "./catalog-browse.js";
import { fold } from "./taxonomy-keys.js";
import {
  assortmentOf,
  parseListing,
  scopedLeafCandidates,
  chooseLeaf,
  findUnlinkedNameCollision,
  resolveDescribedTaxonomy,
  loadAncestryContext,
  loadNamePartsForCigar,
} from "./taxonomy-resolve.js";
import {
  assertCigarAncestry,
  type CigarAncestry,
  type CigarAncestryContext,
} from "./cigar-ancestry.js";
import { ValidationError } from "./errors.js";

// Matching v2 against real registries and a real Postgres (ADR-012 Wave 2). The
// decisions are pure and tested in catalog-parse.test.ts; what this file proves
// is that the GIN alias probe, the brand-scoped candidate query and the leaf
// choice hold together over actual rows.

describe("taxonomy resolution", () => {
  let h: DomainHarness;

  // Aliases hold MATCHING KEYS, never display text — the convention migration
  // 0026 seeds and the only thing the exact-match GIN probe can find.
  const seedBrand = async (name: string): Promise<string> => {
    const rows = await h.deps.db
      .insert(brands)
      .values({ name, slug: brandSlug(name), aliases: [...new Set([brandSlug(name), fold(name)])] })
      .returning({ id: brands.id });
    return rows[0]!.id;
  };
  const seedLine = async (brandId: string, name: string, extra: string[] = []): Promise<string> => {
    const rows = await h.deps.db
      .insert(lines)
      .values({ brandId, name, slug: brandSlug(name), aliases: [...new Set([fold(name), ...extra.map(fold)])] })
      .returning({ id: lines.id });
    return rows[0]!.id;
  };
  const seedBlend = async (lineId: string, name: string): Promise<string> => {
    const rows = await h.deps.db
      .insert(blends)
      .values({ lineId, name, slug: brandSlug(name), aliases: [fold(name)] })
      .returning({ id: blends.id });
    return rows[0]!.id;
  };

  let padronId: string;
  let drewEstateId: string;
  let anniversaryId: string;
  let ligaPrivadaId: string;
  let maduroId: string;
  let naturalId: string;

  beforeAll(async () => {
    h = await createHarness();
    padronId = await seedBrand("Padrón");
    drewEstateId = await seedBrand("Drew Estate");
    anniversaryId = await seedLine(padronId, "1964 Anniversary Series", ["1964 Anniversary"]);
    ligaPrivadaId = await seedLine(drewEstateId, "Liga Privada");
    maduroId = await seedBlend(anniversaryId, "Maduro");
    naturalId = await seedBlend(anniversaryId, "Natural");
    await seedBlend(ligaPrivadaId, "No. 9");
    await seedBlend(ligaPrivadaId, "T52");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  describe("parseListing", () => {
    // The accented spelling is what makes the two key rules earn their keep: the
    // brand's SLUG is `padr-n` and no folded title token can ever equal that, so
    // the probe only works because `aliases` carries the folded `padron`.
    it("anchors an accented marca through its folded alias", async () => {
      const parse = await parseListing(h.deps.db, "Padrón 1964 Anniversary Series Maduro Torpedo");
      expect(parse).toMatchObject({
        brandId: padronId,
        lineId: anniversaryId,
        blendId: maduroId,
        vitolaName: "Torpedo",
      });
    });

    it("anchors the unaccented spelling of the same marca", async () => {
      const parse = await parseListing(h.deps.db, "Padron 1964 Anniversary Natural Exclusivo");
      expect(parse).toMatchObject({ brandId: padronId, lineId: anniversaryId, blendId: naturalId });
    });

    it("yields no anchor for a marca the registry does not know", async () => {
      const parse = await parseListing(h.deps.db, "Xikar HP3 Lighter");
      expect(parse.brandId).toBeNull();
    });
  });

  // The named-name half of the assortment rule (#164 Q1), which the JOURNAL asks
  // — a described cigar never goes through `parseListingTitle`, so it needs the
  // same verdict over a bare string.
  describe("assortmentOf", () => {
    it("reads the shelf words with no query at all", async () => {
      expect(await assortmentOf(h.deps.db, "Drew Estate Free 8-Cigar Sampler")).toBe("sampler");
      expect(await assortmentOf(h.deps.db, "Mix & Match Cuban Cigar Bundle")).toBe("mix-and-match");
      expect(await assortmentOf(h.deps.db, "Club & Mini Outlet Bundle Deal")).toBe("bundle-deal");
    });

    it("asks the registry when a name joins two claims", async () => {
      expect(await assortmentOf(h.deps.db, "Padrón & Drew Estate DOMINICAN Bundle")).toBe("multi-brand");
      // One marca joined to a word that is not one is still one cigar.
      expect(await assortmentOf(h.deps.db, "Padrón 1964 Anniversary Maduro & Natural Toro")).toBe(null);
    });

    it("leaves an ordinary described cigar alone", async () => {
      expect(await assortmentOf(h.deps.db, "Padrón 1964 Anniversary Maduro Torpedo")).toBe(null);
      // The `mazo` inside `Amazon`, again: the assortment rule reads the same
      // names the packaging strip does, so the trap has to be closed in both.
      expect(await assortmentOf(h.deps.db, "CAO Brazilia Amazon")).toBe(null);
      expect(await assortmentOf(h.deps.db, "Dominican Bundles Toro")).toBe(null);
    });

    // Structural scoping, enforced by the query rather than by a filter that could
    // be forgotten: `lines` are probed WHERE brand_id = the anchor.
    it("refuses a line that belongs to a different brand", async () => {
      const parse = await parseListing(h.deps.db, "Padrón Liga Privada No. 9");
      expect(parse).toMatchObject({ brandId: padronId, lineId: null, blendId: null });
    });
  });

  describe("scopedLeafCandidates", () => {
    it("returns only leaves of the anchored brand", async () => {
      const mine = await h.seedCigar({ canonicalName: "Padron Scope Probe A", brandId: padronId });
      await h.seedCigar({ canonicalName: "Drew Estate Scope Probe A", brandId: drewEstateId });

      const parse = await parseListing(h.deps.db, "Padrón Scope Probe A");
      const candidates = await scopedLeafCandidates(h.deps.db, parse);
      expect(candidates.map((c) => c.cigarId)).toContain(mine);
      expect(candidates.every((c) => c.brandId === padronId || c.brandId === null)).toBe(true);
    });

    // THE TRANSITIONAL BRIDGE. 0026 linked `brand_id` only for rows that already
    // carried a free-text brand; 565 active rows carry none. Without admitting
    // them by name, a re-crawl would find no candidate and MINT A DUPLICATE of
    // each — the migration meant to end per-vendor catalogs would double them.
    it("admits an unlinked row whose own name begins with the brand key", async () => {
      const orphan = await h.seedCigar({ canonicalName: "Padron Orphan Bridge Robusto", brandId: null });
      const parse = await parseListing(h.deps.db, "Padron Orphan Bridge Robusto");
      const candidates = await scopedLeafCandidates(h.deps.db, parse);
      expect(candidates.map((c) => c.cigarId)).toContain(orphan);
    });

    // The bridge reads EVERY key the brand answers to, from the registry — not
    // fold(name). A brand whose catalog spelling differs from its registered name
    // would otherwise see none of its own orphans.
    it("admits an orphan through an alias that is not the brand's display name", async () => {
      const rows = await h.deps.db
        .insert(brands)
        .values({ name: "Tatuaje Cigars Inc.", slug: "tatuaje-cigars-inc", aliases: ["tatuaje", "tatuaje-cigars-inc"] })
        .returning({ id: brands.id });
      void rows;
      const orphan = await h.seedCigar({ canonicalName: "Tatuaje Miami Broadleaf Robusto", brandId: null });
      const parse = await parseListing(h.deps.db, "Tatuaje Miami Broadleaf Robusto");
      expect(parse.brandName).toBe("Tatuaje Cigars Inc.");
      const candidates = await scopedLeafCandidates(h.deps.db, parse);
      expect(candidates.map((c) => c.cigarId)).toContain(orphan);
    });

    // A one- or two-character key drags every unrelated marca starting with that
    // syllable into scope. Three characters is the floor.
    //
    // The anchor now refuses a key that short outright (MIN_ANCHOR_KEY_LENGTH), so
    // this brand is anchored by its LONG key and carries the short one alongside —
    // which is the state that keeps the SQL floor load-bearing rather than
    // redundant. The bridge unnests every alias the brand answers to, so a short
    // one still reaches the prefix scan however the brand was anchored.
    it("does not let a two-letter alias drag in unrelated rows by prefix", async () => {
      await h.deps.db
        .insert(brands)
        .values({ name: "La Aurora", slug: "la-aurora", aliases: ["la-aurora", "la"] })
        .returning({ id: brands.id });
      const unrelated = await h.seedCigar({ canonicalName: "La Flor Dominicana Ligero L-40", brandId: null });
      const parse = await parseListing(h.deps.db, "La Aurora Something Robusto");
      expect(parse.brandName).toBe("La Aurora");
      const candidates = await scopedLeafCandidates(h.deps.db, parse);
      expect(candidates.map((c) => c.cigarId)).not.toContain(unrelated);
    });

    it("does not admit an unlinked row of some other marca", async () => {
      const other = await h.seedCigar({ canonicalName: "Oliva Serie V Bridge Robusto", brandId: null });
      const parse = await parseListing(h.deps.db, "Padron Orphan Bridge Robusto");
      const candidates = await scopedLeafCandidates(h.deps.db, parse);
      expect(candidates.map((c) => c.cigarId)).not.toContain(other);
    });

    it("excludes rows that are not active", async () => {
      const excluded = await h.seedCigar({
        canonicalName: "Padron Excluded Bridge Robusto",
        brandId: padronId,
        catalogStatus: "excluded",
      });
      const parse = await parseListing(h.deps.db, "Padron Excluded Bridge Robusto");
      const candidates = await scopedLeafCandidates(h.deps.db, parse);
      expect(candidates.map((c) => c.cigarId)).not.toContain(excluded);
    });

    it("returns nothing when the title anchored no brand", async () => {
      const parse = await parseListing(h.deps.db, "Xikar HP3 Lighter");
      expect(await scopedLeafCandidates(h.deps.db, parse)).toEqual([]);
    });
  });

  describe("the ADR-012 inversion cases, end to end", () => {
    // Trigram ranks these two as the catalog's closest "duplicate" pair while
    // ranking true siblings below 0.5. Under matching v2 they resolve through
    // different blend ids, so no similarity score is ever consulted.
    it("Liga Privada No. 9 and T52 never resolve to each other", async () => {
      const nine = await h.seedCigar({
        canonicalName: "Drew Estate Liga Privada No. 9 Toro",
        brandId: drewEstateId,
        lineId: ligaPrivadaId,
        blendId: (await h.deps.db.select({ id: blends.id }).from(blends).where(eq(blends.name, "No. 9")).limit(1))[0]!
          .id,
      });
      const t52 = await h.seedCigar({
        canonicalName: "Drew Estate Liga Privada T52 Toro",
        brandId: drewEstateId,
        lineId: ligaPrivadaId,
        blendId: (await h.deps.db.select({ id: blends.id }).from(blends).where(eq(blends.name, "T52")).limit(1))[0]!.id,
      });

      const nineParse = await parseListing(h.deps.db, "Drew Estate Liga Privada No. 9 Toro");
      const nineChoice = chooseLeaf(nineParse, await scopedLeafCandidates(h.deps.db, nineParse));
      expect(nineChoice.kind).toBe("one");
      expect(nineChoice.kind === "one" && nineChoice.candidate.cigarId).toBe(nine);

      const t52Parse = await parseListing(h.deps.db, "Drew Estate Liga Privada T52 Toro");
      const t52Choice = chooseLeaf(t52Parse, await scopedLeafCandidates(h.deps.db, t52Parse));
      expect(t52Choice.kind).toBe("one");
      expect(t52Choice.kind === "one" && t52Choice.candidate.cigarId).toBe(t52);
    });

    // Wrapper variants marketed as separate products are distinct blends, because
    // that is how they are sold. In production `Padron 1964 Anniversary Natural`
    // is ONE row holding twelve listings spanning both wrappers.
    it("Padrón 1964 Maduro and Natural resolve to different leaves", async () => {
      const maduroLeaf = await h.seedCigar({
        canonicalName: "Padron 1964 Anniversary Maduro Exclusivo",
        brandId: padronId,
        lineId: anniversaryId,
        blendId: maduroId,
        vitolaName: "Exclusivo",
      });
      const naturalLeaf = await h.seedCigar({
        canonicalName: "Padron 1964 Anniversary Natural Exclusivo",
        brandId: padronId,
        lineId: anniversaryId,
        blendId: naturalId,
        vitolaName: "Exclusivo",
      });

      const maduroParse = await parseListing(h.deps.db, "Padrón 1964 Anniversary Maduro Exclusivo");
      const maduroChoice = chooseLeaf(maduroParse, await scopedLeafCandidates(h.deps.db, maduroParse));
      expect(maduroChoice.kind === "one" && maduroChoice.candidate.cigarId).toBe(maduroLeaf);

      const naturalParse = await parseListing(h.deps.db, "Padrón 1964 Anniversary Natural Exclusivo");
      const naturalChoice = chooseLeaf(naturalParse, await scopedLeafCandidates(h.deps.db, naturalParse));
      expect(naturalChoice.kind === "one" && naturalChoice.candidate.cigarId).toBe(naturalLeaf);

      expect(maduroLeaf).not.toBe(naturalLeaf);
    });

    // A stated vitola that agrees exactly beats a sibling whose vitola is unknown.
    // An unknown vitola is an ABSENCE, not a match, and preferring it is how the
    // collapse buckets formed one blend at a time.
    it("prefers the sibling whose vitola actually agrees", async () => {
      const brandId = await seedBrand("Vitola Pref Co");
      const lineId = await seedLine(brandId, "Reserva");
      const blendId = await seedBlend(lineId, "Oscuro");
      await h.seedCigar({
        canonicalName: "Vitola Pref Co Reserva Oscuro",
        brandId,
        lineId,
        blendId,
        vitolaName: null,
      });
      const toro = await h.seedCigar({
        canonicalName: "Vitola Pref Co Reserva Oscuro Toro",
        brandId,
        lineId,
        blendId,
        vitolaName: "Toro",
      });

      const parse = await parseListing(h.deps.db, "Vitola Pref Co Reserva Oscuro Toro");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind === "one" && choice.candidate.cigarId).toBe(toro);
    });

    // Two structurally identical leaves is a collapse bucket that still needs
    // splitting, and minting a third would be that failure running in reverse.
    it("refuses to choose between two leaves sharing the parsed structure", async () => {
      const brandId = await seedBrand("Ambiguous Marca");
      const lineId = await seedLine(brandId, "Primera");
      const blendId = await seedBlend(lineId, "Claro");
      await h.seedCigar({ canonicalName: "Ambiguous Marca Primera Claro A", brandId, lineId, blendId });
      await h.seedCigar({ canonicalName: "Ambiguous Marca Primera Claro B", brandId, lineId, blendId });

      const parse = await parseListing(h.deps.db, "Ambiguous Marca Primera Claro");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("many");
    });

    // A sampler spans blends, so it names no single leaf. It is not ambiguous
    // between two products so much as about none of them, but the honest outcome
    // is identical: a human decides and nothing is minted.
    it("never resolves a sampler to a leaf", async () => {
      const parse = await parseListing(h.deps.db, "Padrón 1964 Anniversary Sampler");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      // Its OWN arm, not an ambiguity with an empty candidate list: an ambiguous
      // listing is about several leaves and an assortment is about none of them,
      // and the counter that watches for unsplit collapse buckets must not be fed
      // by a shop's sampler shelf.
      expect(choice.kind).toBe("assortment");
    });

    // ORDER MATTERS HERE. `none` is the arm that licenses seed mode to mint, so
    // an assortment tested after the empty-candidate check would mint a catalog
    // row called "Sampler" for every assortment of a marca whose leaves are not
    // in the catalog yet — which is the newest brand in every single crawl.
    it("refuses a sampler even when the brand has no leaves at all", async () => {
      await seedBrand("Sampler Only Marca");
      const parse = await parseListing(h.deps.db, "Sampler Only Marca Assortment Sampler");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("assortment");
    });

    // TWO MARCAS JOINED IS A SHELF (#164 Q1), and the registry is what says so —
    // the rule hand-writes no brand list, it asks the alias probe whether each
    // half of the conjunction names a marca.
    it("refuses a listing that joins two marcas", async () => {
      const parse = await parseListing(h.deps.db, "Padrón & Drew Estate DOMINICAN Bundle (Outlet)");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("assortment");
      expect(choice.kind === "assortment" && choice.reason).toBe("multi-brand");
    });

    it("reports no leaf when the brand is known but the product is new", async () => {
      const brandId = await seedBrand("Empty Marca");
      void brandId;
      const parse = await parseListing(h.deps.db, "Empty Marca Something New Robusto");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("none");
    });
  });

  // THE COMPARISON HAD TO BE SYMMETRIC. `parse.cleanedName` goes through
  // `stripPackaging`; a candidate's `canonical_name` did not — so a catalog row
  // carrying a container word in its name (which is most of what v1 minted)
  // disqualified itself against the very listing it came from. 70 of the 94
  // anchored losses measured on prod were this, and each one was a mint of a row
  // that already existed.
  describe("packaging symmetry in the freeform arm", () => {
    it("matches a catalog row whose own name still carries its packaging", async () => {
      const brandId = await seedBrand("Punch");
      const leaf = await h.seedCigar({ canonicalName: "Punch Bolos Tin", brandId });
      const parse = await parseListing(h.deps.db, "Punch Bolos Tin");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("one");
      expect(choice.kind === "one" && choice.candidate.cigarId).toBe(leaf);
    });

    it("matches across every container word the vocabulary knows", async () => {
      const brandId = await seedBrand("Symmetry Marca");
      for (const [index, token] of ["Pack", "Tin", "Tubos"].entries()) {
        const leaf = await h.seedCigar({ canonicalName: `Symmetry Marca Vitola${index} ${token}`, brandId });
        const parse = await parseListing(h.deps.db, `Symmetry Marca Vitola${index} ${token}`);
        const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
        expect(choice.kind, `${token} listing`).toBe("one");
        expect(choice.kind === "one" && choice.candidate.cigarId).toBe(leaf);
      }
    });

    // The case from the review, and the shape that hurt most: the listing states
    // no packaging and the CATALOG row does. Before the fix the listing cleaned
    // to a name the row could never be compatible with, so seed mode minted a
    // second Davidoff Puro Dominicano Perfecto beside the first.
    it("matches a bare listing to a row minted with packaging in its name", async () => {
      const brandId = await seedBrand("Davidoff");
      const leaf = await h.seedCigar({ canonicalName: "Davidoff Puro Dominicano Perfecto Tubos", brandId });
      const parse = await parseListing(h.deps.db, "Davidoff Puro Dominicano Perfecto");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("one");
      expect(choice.kind === "one" && choice.candidate.cigarId).toBe(leaf);
    });
  });

  // A listing naming a wrapper against a row naming none is the collapse bucket
  // itself — one row standing for both wrappers, which this listing has just told
  // apart. Not a link and not a miss: a question, and one that is only safe to
  // ask now because triage ANNOTATES an existing link rather than breaking it.
  describe("the wrapper-variant question", () => {
    it("refuses to link a stated wrapper to a leaf that states none", async () => {
      const brandId = await seedBrand("Variant Marca");
      const leaf = await h.seedCigar({ canonicalName: "Variant Marca Reserva Robusto", brandId });
      const parse = await parseListing(h.deps.db, "Variant Marca Reserva Robusto Maduro");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("many");
      expect(choice.kind === "many" && choice.candidates.map((c) => c.cigarId)).toEqual([leaf]);
    });

    it("prefers the sibling whose wrapper actually agrees", async () => {
      const brandId = await seedBrand("Wrapper Pref Marca");
      const bare = await h.seedCigar({ canonicalName: "Wrapper Pref Marca Toro", brandId });
      const maduro = await h.seedCigar({ canonicalName: "Wrapper Pref Marca Toro Maduro", brandId });
      const parse = await parseListing(h.deps.db, "Wrapper Pref Marca Toro Maduro");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("one");
      expect(choice.kind === "one" && choice.candidate.cigarId).toBe(maduro);
      expect(bare).not.toBe(maduro);
    });

    // Three spellings of one wrapper, and a token scan saw only the third. The
    // guard was blind exactly where two shops disagreed about a hyphen.
    it("reads one wrapper written three ways as one claim", async () => {
      const brandId = await seedBrand("Sungrown Marca");
      const leaf = await h.seedCigar({ canonicalName: "Sungrown Marca Toro Sun Grown", brandId });
      for (const spelling of ["Sun Grown", "sun-grown", "sungrown"]) {
        const parse = await parseListing(h.deps.db, `Sungrown Marca Toro ${spelling}`);
        const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
        expect(choice.kind, spelling).toBe("one");
        expect(choice.kind === "one" && choice.candidate.cigarId).toBe(leaf);
      }
    });
  });

  // EVERY CASE BELOW IS A REAL PAIR FROM PROD (#260). One Fox offers run on
  // 2026-09-01 wrote 1,067 crawler links; a 60-link audit against the vendor's own
  // listing names got the marca right 60/60 and the leaf right 40/60 — nineteen
  // wrong sizes and one wrong line, ~355 bad links extrapolated. The names here
  // are the audited ones, not invented fixtures, because the invented ones all
  // passed.
  describe("the leaf-binding guard", () => {
    // The audited marcas overlap the ones this file already seeds — and one of
    // them is registered under a different display name (`Tatuaje Cigars Inc.`),
    // so a slug lookup would seed a SECOND row that the parser then never
    // anchors. Ask the parser instead: whatever it anchors for this marca is the
    // brand these fixtures have to hang off, which is the only answer that keeps
    // the structural arm reachable.
    const marca = async (name: string): Promise<string> => {
      const probe = await parseListing(h.deps.db, `${name} Anchor Probe`);
      return probe.brandId ?? (await seedBrand(name));
    };

    // THE PROOF THAT THIS IS A GUARD PROBLEM AND NOT A RANKING ONE: the correct
    // row EXISTS and a sibling was taken anyway. Prod bound four `CAO Flavours
    // … Corona` listings — Bella Vanilla, Cherrybomb, Gold Honey, Eileen's Dream
    // — to `CAO Flavours Moontrance Corona`, because it was the one row in the
    // line carrying `vitola_name = 'Corona'` and "an exact vitola beats an
    // unknown one" promoted it over four rows naming the right flavour.
    it("does not bind Bella Vanilla to Moontrance when Bella Vanilla exists", async () => {
      const brandId = await marca("CAO");
      const lineId = await seedLine(brandId, "Flavours");
      const bella = await h.seedCigar({ canonicalName: "CAO Flavours Bella Vanilla", brandId, lineId });
      const moontrance = await h.seedCigar({
        canonicalName: "CAO Flavours Moontrance Corona",
        brandId,
        lineId,
        vitolaName: "Corona",
      });

      const parse = await parseListing(h.deps.db, "CAO Flavours Bella Vanilla Corona");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("one");
      expect(choice.kind === "one" && choice.candidate.cigarId).toBe(bella);
      expect(choice.kind === "one" && choice.candidate.cigarId).not.toBe(moontrance);
    });

    // The same shape one line over: `LFD Suave Maceo` bound `… Gobernador`. Two
    // house vitola names, neither of them in any size vocabulary — which is why
    // the mutual-residue rule and not the size rule is what catches this one.
    it("does not bind Suave Maceo to Suave Gobernador", async () => {
      const brandId = await marca("LFD");
      const lineId = await seedLine(brandId, "Suave");
      await h.seedCigar({ canonicalName: "LFD Suave Gobernador", brandId, lineId });

      const parse = await parseListing(h.deps.db, "LFD Suave Maceo");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("none");
    });

    // THE STRUCTURAL ARM, WHICH COMPARED NOTHING AT ALL. A line holding exactly
    // one leaf reached `finalists.length === 1` without a single word of either
    // name being read, so prod's only `Tatuaje Skinny Monsters` row swallowed
    // eight sibling SKUs — Frank, Hyde, Tiff, Wolf, Face, Jekyll, Drac.
    it("does not let a line's only leaf swallow a different sibling", async () => {
      const brandId = await marca("Tatuaje");
      const lineId = await seedLine(brandId, "Skinny Monsters");
      await h.seedCigar({ canonicalName: "Tatuaje Skinny Monsters Chuck", brandId, lineId });

      const parse = await parseListing(h.deps.db, "Tatuaje Skinny Monsters Frank");
      expect(parse.lineId).toBe(lineId);
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("none");
    });

    // `Sixty` IS that leaf's size and no size list contains it — no list ever will
    // contain every house's private name for a 60-ring cigar. So the one-sided
    // residue allowance is withdrawn when the LISTING has pinned a size and the
    // row still reaches somewhere the listing does not.
    it("does not let an only-Sixty line take the Toro", async () => {
      const brandId = await marca("Rocky Patel");
      const lineId = await seedLine(brandId, "Dark Star");
      await h.seedCigar({ canonicalName: "Rocky Patel Dark Star Sixty", brandId, lineId });

      const parse = await parseListing(h.deps.db, "Rocky Patel Dark Star Toro");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("none");
    });

    // A TRUNCATED CANONICAL NAME IS A FUNNEL, and the column is what closes it.
    // Prod's `Davidoff Grand Cru` names no size but carries `vitola_name='Toro'`,
    // and all nine Grand Cru SKUs Fox sells sit on it today.
    //
    // A REGRESSION GUARD, NOT A REPRODUCTION, and the distinction is worth
    // writing down. `chooseLeaf` already refused these — `numbersCompatible` on
    // `No. 2`/`No. 5`, the column-level `vitolaAgrees` on `Robusto` — so the nine
    // links were never this function's decision. They are STALE LINKS the
    // positive-evidence rule restored: `existingCrawlerLink` handed the resolver's
    // silence a prior `cigar_id` and `ingestListing` upgraded it back to `auto`,
    // which is why the run stamped `updated_at` on links it never re-derived.
    // Migration 0032 is what breaks that loop, by clearing the prior link the
    // restoration reads. This test pins the guard's half so a later relaxation
    // cannot re-open the funnel from the other side.
    it("reads a curated vitola_name the canonical name omits", async () => {
      const brandId = await marca("Davidoff");
      const grandCru = await h.seedCigar({ canonicalName: "Davidoff Grand Cru", brandId, vitolaName: "Toro" });

      const toro = await parseListing(h.deps.db, "Davidoff Grand Cru Toro");
      const toroChoice = chooseLeaf(toro, await scopedLeafCandidates(h.deps.db, toro));
      expect(toroChoice.kind).toBe("one");
      expect(toroChoice.kind === "one" && toroChoice.candidate.cigarId).toBe(grandCru);

      const robusto = await parseListing(h.deps.db, "Davidoff Grand Cru Robusto");
      expect(chooseLeaf(robusto, await scopedLeafCandidates(h.deps.db, robusto)).kind).toBe("none");
    });

    // THE GUARD MUST NOT EAT THE COMMONEST CORRECT SHAPE. A title that says less
    // than the row — no size at all — is the blend-level listing meeting a
    // vitola-level leaf, which is most of this catalog and most of what a user
    // says out loud. Refusing it would mint a second row for every casual name.
    it("still binds a listing that names less than the leaf", async () => {
      const brandId = await marca("Understated Marca");
      const leaf = await h.seedCigar({ canonicalName: "Understated Marca Reserva Flying Pig", brandId });

      const parse = await parseListing(h.deps.db, "Understated Marca Reserva");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("one");
      expect(choice.kind === "one" && choice.candidate.cigarId).toBe(leaf);
    });

    // And the mirror: both sides name the SAME size, so an extra word on the row
    // is the row saying more, not saying otherwise. This is the pair clause 3
    // would have damaged had it not been scoped to a row that states no size.
    it("still binds when both sides name the same size and the row says more", async () => {
      const brandId = await marca("Padron");
      const leaf = await h.seedCigar({ canonicalName: "Padron 1964 Anniversary Series Torpedo", brandId });

      const parse = await parseListing(h.deps.db, "Padron 1964 Anniversary Torpedo");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("one");
      expect(choice.kind === "one" && choice.candidate.cigarId).toBe(leaf);
    });
  });

  // The scope query can only see rows it can attribute to the anchored brand,
  // and 516 of prod's 570 unlinked rows are attributable to none — their names do
  // not begin with the marca. A mint on that blindness is the duplicate ADR-012
  // exists to prevent, arriving through the door built to prevent it.
  describe("findUnlinkedNameCollision", () => {
    it("finds an unlinked row the brand scope could never see", async () => {
      await seedBrand("Arturo Fuente");
      const orphan = await h.seedCigar({ canonicalName: "Fuente Fuente OpusX Perfecxion No. 2", brandId: null });
      const hit = await findUnlinkedNameCollision(h.deps.db, "Fuente Fuente OpusX Perfecxion No. 2");
      expect(hit?.cigarId).toBe(orphan);
    });

    it("ignores rows that already carry a brand link", async () => {
      const brandId = await seedBrand("Linked Marca");
      await h.seedCigar({ canonicalName: "Linked Marca Distinctive Robusto", brandId });
      expect(await findUnlinkedNameCollision(h.deps.db, "Linked Marca Distinctive Robusto")).toBeNull();
    });

    it("stays silent when nothing is close enough to be the same product", async () => {
      expect(await findUnlinkedNameCollision(h.deps.db, "Nothing Whatsoever Like This Zzz")).toBeNull();
    });
  });

  describe("resolveDescribedTaxonomy", () => {
    // The journal path resolves each level from its OWN stated field, never by
    // re-parsing the name the user just typed — a described cigar has already
    // separated them, and re-deriving would be strictly less information.
    it("resolves brand and line from the described fields", async () => {
      expect(await resolveDescribedTaxonomy(h.deps.db, { brand: "Padron", line: "1964 Anniversary" })).toEqual({
        brandId: padronId,
        lineId: anniversaryId,
        blendId: null,
      });
    });

    it("stops at the brand when the line is unknown", async () => {
      expect(await resolveDescribedTaxonomy(h.deps.db, { brand: "Padrón", line: "Nonexistent Line" })).toEqual({
        brandId: padronId,
        lineId: null,
        blendId: null,
      });
    });

    // Unknown stays NULL and nothing is invented. A brand nobody answers to
    // leaves the row unlinked for Wave 3 curation rather than minting a registry
    // entry from an unaudited write path.
    it("leaves everything null for an unknown marca", async () => {
      expect(await resolveDescribedTaxonomy(h.deps.db, { brand: "Nobody's Marca" })).toEqual({
        brandId: null,
        lineId: null,
        blendId: null,
      });
      expect(await resolveDescribedTaxonomy(h.deps.db, {})).toEqual({
        brandId: null,
        lineId: null,
        blendId: null,
      });
    });
  });

  describe("loadAncestryContext", () => {
    it("loads the rows the ancestry names so the assertion can check them", async () => {
      const context = await loadAncestryContext(h.deps.db, {
        brandId: padronId,
        lineId: anniversaryId,
        blendId: maduroId,
      });
      expect(context.brand).toEqual({ id: padronId });
      expect(context.line).toEqual({ id: anniversaryId, brandId: padronId });
      expect(context.blend).toEqual({ id: maduroId, lineId: anniversaryId });
    });

    // #230. The marca was the level this loader skipped, so an unknown `brandId`
    // was the one FK no write path checked — it reached the cigar UPDATE and
    // raised 23503 instead of the field error its siblings produce. Loading it
    // here is what turns that into a refusal every caller already knows how to
    // report, and a malformed id answers the same way an unknown one does.
    it("answers a malformed brandId exactly as it answers an unknown one", async () => {
      const malformedAncestry: CigarAncestry = { brandId: "not-a-uuid", lineId: null, blendId: null };
      const unknownAncestry: CigarAncestry = { brandId: newRequestId(), lineId: null, blendId: null };
      const malformed = await loadAncestryContext(h.deps.db, malformedAncestry);
      const unknown = await loadAncestryContext(h.deps.db, unknownAncestry);

      expect(malformed).toEqual(unknown);
      expect(malformed).toEqual({ brand: null });

      const refusalFor = (ancestry: CigarAncestry, context: CigarAncestryContext) => {
        try {
          assertCigarAncestry(ancestry, context);
          return null;
        } catch (error) {
          return (error as ValidationError).toPayload();
        }
      };
      expect(refusalFor(malformedAncestry, malformed)).toMatchObject({
        code: "validation_error",
        fields: [{ path: "brandId", message: "No such brand." }],
      });
      expect(refusalFor(malformedAncestry, malformed)).toEqual(refusalFor(unknownAncestry, unknown));
    });

    // A level whose row does not exist comes back null, which the assertion
    // reports as a violation: a caller asserting a line it cannot resolve is
    // exactly as wrong as one asserting a line from another brand.
    it("reports an unresolvable level as absent, which the assertion refuses", async () => {
      const ghost = { brandId: padronId, lineId: "00000000-0000-0000-0000-000000000000", blendId: null };
      const context = await loadAncestryContext(h.deps.db, ghost);
      expect(context.line).toBeNull();
      expect(() => assertCigarAncestry(ghost, context)).toThrow(ValidationError);
    });

    it("refuses a line belonging to a different brand", async () => {
      const crossed = { brandId: padronId, lineId: ligaPrivadaId, blendId: null };
      const context = await loadAncestryContext(h.deps.db, crossed);
      expect(() => assertCigarAncestry(crossed, context)).toThrow(ValidationError);
    });

    // #206. This loader is where the sweep pays for itself: every wired write path
    // resolves its ancestry through it, so one guard answers a malformed lineId or
    // blendId for assignCigarTaxonomy, splitCigar and assignCigarParts at once —
    // and each of them keeps producing its own refusal without knowing.
    it("loadAncestryContext answers a malformed id exactly as it answers an unknown one", async () => {
      const malformedAncestry: CigarAncestry = {
        brandId: padronId,
        lineId: "not-a-uuid",
        blendId: "also-not-a-uuid",
      };
      const unknownAncestry: CigarAncestry = {
        brandId: padronId,
        lineId: newRequestId(),
        blendId: newRequestId(),
      };
      const malformed = await loadAncestryContext(h.deps.db, malformedAncestry);
      const unknown = await loadAncestryContext(h.deps.db, unknownAncestry);

      expect(malformed).toEqual(unknown);
      expect(malformed).toEqual({ brand: { id: padronId }, line: null, blend: null });

      // Which the assertion turns into the same ValidationError, not a 500.
      const refusalFor = (ancestry: CigarAncestry, context: CigarAncestryContext) => {
        try {
          assertCigarAncestry(ancestry, context);
          return null;
        } catch (error) {
          return (error as ValidationError).toPayload();
        }
      };
      expect(refusalFor(malformedAncestry, malformed)).not.toBeNull();
      expect(refusalFor(malformedAncestry, malformed)).toEqual(refusalFor(unknownAncestry, unknown));
    });

    it("loadNamePartsForCigar answers a malformed id exactly as it answers an unknown one", async () => {
      const malformed = await loadNamePartsForCigar(h.deps.db, {
        brandId: padronId,
        lineId: "not-a-uuid",
        blendId: "also-not-a-uuid",
      });
      const unknown = await loadNamePartsForCigar(h.deps.db, {
        brandId: padronId,
        lineId: newRequestId(),
        blendId: newRequestId(),
      });
      expect(malformed).toEqual(unknown);
      expect(malformed).toEqual({ line: null, blend: null });
    });
  });

  describe("structured minting keeps its own promise", () => {
    // Every path that creates a cigar now resolves its ancestry, so a row minted
    // from a conversation is findable by the same probe the crawler anchors on
    // instead of joining the flat namespace and waiting for a backfill.
    it("a cigar seeded with a full ancestry passes the assertion it was built from", async () => {
      const id = await h.seedCigar({
        canonicalName: "Padron 1964 Anniversary Maduro Principe",
        brandId: padronId,
        lineId: anniversaryId,
        blendId: maduroId,
      });
      const row = (
        await h.deps.db
          .select({ brandId: cigars.brandId, lineId: cigars.lineId, blendId: cigars.blendId })
          .from(cigars)
          .where(eq(cigars.id, id))
      )[0]!;
      expect(() =>
        assertCigarAncestry(row, {
          brand: { id: padronId },
          line: { id: anniversaryId, brandId: padronId },
          blend: { id: maduroId, lineId: anniversaryId },
        }),
      ).not.toThrow();
    });
  });
});
