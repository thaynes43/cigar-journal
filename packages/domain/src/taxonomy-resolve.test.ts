import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { blends, brands, cigars, lines } from "@cj/db";
import { createHarness, type DomainHarness } from "./testing/harness.js";
import { brandSlug } from "./catalog-browse.js";
import { fold } from "./taxonomy-keys.js";
import {
  parseListing,
  scopedLeafCandidates,
  chooseLeaf,
  resolveDescribedTaxonomy,
  loadAncestryContext,
} from "./taxonomy-resolve.js";
import { assertCigarAncestry } from "./cigar-ancestry.js";
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
    it("does not let a two-letter alias drag in unrelated rows by prefix", async () => {
      await h.deps.db
        .insert(brands)
        .values({ name: "La", slug: "la", aliases: ["la"] })
        .returning({ id: brands.id });
      const unrelated = await h.seedCigar({ canonicalName: "La Flor Dominicana Ligero L-40", brandId: null });
      const parse = await parseListing(h.deps.db, "La Something Robusto");
      expect(parse.brandName).toBe("La");
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
      // listing is about several leaves and a sampler is about none of them, and
      // the counter that watches for unsplit collapse buckets must not be fed by
      // a shop's sampler shelf.
      expect(choice.kind).toBe("sampler");
    });

    // ORDER MATTERS HERE. `none` is the arm that licenses seed mode to mint, so
    // a sampler tested after the empty-candidate check would mint a catalog row
    // called "Sampler" for every assortment of a marca whose leaves are not in
    // the catalog yet — which is the newest brand in every single crawl.
    it("refuses a sampler even when the brand has no leaves at all", async () => {
      await seedBrand("Sampler Only Marca");
      const parse = await parseListing(h.deps.db, "Sampler Only Marca Assortment Sampler");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("sampler");
    });

    it("reports no leaf when the brand is known but the product is new", async () => {
      const brandId = await seedBrand("Empty Marca");
      void brandId;
      const parse = await parseListing(h.deps.db, "Empty Marca Something New Robusto");
      const choice = chooseLeaf(parse, await scopedLeafCandidates(h.deps.db, parse));
      expect(choice.kind).toBe("none");
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
      expect(context.line).toEqual({ id: anniversaryId, brandId: padronId });
      expect(context.blend).toEqual({ id: maduroId, lineId: anniversaryId });
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
      expect(() => assertCigarAncestry(row, { line: { id: anniversaryId, brandId: padronId }, blend: { id: maduroId, lineId: anniversaryId } })).not.toThrow();
    });
  });
});
