import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { brands, lines, blends, blenders, blendBlenders, productPhotos, offers } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { recordPurchase } from "./record-purchase.js";
import { setWant } from "./wants.js";
import {
  browseCatalog,
  browseCatalogGroups,
  catalogFacetOptions,
  brandSlug,
} from "./catalog-browse.js";
import { resolveCatalogHierarchy } from "./catalog-hierarchy.js";
import { getCigar } from "./reads.js";
import type { Principal } from "./index.js";

// DESIGN-004 (catalog hierarchy + slicing) against a real Postgres. The shared
// harness DB accumulates rows across tests, so every assertion is anchored to a
// per-run tag woven into the seeded names and slugs — a hierarchy filter alone
// would otherwise match another test's Toro.
describe("catalog hierarchy", () => {
  let h: DomainHarness;
  let userA: Principal;
  let userB: Principal;
  const tag = newRequestId().slice(0, 8);

  beforeAll(async () => {
    h = await createHarness();
    userA = await h.createUser("hier-a@example.com");
    userB = await h.createUser("hier-b@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  interface Registry {
    id: string;
    slug: string;
    name: string;
  }

  async function seedBrand(name: string): Promise<Registry> {
    const slug = brandSlug(name);
    const rows = await h.deps.db.insert(brands).values({ name, slug }).returning({ id: brands.id });
    return { id: rows[0]!.id, slug, name };
  }

  async function seedLine(brandId: string, name: string): Promise<Registry> {
    const slug = brandSlug(name);
    const rows = await h.deps.db
      .insert(lines)
      .values({ brandId, name, slug })
      .returning({ id: lines.id });
    return { id: rows[0]!.id, slug, name };
  }

  async function seedBlend(
    lineId: string,
    name: string,
    facts: { wrapper?: string; binder?: string; filler?: string; strength?: string } = {},
  ): Promise<Registry> {
    const slug = brandSlug(name);
    const rows = await h.deps.db
      .insert(blends)
      .values({ lineId, name, slug, ...facts })
      .returning({ id: blends.id });
    return { id: rows[0]!.id, slug, name };
  }

  async function addProductPhoto(cigarId: string): Promise<void> {
    await h.deps.db.insert(productPhotos).values({
      cigarId,
      objectKey: `obj/${cigarId}`,
      thumbKey: `thumb/${cigarId}`,
      contentType: "image/webp",
      width: 800,
      height: 600,
      bytes: 1234,
      rights: "approved",
    });
  }

  async function addAdhocOffer(cigarId: string, pricePerStickCents: number | null): Promise<void> {
    await h.deps.db.insert(offers).values({
      cigarId,
      sourceName: "Ad-hoc Source",
      currency: "USD",
      inStock: true,
      seenAt: new Date("2026-08-20T00:00:00Z"),
      packaging: "single",
      sticksPerPackage: 1,
      price: "10",
      pricePerStickCents,
    });
  }

  const idsOf = (res: { cigars: { cigarId: string }[] }): string[] =>
    res.cigars.map((c) => c.cigarId);

  // --- hierarchy filters (D-01 / D-05) --------------------------------------

  describe("hierarchy filters", () => {
    // One brand, two lines, one blend under the first line, plus deliberate gaps
    // at every level so the `unfiled` slug has something to select.
    let brand: Registry;
    let lineA: Registry;
    let lineB: Registry;
    let blendA: Registry;
    let full: string; // brand + line + blend + vitola
    let lineOnly: string; // brand + line, no blend, no vitola
    let brandOnly: string; // brand only
    let orphan: string; // no structure at all
    const q = `Filters ${tag}`;

    beforeAll(async () => {
      brand = await seedBrand(`FilterBrand ${tag}`);
      lineA = await seedLine(brand.id, "Liga Privada");
      lineB = await seedLine(brand.id, "Undercrown");
      blendA = await seedBlend(lineA.id, "No. 9");

      full = await h.seedCigar({
        canonicalName: `${q} Full`,
        brandId: brand.id,
        lineId: lineA.id,
        blendId: blendA.id,
        vitolaName: "Toro Grande",
        nameSource: "composed",
      });
      lineOnly = await h.seedCigar({
        canonicalName: `${q} LineOnly`,
        brandId: brand.id,
        lineId: lineB.id,
      });
      brandOnly = await h.seedCigar({ canonicalName: `${q} BrandOnly`, brandId: brand.id });
      orphan = await h.seedCigar({ canonicalName: `${q} Orphan` });
    });

    it("filters at each level and composes an ancestor with a descendant", async () => {
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: brand.slug } })).sort()).toEqual(
        [full, lineOnly, brandOnly].sort(),
      );
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { line: lineA.slug } }))).toEqual([full]);
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { blend: blendA.slug } }))).toEqual([full]);
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { vitola: "toro-grande" } }))).toEqual([full]);

      // Ancestor + descendant AND together — a drill is just another filter.
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: brand.slug, line: lineA.slug } })),
      ).toEqual([full]);
      // …including a combination that selects nothing: lineB has no blend.
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { line: lineB.slug, blend: blendA.slug } })),
      ).toEqual([]);
    });

    it("the reserved `unfiled` slug selects each level's null population, beneath its ancestors", async () => {
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: "unfiled" } }))).toEqual([orphan]);
      // Unfiled at a level, scoped by an ancestor: the brand's cigars with no line.
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: brand.slug, line: "unfiled" } })),
      ).toEqual([brandOnly]);
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { line: lineA.slug, blend: "unfiled" } })),
      ).toEqual([]);
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { blend: "unfiled" } })).sort()).toEqual(
        [lineOnly, brandOnly, orphan].sort(),
      );
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { vitola: "unfiled" } })).sort()).toEqual(
        [lineOnly, brandOnly, orphan].sort(),
      );
    });

    it("totalCount tracks the hierarchy scope, not the unscoped q set", async () => {
      const scoped = await browseCatalog(h.deps, userA, { q, hierarchy: { brand: brand.slug } });
      expect(scoped.totalCount).toBe(3);
      const unscoped = await browseCatalog(h.deps, userA, { q });
      expect(unscoped.totalCount).toBe(4);
      // An `unfiled`-only filter needs no registry join; the count must still agree.
      const unfiled = await browseCatalog(h.deps, userA, { q, hierarchy: { brand: "unfiled" } });
      expect(unfiled.totalCount).toBe(1);
    });

    it("a slug matching nothing is an EMPTY scope, never an ignored filter", async () => {
      const res = await browseCatalog(h.deps, userA, { q, hierarchy: { brand: `no-such-${tag}` } });
      expect(res.cigars).toEqual([]);
      expect(res.totalCount).toBe(0);
      expect((await browseCatalog(h.deps, userA, { q, hierarchy: { line: `nope-${tag}` } })).cigars).toEqual([]);
      expect((await browseCatalog(h.deps, userA, { q, hierarchy: { blend: `nope-${tag}` } })).cigars).toEqual([]);
      expect((await browseCatalog(h.deps, userA, { q, hierarchy: { vitola: `nope-${tag}` } })).cigars).toEqual([]);
    });

    it("tiles carry the structural parts and the name source (D-07)", async () => {
      const byId = new Map((await browseCatalog(h.deps, userA, { q })).cigars.map((c) => [c.cigarId, c]));
      const composed = byId.get(full)!;
      expect(composed.nameSource).toBe("composed");
      expect(composed.structuralBrand).toBe(brand.name);
      expect(composed.structuralLine).toBe(lineA.name);
      expect(composed.structuralBlend).toBe(blendA.name);

      const bare = byId.get(orphan)!;
      expect(bare.nameSource).toBe("freeform");
      expect(bare.structuralBrand).toBeNull();
      expect(bare.structuralLine).toBeNull();
      expect(bare.structuralBlend).toBeNull();
    });
  });

  // --- sort directions (D-04) -----------------------------------------------

  describe("sort directions", () => {
    // Walk a sort in one direction with page size 1, proving the keyset for that
    // direction covers every row exactly once.
    async function walk(
      q: string,
      sort: "name" | "my-rating" | "recently-added" | "price",
      sortDir: "asc" | "desc",
    ): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof browseCatalog>> = await browseCatalog(h.deps, userA, {
          q,
          sort,
          sortDir,
          limit: 1,
          cursor,
        });
        for (const c of page.cigars) seen.push(c.cigarId);
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 12);
      return seen;
    }

    it("name runs both ways, with a keyset per direction", async () => {
      const q = `DirName ${tag}`;
      const a = await h.seedCigar({ canonicalName: `${q} Alpha` });
      const b = await h.seedCigar({ canonicalName: `${q} Bravo` });
      const c = await h.seedCigar({ canonicalName: `${q} Charlie` });

      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "name", sortDir: "asc" }))).toEqual([a, b, c]);
      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "name", sortDir: "desc" }))).toEqual([c, b, a]);
      expect(await walk(q, "name", "asc")).toEqual([a, b, c]);
      expect(await walk(q, "name", "desc")).toEqual([c, b, a]);
    });

    it("recently-added runs both ways, with a keyset per direction", async () => {
      const q = `DirRecent ${tag}`;
      const old = await h.seedCigar({
        canonicalName: `${q} Old`,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      });
      const mid = await h.seedCigar({
        canonicalName: `${q} Mid`,
        createdAt: new Date("2021-01-01T00:00:00.000Z"),
      });
      const neu = await h.seedCigar({
        canonicalName: `${q} New`,
        createdAt: new Date("2022-01-01T00:00:00.000Z"),
      });

      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "recently-added", sortDir: "desc" }))).toEqual([
        neu,
        mid,
        old,
      ]);
      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "recently-added", sortDir: "asc" }))).toEqual([
        old,
        mid,
        neu,
      ]);
      expect(await walk(q, "recently-added", "desc")).toEqual([neu, mid, old]);
      expect(await walk(q, "recently-added", "asc")).toEqual([old, mid, neu]);
    });

    it("my-rating runs both ways over the aggregate, with a HAVING keyset per direction", async () => {
      const q = `DirRating ${tag}`;
      const hi = await h.seedCigar({ canonicalName: `${q} Hi` });
      const lo = await h.seedCigar({ canonicalName: `${q} Lo` });
      const un = await h.seedCigar({ canonicalName: `${q} Un` });
      await saveSmoke(h.deps, userA, {
        clientRequestId: newRequestId(),
        cigar: { cigarId: hi },
        overallDescriptors: ["m"],
        assessment: { rating: 95 },
      });
      await saveSmoke(h.deps, userA, {
        clientRequestId: newRequestId(),
        cigar: { cigarId: lo },
        overallDescriptors: ["m"],
        assessment: { rating: 40 },
      });

      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "my-rating", sortDir: "desc" }))).toEqual([
        hi,
        lo,
        un,
      ]);
      // ASC puts the unrated sentinel (-1) first: unrated genuinely is the bottom
      // of this scale, so it sits at whichever end the direction puts it.
      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "my-rating", sortDir: "asc" }))).toEqual([
        un,
        lo,
        hi,
      ]);
      expect(await walk(q, "my-rating", "desc")).toEqual([hi, lo, un]);
      expect(await walk(q, "my-rating", "asc")).toEqual([un, lo, hi]);
    });

    it("price runs both ways and keeps unpriced cigars LAST in both (R-UNI-3)", async () => {
      const q = `DirPrice ${tag}`;
      const cheap = await h.seedCigar({ canonicalName: `${q} Cheap` });
      const mid = await h.seedCigar({ canonicalName: `${q} Mid` });
      const exp = await h.seedCigar({ canonicalName: `${q} Exp` });
      const none = await h.seedCigar({ canonicalName: `${q} NoPrice` });
      await addAdhocOffer(cheap, 1000);
      await addAdhocOffer(mid, 1500);
      await addAdhocOffer(exp, 2000);

      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "price", sortDir: "asc" }))).toEqual([
        cheap,
        mid,
        exp,
        none,
      ]);
      // The unpriced break stays at the END under DESC — it is a rendering
      // boundary, not a value, so a direction flip must not teleport it to the top.
      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "price", sortDir: "desc" }))).toEqual([
        exp,
        mid,
        cheap,
        none,
      ]);
      expect(await walk(q, "price", "asc")).toEqual([cheap, mid, exp, none]);
      expect(await walk(q, "price", "desc")).toEqual([exp, mid, cheap, none]);
    });

    it("a cursor minted under one direction is rejected after a flip (the page restarts)", async () => {
      const q = `DirFlip ${tag}`;
      const a = await h.seedCigar({ canonicalName: `${q} Alpha` });
      const b = await h.seedCigar({ canonicalName: `${q} Bravo` });

      const asc = await browseCatalog(h.deps, userA, { q, sort: "name", sortDir: "asc", limit: 1 });
      expect(asc.cigars.map((c) => c.cigarId)).toEqual([a]);
      expect(asc.nextCursor).not.toBeNull();

      // Same field, opposite direction: the cursor's `name:asc` identity does not
      // match `name:desc`, so it decodes as absent and the page starts fresh.
      const flipped = await browseCatalog(h.deps, userA, {
        q,
        sort: "name",
        sortDir: "desc",
        limit: 1,
        cursor: asc.nextCursor,
      });
      expect(flipped.cigars.map((c) => c.cigarId)).toEqual([b]); // page one of DESC, not page two of ASC
      expect(flipped.totalCount).toBe(2);
    });

    it("omitted sortDir defaults per key (name asc, recency desc, price cheapest-first)", async () => {
      const q = `DirDefault ${tag}`;
      const cheapNew = await h.seedCigar({
        canonicalName: `${q} Zulu`,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      });
      const dearOld = await h.seedCigar({
        canonicalName: `${q} Alpha`,
        createdAt: new Date("2023-01-01T00:00:00.000Z"),
      });
      await addAdhocOffer(cheapNew, 500);
      await addAdhocOffer(dearOld, 900);

      expect(idsOf(await browseCatalog(h.deps, userA, { q }))).toEqual([dearOld, cheapNew]); // name asc
      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "recently-added" }))).toEqual([
        cheapNew,
        dearOld,
      ]);
      expect(idsOf(await browseCatalog(h.deps, userA, { q, sort: "price" }))).toEqual([cheapNew, dearOld]);
    });
  });

  // --- grouped views (D-03 / D-05) ------------------------------------------

  describe("browseCatalogGroups", () => {
    let brand: Registry;
    let otherBrand: Registry;
    let lineA: Registry;
    let lineB: Registry;
    let blendA: Registry;
    let owned: string;
    let wanted: string;
    let third: string;
    const q = `Groups ${tag}`;

    beforeAll(async () => {
      brand = await seedBrand(`GroupBrand ${tag}`);
      otherBrand = await seedBrand(`GroupOther ${tag}`);
      lineA = await seedLine(brand.id, "Alpha Line");
      lineB = await seedLine(brand.id, "Bravo Line");
      blendA = await seedBlend(lineA.id, "Alpha Blend");

      // brand: 4 cigars under `brand`, 1 under `otherBrand`, 1 unfiled.
      // lineA holds 4 (one per photo-cap probe), lineB holds 0 members here.
      owned = await h.seedCigar({
        canonicalName: `${q} A`,
        brandId: brand.id,
        lineId: lineA.id,
        blendId: blendA.id,
        vitolaName: "Robusto",
      });
      wanted = await h.seedCigar({
        canonicalName: `${q} B`,
        brandId: brand.id,
        lineId: lineA.id,
        blendId: blendA.id,
        vitolaName: "Robusto",
      });
      third = await h.seedCigar({
        canonicalName: `${q} C`,
        brandId: brand.id,
        lineId: lineA.id,
        blendId: blendA.id,
        vitolaName: "Toro",
      });
      const d = await h.seedCigar({
        canonicalName: `${q} D`,
        brandId: brand.id,
        lineId: lineA.id,
        blendId: blendA.id,
      });
      await h.seedCigar({ canonicalName: `${q} E`, brandId: otherBrand.id, lineId: null });
      await h.seedCigar({ canonicalName: `${q} F` }); // no brand at all → Unfiled

      // Four photographed members so the cover fan's cap of three is observable.
      for (const id of [owned, wanted, third, d]) await addProductPhoto(id);

      await recordPurchase(h.deps, userA, {
        clientRequestId: newRequestId(),
        cigar: { cigarId: owned },
        quantity: 2,
      });
      await setWant(h.deps, userA, { cigarId: wanted, wanted: true });
      await h.seedCigar({ canonicalName: `${q} G`, brandId: brand.id, lineId: lineB.id });
    });

    it("groups by brand with counts, the badge counts, and a capped cover fan", async () => {
      const { groups, unfiled } = await browseCatalogGroups(h.deps, userA, { q, by: "brand" });
      const card = groups.find((g) => g.slug === brand.slug)!;
      expect(card.dimension).toBe("brand");
      expect(card.name).toBe(brand.name);
      expect(card.parentName).toBeNull(); // brand has no parent to name
      expect(card.cigarCount).toBe(5); // A..D + G
      expect(card.inHumidorCount).toBe(1);
      expect(card.wantedCount).toBe(1);
      // Up to three member photos, in the group's canonical-name order — four
      // members carry one, and the fan caps at three rather than returning them all.
      expect(card.covers.map((c) => c.cigarId)).toEqual([owned, wanted, third]);
      expect(card.covers.every((c) => c.productPhotoId.length > 0)).toBe(true);

      // The null-key population is the trailing Unfiled bucket, not a group.
      expect(groups.some((g) => g.slug === "unfiled")).toBe(false);
      expect(unfiled).toEqual({ cigarCount: 1, inHumidorCount: 0, wantedCount: 0 });
    });

    it("badge counts are principal-scoped", async () => {
      const { groups } = await browseCatalogGroups(h.deps, userB, { q, by: "brand" });
      const card = groups.find((g) => g.slug === brand.slug)!;
      expect(card.cigarCount).toBe(5);
      expect(card.inHumidorCount).toBe(0);
      expect(card.wantedCount).toBe(0);
    });

    it("line and blend cards carry the parent name at root and drop it once pinned", async () => {
      const root = await browseCatalogGroups(h.deps, userA, { q, by: "line" });
      const lineCard = root.groups.find((g) => g.slug === lineA.slug)!;
      expect(lineCard.parentName).toBe(brand.name);
      expect(lineCard.cigarCount).toBe(4);
      // Cigars with a brand but no line land in Unfiled for the line dimension.
      expect(root.unfiled?.cigarCount).toBe(2); // the otherBrand cigar + the orphan

      const drilled = await browseCatalogGroups(h.deps, userA, {
        q,
        by: "line",
        hierarchy: { brand: brand.slug },
      });
      // The drill header already says the brand, so the sub-label would be noise.
      expect(drilled.groups.find((g) => g.slug === lineA.slug)!.parentName).toBeNull();
      expect(drilled.unfiled).toBeNull(); // every cigar under this brand has a line

      const blendRoot = await browseCatalogGroups(h.deps, userA, { q, by: "blend" });
      expect(blendRoot.groups.find((g) => g.slug === blendA.slug)!.parentName).toBe(lineA.name);
      const blendDrilled = await browseCatalogGroups(h.deps, userA, {
        q,
        by: "blend",
        hierarchy: { line: lineA.slug },
      });
      expect(blendDrilled.groups.find((g) => g.slug === blendA.slug)!.parentName).toBeNull();
    });

    it("the vitola dimension groups on the derived key and NEVER carries art", async () => {
      const { groups, unfiled } = await browseCatalogGroups(h.deps, userA, { q, by: "vitola" });
      const robusto = groups.find((g) => g.slug === "robusto")!;
      expect(robusto.name).toBe("Robusto");
      expect(robusto.cigarCount).toBe(2);
      expect(robusto.parentName).toBeNull();
      // An abstract dimension never gets fake art, even though both members have
      // servable product photos.
      expect(robusto.covers).toEqual([]);
      expect(groups.find((g) => g.slug === "toro")!.covers).toEqual([]);
      // Cigars with no vitola name are that dimension's Unfiled population.
      expect(unfiled?.cigarCount).toBe(4);
    });

    it("group cards sort by name or count, in either direction, deterministically", async () => {
      const names = async (dir: "asc" | "desc"): Promise<string[]> =>
        (
          await browseCatalogGroups(h.deps, userA, {
            q,
            by: "brand",
            groupSort: { field: "name", dir },
          })
        ).groups.map((g) => g.name);
      const asc = await names("asc");
      expect(asc).toEqual([brand.name, otherBrand.name]);
      expect(await names("desc")).toEqual([...asc].reverse());

      const counts = async (dir: "asc" | "desc"): Promise<number[]> =>
        (
          await browseCatalogGroups(h.deps, userA, {
            q,
            by: "brand",
            groupSort: { field: "count", dir },
          })
        ).groups.map((g) => g.cigarCount);
      expect(await counts("desc")).toEqual([5, 1]);
      expect(await counts("asc")).toEqual([1, 5]);
    });

    it("applies the leaf filter set, so a card's count equals the drill it opens", async () => {
      const scoped = await browseCatalogGroups(h.deps, userA, { q, by: "line", own: "have" });
      const card = scoped.groups.find((g) => g.slug === lineA.slug)!;
      expect(card.cigarCount).toBe(1);
      const drill = await browseCatalog(h.deps, userA, {
        q,
        own: "have",
        hierarchy: { line: lineA.slug },
      });
      expect(drill.totalCount).toBe(card.cigarCount);
    });

    it("grouping by a dimension the hierarchy already pins degenerates to one card, not an error", async () => {
      const { groups } = await browseCatalogGroups(h.deps, userA, {
        q,
        by: "brand",
        hierarchy: { brand: brand.slug },
      });
      expect(groups.map((g) => g.slug)).toEqual([brand.slug]);
    });
  });

  // --- facet options (D-06) --------------------------------------------------

  describe("catalogFacetOptions", () => {
    let brand: Registry;
    let sibling: Registry;
    let lineA: Registry;
    let lineB: Registry;
    const q = `Facets ${tag}`;

    beforeAll(async () => {
      brand = await seedBrand(`FacetBrand ${tag}`);
      sibling = await seedBrand(`FacetSibling ${tag}`);
      lineA = await seedLine(brand.id, "Aged Series");
      lineB = await seedLine(brand.id, "Boxed Series");
      const siblingLine = await seedLine(sibling.id, "Cellar Series");

      await h.seedCigar({ canonicalName: `${q} A1`, brandId: brand.id, lineId: lineA.id });
      await h.seedCigar({ canonicalName: `${q} A2`, brandId: brand.id, lineId: lineA.id });
      await h.seedCigar({ canonicalName: `${q} B1`, brandId: brand.id, lineId: lineB.id });
      await h.seedCigar({ canonicalName: `${q} S1`, brandId: sibling.id, lineId: siblingLine.id });
      await h.seedCigar({ canonicalName: `${q} Loose`, brandId: brand.id }); // no line
    });

    it("scopes options by the ancestors already set", async () => {
      const scoped = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        hierarchy: { brand: brand.slug },
      });
      expect(scoped.options.map((o) => o.name)).toEqual(["Aged Series", "Boxed Series"]);
      expect(scoped.options.map((o) => o.count)).toEqual([2, 1]);
      // The brand is pinned, so repeating it under every option would be noise.
      expect(scoped.options.every((o) => o.parentName === null)).toBe(true);

      const root = await catalogFacetOptions(h.deps, userA, { q, dimension: "line" });
      expect(root.options.map((o) => o.name)).toEqual(["Aged Series", "Boxed Series", "Cellar Series"]);
      // At root, colliding line names need their brand to disambiguate.
      expect(root.options.find((o) => o.name === "Cellar Series")!.parentName).toBe(sibling.name);
    });

    it("never offers Unfiled as an option (it is a group-card affordance)", async () => {
      const res = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        hierarchy: { brand: brand.slug },
      });
      // The brand has a line-less cigar, but no option is minted for it.
      expect(res.options.map((o) => o.slug)).toEqual([lineA.slug, lineB.slug]);
      expect(res.options.reduce((n, o) => n + o.count, 0)).toBe(3); // not 4
    });

    it("counts against the OTHER facets — this dimension's own value never narrows its options", async () => {
      const unpinned = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        hierarchy: { brand: brand.slug },
      });
      // Picking one line must not collapse the chip to that line: the numbers
      // answer "what would I get if I picked this", not "what did I already pick".
      for (const pinned of [lineA.slug, lineB.slug]) {
        const withOwnValue = await catalogFacetOptions(h.deps, userA, {
          q,
          dimension: "line",
          hierarchy: { brand: brand.slug, line: pinned },
        });
        expect(withOwnValue.options).toEqual(unpinned.options);
      }

      // A DIFFERENT dimension's value does narrow them — that is the point of D-06.
      const narrowed = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        hierarchy: { brand: sibling.slug },
      });
      expect(narrowed.options.map((o) => o.name)).toEqual(["Cellar Series"]);
    });

    it("returns an empty option list at a scope with nothing to offer (the chip hides)", async () => {
      const noBlends = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "blend",
        hierarchy: { brand: brand.slug },
      });
      expect(noBlends.options).toEqual([]);
      const noVitolas = await catalogFacetOptions(h.deps, userA, { q, dimension: "vitola" });
      expect(noVitolas.options).toEqual([]);
    });

    it("composes with the leaf filters, so an option's count matches its drill", async () => {
      const res = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "brand",
        type: "NC",
      });
      expect(res.options).toEqual([]); // none of these seeds carry a type

      const all = await catalogFacetOptions(h.deps, userA, { q, dimension: "brand" });
      const card = all.options.find((o) => o.slug === brand.slug)!;
      const drill = await browseCatalog(h.deps, userA, { q, hierarchy: { brand: brand.slug } });
      expect(drill.totalCount).toBe(card.count);
    });
  });

  // --- drill-header resolution (D-04) ---------------------------------------

  describe("resolveCatalogHierarchy", () => {
    it("names each pinned level, scoping a line slug by its brand", async () => {
      const brandOne = await seedBrand(`ResolveOne ${tag}`);
      const brandTwo = await seedBrand(`ResolveTwo ${tag}`);
      // The SAME line slug under two brands — unique per brand, ambiguous globally.
      const lineOne = await seedLine(brandOne.id, `Reserva ${tag}`);
      await h.deps.db
        .insert(lines)
        .values({ brandId: brandTwo.id, name: `Reserva ${tag}`, slug: lineOne.slug });
      const blend = await seedBlend(lineOne.id, `Doble ${tag}`);
      await h.seedCigar({ canonicalName: `Resolve ${tag} Leaf`, vitolaName: `Gordo ${tag}` });

      const resolved = await resolveCatalogHierarchy(h.deps, {
        brand: brandOne.slug,
        line: lineOne.slug,
        blend: blend.slug,
        vitola: brandSlug(`Gordo ${tag}`),
      });
      expect(resolved.brand).toEqual({ slug: brandOne.slug, name: brandOne.name });
      expect(resolved.line).toEqual({ slug: lineOne.slug, name: lineOne.name });
      expect(resolved.blend).toEqual({ slug: blend.slug, name: blend.name });
      expect(resolved.vitola).toEqual({ slug: brandSlug(`Gordo ${tag}`), name: `Gordo ${tag}` });

      // Scoped by the ancestor: the same line slug under the other brand is a
      // different row, and the blend hanging off brandOne's line is not reachable.
      const wrongScope = await resolveCatalogHierarchy(h.deps, {
        brand: brandTwo.slug,
        line: lineOne.slug,
        blend: blend.slug,
      });
      expect(wrongScope.line).toEqual({ slug: lineOne.slug, name: `Reserva ${tag}` });
      expect(wrongScope.blend).toBeUndefined();
    });

    it("resolves the reserved slug to Unfiled and omits a slug that matches nothing", async () => {
      const resolved = await resolveCatalogHierarchy(h.deps, {
        brand: "unfiled",
        line: `ghost-${tag}`,
      });
      expect(resolved.brand).toEqual({ slug: "unfiled", name: "Unfiled" });
      expect(resolved.line).toBeUndefined();
      expect(await resolveCatalogHierarchy(h.deps, {})).toEqual({});
    });

    it("is unfaceted: a filter that empties the group never blanks the header", async () => {
      const brand = await seedBrand(`ResolveEmpty ${tag}`);
      await h.seedCigar({ canonicalName: `ResolveEmpty ${tag} Only`, brandId: brand.id });
      // No leaf survives a `type: CC` narrowing, yet the header still names it.
      expect((await resolveCatalogHierarchy(h.deps, { brand: brand.slug })).brand).toEqual({
        slug: brand.slug,
        name: brand.name,
      });
    });
  });

  // --- the leaf detail page's ancestry (D-08) -------------------------------

  describe("getCigar().hierarchy", () => {
    it("reports every level, its blend facts, and the credited blenders", async () => {
      const brand = await seedBrand(`DetailBrand ${tag}`);
      const line = await seedLine(brand.id, "Liga Privada");
      const blend = await seedBlend(line.id, "No. 9", {
        wrapper: "Connecticut Broadleaf",
        binder: "Brazilian Mata Fina",
        filler: "Nicaraguan / Honduran",
        strength: "full",
      });
      const blenderRows = await h.deps.db
        .insert(blenders)
        .values({ name: `Willy Herrera ${tag}`, slug: brandSlug(`Willy Herrera ${tag}`) })
        .returning({ id: blenders.id });
      await h.deps.db
        .insert(blendBlenders)
        .values({ blendId: blend.id, blenderId: blenderRows[0]!.id });

      const cigarId = await h.seedCigar({
        canonicalName: `Detail ${tag} Full`,
        brandId: brand.id,
        lineId: line.id,
        blendId: blend.id,
        vitolaName: "Double Corona",
        nameSource: "composed",
      });

      const { hierarchy } = await getCigar(h.deps, userA, { cigarId });
      expect(hierarchy.brand).toEqual({ name: brand.name, slug: brand.slug });
      expect(hierarchy.line).toEqual({ name: "Liga Privada", slug: line.slug });
      expect(hierarchy.blend).toEqual({
        name: "No. 9",
        slug: blend.slug,
        wrapper: "Connecticut Broadleaf",
        binder: "Brazilian Mata Fina",
        filler: "Nicaraguan / Honduran",
        strength: "full",
      });
      expect(hierarchy.vitola).toEqual({ name: "Double Corona", slug: "double-corona" });
      expect(hierarchy.blenders).toEqual([
        { name: `Willy Herrera ${tag}`, slug: brandSlug(`Willy Herrera ${tag}`) },
      ]);
    });

    it("reports null levels for a bare freeform cigar — nothing renders as Unknown", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: `Detail ${tag} Bare`,
        brand: `Freeform ${tag}`,
        line: "Some Line",
      });
      const { hierarchy } = await getCigar(h.deps, userA, { cigarId });
      expect(hierarchy.brand).toBeNull();
      expect(hierarchy.line).toBeNull();
      expect(hierarchy.blend).toBeNull();
      expect(hierarchy.vitola).toBeNull();
      expect(hierarchy.blenders).toEqual([]);
    });

    it("keeps the vitola level when only the leaf's own label is known", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: `Detail ${tag} VitolaOnly`,
        vitolaName: "  Robusto Extra  ",
      });
      const { hierarchy } = await getCigar(h.deps, userA, { cigarId });
      expect(hierarchy.brand).toBeNull();
      // The label is trimmed and slugged with the same rule the SQL side uses, so
      // the breadcrumb link resolves back to the rows that produced it.
      expect(hierarchy.vitola).toEqual({ name: "Robusto Extra", slug: "robusto-extra" });
    });
  });
});
