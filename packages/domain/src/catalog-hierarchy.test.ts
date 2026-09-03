import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
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
import { recordReviewObservation } from "./review-observations.js";
import { mintRegistrySlug } from "./taxonomy-writes.js";
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

  // A registry row whose slug is NOT the one its name would mint — the only way
  // to stand a row up on a slug the write path deliberately never produces.
  async function seedBrandWithSlug(name: string, slug: string): Promise<Registry> {
    const rows = await h.deps.db.insert(brands).values({ name, slug }).returning({ id: brands.id });
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

  // --- group identity and parent scoping (D-03 / D-06) ----------------------

  // A line slug is unique only WITHIN its brand (`lines_brand_id_slug_key`), so
  // `Reserva` is a key two marcas can both own. Everything a root-level card or
  // chip option carries has to survive that: the identity it is keyed by, the
  // parent it names, and above all the drill it opens — an unscoped `?line=`
  // link addresses every marca's line at once, which is the count divergence
  // this whole module exists to prevent.
  describe("colliding slugs across parents", () => {
    let marcaOne: Registry;
    let marcaTwo: Registry;
    let lineOne: Registry;
    let lineTwo: Registry; // the SAME slug as lineOne, under the other marca
    const q = `Scoped ${tag}`;
    const vitola = `Corona ${tag}`;

    beforeAll(async () => {
      marcaOne = await seedBrand(`ScopedOne ${tag}`);
      marcaTwo = await seedBrand(`ScopedTwo ${tag}`);
      lineOne = await seedLine(marcaOne.id, `Serie ${tag}`);
      lineTwo = await seedLine(marcaTwo.id, `Serie ${tag}`);
      expect(lineTwo.slug).toBe(lineOne.slug);

      // brandId AND lineId are set consistently on every member, so a card's
      // count and its parent-scoped drill are comparable at all.
      for (const suffix of ["One A", "One B"]) {
        await h.seedCigar({
          canonicalName: `${q} ${suffix}`,
          brandId: marcaOne.id,
          lineId: lineOne.id,
          vitolaName: vitola,
        });
      }
      await h.seedCigar({
        canonicalName: `${q} Two A`,
        brandId: marcaTwo.id,
        lineId: lineTwo.id,
        vitolaName: vitola,
      });
    });

    it("mints one card per registry ROW, keyed by id and carrying its own parent", async () => {
      const { groups } = await browseCatalogGroups(h.deps, userA, { q, by: "line" });
      const cards = groups.filter((g) => g.slug === lineOne.slug);
      // Two rows, two cards — a slug-keyed list would have collapsed them onto one.
      expect(cards).toHaveLength(2);
      expect(cards.map((c) => c.id).sort()).toEqual([lineOne.id, lineTwo.id].sort());
      expect(new Set(cards.map((c) => c.id)).size).toBe(2);

      const byId = new Map(cards.map((c) => [c.id, c]));
      expect(byId.get(lineOne.id)).toMatchObject({
        parentSlug: marcaOne.slug,
        parentName: marcaOne.name,
        cigarCount: 2,
      });
      expect(byId.get(lineTwo.id)).toMatchObject({
        parentSlug: marcaTwo.slug,
        parentName: marcaTwo.name,
        cigarCount: 1,
      });
    });

    it("a card's count equals its drill's totalCount only once scoped by parentSlug", async () => {
      const { groups } = await browseCatalogGroups(h.deps, userA, { q, by: "line" });
      const cards = groups.filter((g) => g.slug === lineOne.slug);
      for (const card of cards) {
        const drill = await browseCatalog(h.deps, userA, {
          q,
          hierarchy: { brand: card.parentSlug!, line: card.slug },
        });
        expect(drill.totalCount).toBe(card.cigarCount);
        expect(drill.cigars).toHaveLength(card.cigarCount);
      }

      // …and the un-scoped drill is the WRONG answer, not merely a different one:
      // it unions both marcas' lines under one header.
      const unscoped = await browseCatalog(h.deps, userA, { q, hierarchy: { line: lineOne.slug } });
      expect(unscoped.totalCount).toBe(3);
      for (const card of cards) expect(unscoped.totalCount).toBeGreaterThan(card.cigarCount);
    });

    it("chip options carry the same identity and parent scope as the cards", async () => {
      const { options } = await catalogFacetOptions(h.deps, userA, { q, dimension: "line" });
      const shared = options.filter((o) => o.slug === lineOne.slug);
      expect(shared).toHaveLength(2);
      expect(shared.map((o) => o.id).sort()).toEqual([lineOne.id, lineTwo.id].sort());

      const byId = new Map(shared.map((o) => [o.id, o]));
      expect(byId.get(lineOne.id)).toMatchObject({
        parentSlug: marcaOne.slug,
        parentName: marcaOne.name,
        count: 2,
      });
      expect(byId.get(lineTwo.id)).toMatchObject({
        parentSlug: marcaTwo.slug,
        parentName: marcaTwo.name,
        count: 1,
      });
    });

    it("a parentless dimension carries a null parentSlug, and vitola's id IS its slug", async () => {
      const vitolaSlug = brandSlug(vitola);

      const brandCards = await browseCatalogGroups(h.deps, userA, { q, by: "brand" });
      expect(brandCards.groups.every((g) => g.parentSlug === null)).toBe(true);
      // A brand card is still keyed by its registry row, not by its slug.
      expect(brandCards.groups.find((g) => g.slug === marcaOne.slug)!.id).toBe(marcaOne.id);
      const brandOptions = await catalogFacetOptions(h.deps, userA, { q, dimension: "brand" });
      expect(brandOptions.options.every((o) => o.parentSlug === null)).toBe(true);
      expect(brandOptions.options.find((o) => o.slug === marcaOne.slug)!.id).toBe(marcaOne.id);

      // Vitola has no registry table (ADR-012), so the derived key is the whole
      // identity — id and slug are the same string by construction.
      const vitolaCards = await browseCatalogGroups(h.deps, userA, { q, by: "vitola" });
      const card = vitolaCards.groups.find((g) => g.slug === vitolaSlug)!;
      expect(card.parentSlug).toBeNull();
      expect(card.parentName).toBeNull();
      expect(card.id).toBe(card.slug);
      const vitolaOptions = await catalogFacetOptions(h.deps, userA, { q, dimension: "vitola" });
      const option = vitolaOptions.options.find((o) => o.slug === vitolaSlug)!;
      expect(option.parentSlug).toBeNull();
      expect(option.id).toBe(option.slug);
    });
  });

  // --- the reserved `unfiled` slug (D-05) -----------------------------------

  // `unfiled` means IS NULL at every level, so a registry row wearing it would be
  // permanently unreachable and its card would link to a screen excluding all of
  // its own members. Brand/line/blend reserve it at the WRITE path
  // (mintRegistrySlug); vitola, which has no registry row to mint, reserves it at
  // READ time by folding the spelling into the null bucket.
  describe("`unfiled` is reserved for the null population", () => {
    let unfiledBrand: Registry;
    let members: string[];
    let brandless: string;
    const q = `Reserved ${tag}`;

    beforeAll(async () => {
      // The slug a curator's brand named "Unfiled" actually gets.
      unfiledBrand = await seedBrandWithSlug("Unfiled", mintRegistrySlug("Unfiled"));
      members = [
        await h.seedCigar({ canonicalName: `${q} Named A`, brandId: unfiledBrand.id }),
        await h.seedCigar({ canonicalName: `${q} Named B`, brandId: unfiledBrand.id }),
      ];
      brandless = await h.seedCigar({ canonicalName: `${q} Brandless` });
    });

    it("a registry row never wears the bare slug, and the bare slug still means IS NULL", async () => {
      expect(unfiledBrand.slug).not.toBe("unfiled");
      expect(unfiledBrand.slug).toBe("unfiled-1");

      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: unfiledBrand.slug } })).sort(),
      ).toEqual([...members].sort());
      // Untouched: the reserved value selects the population with NO brand row.
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: "unfiled" } }))).toEqual([
        brandless,
      ]);
    });

    it("the named brand and the null population do not merge in the grouped view", async () => {
      const { groups, unfiled } = await browseCatalogGroups(h.deps, userA, { q, by: "brand" });
      const card = groups.find((g) => g.id === unfiledBrand.id)!;
      expect(card.slug).toBe("unfiled-1");
      expect(card.name).toBe("Unfiled");
      expect(card.cigarCount).toBe(2);
      // No card ever claims the reserved slug, and the null bucket stays its own.
      expect(groups.some((g) => g.slug === "unfiled")).toBe(false);
      expect(unfiled).toEqual({ cigarCount: 1, inHumidorCount: 0, wantedCount: 0 });

      const drill = await browseCatalog(h.deps, userA, { q, hierarchy: { brand: card.slug } });
      expect(drill.totalCount).toBe(card.cigarCount);
    });

    describe("a vitola literally spelled Unfiled", () => {
      let spelled: string;
      let absent: string;
      const vq = `ReservedVitola ${tag}`;

      beforeAll(async () => {
        spelled = await h.seedCigar({ canonicalName: `${vq} Spelled`, vitolaName: "Unfiled" });
        absent = await h.seedCigar({ canonicalName: `${vq} Absent` });
      });

      it("folds into the null bucket rather than minting an unaddressable card", async () => {
        const { groups, unfiled } = await browseCatalogGroups(h.deps, userA, { q: vq, by: "vitola" });
        expect(groups.some((g) => g.slug === "unfiled")).toBe(false);
        expect(groups).toEqual([]);
        expect(unfiled).toEqual({ cigarCount: 2, inHumidorCount: 0, wantedCount: 0 });

        // The card's count equals its drill's row count — the invariant the fold
        // exists to hold, from both sides of the key.
        const drill = await browseCatalog(h.deps, userA, { q: vq, hierarchy: { vitola: "unfiled" } });
        expect(idsOf(drill).sort()).toEqual([spelled, absent].sort());
        expect(drill.totalCount).toBe(unfiled!.cigarCount);
      });

      it("is never offered as a chip option", async () => {
        const { options } = await catalogFacetOptions(h.deps, userA, { q: vq, dimension: "vitola" });
        expect(options).toEqual([]);
      });
    });
  });

  // --- the selected facet option is never dropped (D-06) --------------------

  // A chip holding a value the aggregation did not return falls back to
  // rendering the raw slug — `Vitola · petit-corona`, the URL's vocabulary on a
  // display surface — and it happens exactly when a filter has narrowed things
  // far enough to be worth reading. So the active value's own row is unioned in,
  // counted for real, and a count of 0 is shown as the honest answer.
  describe("catalogFacetOptions unions the selected value's own row", () => {
    let marca: Registry;
    let lineAlpha: Registry;
    let lineMid: Registry;
    let lineZulu: Registry;
    const q = `Union ${tag}`;
    const vitola = `Petit Corona ${tag}`;

    beforeAll(async () => {
      marca = await seedBrand(`UnionBrand ${tag}`);
      lineAlpha = await seedLine(marca.id, `Union Alpha ${tag}`);
      lineMid = await seedLine(marca.id, `Union Line ${tag}`);
      lineZulu = await seedLine(marca.id, `Union Zulu ${tag}`);

      for (const suffix of ["A", "B"]) {
        await h.seedCigar({
          canonicalName: `${q} ${suffix}`,
          brandId: marca.id,
          lineId: lineMid.id,
          vitolaName: vitola,
          type: "NC",
        });
      }
      // Two owned members either side of the middle line alphabetically, so the
      // unioned row has somewhere to be placed WRONG if the placement is wrong.
      for (const [name, line] of [
        [`${q} Alpha`, lineAlpha],
        [`${q} Zulu`, lineZulu],
      ] as const) {
        const id = await h.seedCigar({
          canonicalName: name,
          brandId: marca.id,
          lineId: line.id,
          type: "NC",
        });
        await recordPurchase(h.deps, userA, {
          clientRequestId: newRequestId(),
          cigar: { cigarId: id },
          quantity: 1,
        });
      }
    });

    it("keeps the selected VITOLA as a named, zero-count option when the other facets empty it", async () => {
      const vitolaSlug = brandSlug(vitola);
      const { options } = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "vitola",
        type: "CC", // every seed here is NC, so the aggregation returns nothing
        hierarchy: { vitola: vitolaSlug },
      });
      expect(options).toHaveLength(1);
      expect(options[0]).toEqual({
        id: vitolaSlug,
        slug: vitolaSlug,
        // The DISPLAY spelling off the leaves, never the slug.
        name: vitola,
        parentName: null,
        parentSlug: null,
        count: 0,
      });
    });

    it("keeps the selected REGISTRY row the same way, with its parent attached", async () => {
      const line = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        type: "CC",
        hierarchy: { line: lineMid.slug },
      });
      expect(line.options).toHaveLength(1);
      expect(line.options[0]).toEqual({
        id: lineMid.id,
        slug: lineMid.slug,
        name: lineMid.name,
        parentName: marca.name,
        parentSlug: marca.slug,
        count: 0,
      });

      const brand = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "brand",
        type: "CC",
        hierarchy: { brand: marca.slug },
      });
      expect(brand.options).toEqual([
        {
          id: marca.id,
          slug: marca.slug,
          name: marca.name,
          parentName: null,
          parentSlug: null,
          count: 0,
        },
      ]);
    });

    it("never DUPLICATES a row the aggregation already returned", async () => {
      const vitolaSlug = brandSlug(vitola);
      const vitolas = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "vitola",
        hierarchy: { vitola: vitolaSlug },
      });
      expect(vitolas.options.filter((o) => o.slug === vitolaSlug)).toHaveLength(1);
      expect(vitolas.options.find((o) => o.slug === vitolaSlug)!.count).toBe(2);

      const lines_ = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        hierarchy: { line: lineMid.slug },
      });
      expect(lines_.options.filter((o) => o.id === lineMid.id)).toHaveLength(1);
      expect(lines_.options.find((o) => o.id === lineMid.id)!.count).toBe(2);
    });

    it("places the unioned row where a counted one would have sorted", async () => {
      const { options } = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        own: "have", // only the Alpha and Zulu members are owned
        hierarchy: { line: lineMid.slug },
      });
      expect(options.map((o) => o.name)).toEqual([lineAlpha.name, lineMid.name, lineZulu.name]);
      expect(options.map((o) => o.count)).toEqual([1, 0, 1]);
    });

    it("does not fire for the reserved slug, nor for a value that resolves to nothing", async () => {
      // Unfiled is a group-card affordance, never a chip option — the union must
      // not be the back door that puts it in one.
      const unfiled = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "vitola",
        type: "CC",
        hierarchy: { vitola: "unfiled" },
      });
      expect(unfiled.options).toEqual([]);
      const unfiledLine = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        type: "CC",
        hierarchy: { line: "unfiled" },
      });
      expect(unfiledLine.options).toEqual([]);

      // Nothing is fabricated for a slug with no row behind it: an empty option
      // list is the signal the chip HIDES.
      expect(
        (
          await catalogFacetOptions(h.deps, userA, {
            q,
            dimension: "vitola",
            hierarchy: { vitola: `ghost-${tag}` },
          })
        ).options.some((o) => o.slug === `ghost-${tag}`),
      ).toBe(false);
      expect(
        (
          await catalogFacetOptions(h.deps, userA, {
            q,
            dimension: "line",
            type: "CC",
            hierarchy: { line: `ghost-${tag}` },
          })
        ).options,
      ).toEqual([]);
    });
  });

  // --- pre-wave DESIGN-003 links (the folded fallback) -----------------------

  // DESIGN-003's Brand chip wrote the brand's NAME into `?brand=`; D-01 changed
  // the param to hold a slug, so every link shared before this wave would land on
  // an empty grid. The fallback folds the incoming value through the STORED slug
  // rule — never through fold(), which strips accents and would widen a correct
  // link into two marcas.
  describe("a raw NAME in a hierarchy param still resolves", () => {
    let accented: Registry; // `Padrón Test <tag>` → padr-n-test-<tag>
    let ascii: Registry; // `Padron Test <tag>` → padron-test-<tag>
    let plain: Registry; // a plain-ASCII multiword marca
    let plainLine: Registry;
    let accentedMembers: string[];
    let asciiMember: string;
    let plainMember: string;
    const q = `Prewave ${tag}`;
    const vitola = `Toro Grande ${tag}`;

    beforeAll(async () => {
      accented = await seedBrand(`Padrón Test ${tag}`);
      ascii = await seedBrand(`Padron Test ${tag}`);
      plain = await seedBrand(`Drew Test ${tag}`);
      plainLine = await seedLine(plain.id, `Kentucky Fire ${tag}`);

      accentedMembers = [
        await h.seedCigar({ canonicalName: `${q} Accented A`, brandId: accented.id }),
        await h.seedCigar({
          canonicalName: `${q} Accented B`,
          brandId: accented.id,
          vitolaName: vitola,
        }),
      ];
      asciiMember = await h.seedCigar({ canonicalName: `${q} Ascii`, brandId: ascii.id });
      plainMember = await h.seedCigar({
        canonicalName: `${q} Plain`,
        brandId: plain.id,
        lineId: plainLine.id,
      });
    });

    it("folds an accented and a plain-ASCII brand name onto the row that link meant", async () => {
      expect(accented.slug).toBe(`padr-n-test-${tag}`);
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: accented.name } })).sort(),
      ).toEqual([...accentedMembers].sort());
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: plain.name } }))).toEqual([
        plainMember,
      ]);
      // The canonical slug keeps working, unchanged — the fallback is an OR, not
      // a replacement.
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: accented.slug } })).sort(),
      ).toEqual([...accentedMembers].sort());
    });

    it("folds a raw line and vitola name too", async () => {
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { line: plainLine.name } }))).toEqual(
        [plainMember],
      );
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { vitola } }))).toEqual([
        accentedMembers[1]!,
      ]);
    });

    it("resolveCatalogHierarchy answers with the row's CANONICAL slug, not the param", async () => {
      // Every level of a pre-wave link at once — including the ANCESTOR SCOPE,
      // which folds too: the line lookup is narrowed by `b.slug` against a raw
      // brand name, so a fold that stopped at the leaf level would lose the line.
      const resolved = await resolveCatalogHierarchy(h.deps, {
        brand: plain.name,
        line: plainLine.name,
        vitola,
      });
      expect(resolved.brand).toEqual({ slug: plain.slug, name: plain.name, id: plain.id });
      expect(resolved.line).toEqual({ slug: plainLine.slug, name: plainLine.name, id: plainLine.id });
      // A vitola has no registry row (ADR-012), so its id IS its derived key.
      expect(resolved.vitola).toEqual({
        slug: brandSlug(vitola),
        name: vitola,
        id: brandSlug(vitola),
      });

      expect((await resolveCatalogHierarchy(h.deps, { brand: accented.name })).brand).toEqual({
        slug: accented.slug,
        name: accented.name,
        id: accented.id,
      });

      // A raw name under the WRONG ancestor still resolves to nothing — the
      // fallback widens the spelling a param may take, never the scope it means.
      expect(
        await resolveCatalogHierarchy(h.deps, { brand: accented.name, line: plainLine.name }),
      ).toEqual({ brand: { slug: accented.slug, name: accented.name, id: accented.id } });
    });

    // THE NEGATIVE PIN. `padron-test-<tag>` is the ASCII marca's own slug; the
    // accented marca stores `padr-n-test-<tag>`. Folding the value through the
    // STORED rule leaves the two apart — an accent-stripping fold would have
    // matched both and silently doubled a correct link's scope.
    it("never WIDENS a correct link onto an accent-folding sibling", async () => {
      expect(ascii.slug).toBe(`padron-test-${tag}`);
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: ascii.slug } }))).toEqual([
        asciiMember,
      ]);
      expect(idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: ascii.name } }))).toEqual([
        asciiMember,
      ]);
      expect((await resolveCatalogHierarchy(h.deps, { brand: ascii.slug })).brand).toEqual({
        slug: ascii.slug,
        name: ascii.name,
        id: ascii.id,
      });
    });

    // The two fixes meeting. The aggregation returns the row wearing its
    // CANONICAL slug while the active param is the raw name, so the union's slug
    // pre-check misses — only deduping on the registry ID keeps the chip from
    // listing the same brand twice, once counted and once unioned at whatever
    // count the second query found.
    it("does not double the selected row when the param is a name and the row a slug", async () => {
      const brands_ = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "brand",
        hierarchy: { brand: accented.name },
      });
      const brandHits = brands_.options.filter((o) => o.id === accented.id);
      expect(brandHits).toHaveLength(1);
      expect(brandHits[0]).toMatchObject({ slug: accented.slug, name: accented.name, count: 2 });
      expect(brands_.options.some((o) => o.slug === accented.name)).toBe(false);

      const lines_ = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "line",
        hierarchy: { line: plainLine.name },
      });
      const lineHits = lines_.options.filter((o) => o.id === plainLine.id);
      expect(lineHits).toHaveLength(1);
      expect(lineHits[0]).toMatchObject({ slug: plainLine.slug, name: plainLine.name, count: 1 });

      const vitolas = await catalogFacetOptions(h.deps, userA, {
        q,
        dimension: "vitola",
        hierarchy: { vitola },
      });
      expect(vitolas.options.filter((o) => o.slug === brandSlug(vitola))).toHaveLength(1);
      expect(vitolas.options.some((o) => o.slug === vitola)).toBe(false);
    });

    it("still leaves a genuinely unknown value an EMPTY scope", async () => {
      const res = await browseCatalog(h.deps, userA, {
        q,
        hierarchy: { brand: `No Such Marca ${tag}` },
      });
      expect(res.cigars).toEqual([]);
      expect(res.totalCount).toBe(0);
      expect(
        (await browseCatalog(h.deps, userA, { q, hierarchy: { line: `No Such Line ${tag}` } })).cigars,
      ).toEqual([]);
      expect(
        (await browseCatalog(h.deps, userA, { q, hierarchy: { vitola: `No Such Vitola ${tag}` } })).cigars,
      ).toEqual([]);
      expect(await resolveCatalogHierarchy(h.deps, { brand: `No Such Marca ${tag}` })).toEqual({});
    });
  });

  // --- a RENAMED brand slug (migration 0029) --------------------------------

  // Migration 0029 renames `Padrón` off the transcription `padr-n` onto the
  // folded `padron`. Neither arm of the fallback above can carry that: `padr-n`
  // is lossy, so no normalization recovers `padron` from it, and slugFold of the
  // NAME still produces `padr-n`. Both `/cigars/brands/padr-n` (a 307 into the
  // param) and every pre-wave `?brand=Padrón` link would go quietly empty.
  //
  // What carries it is the retained matching key, which is why 0029 keeps
  // `padr-n` in `aliases` instead of stripping it with the other transcriptions.
  describe("an old link on a renamed slug still resolves", () => {
    let renamed: Registry; // slug `padron-<tag>`, still answering to `padr-n-<tag>`
    let sibling: Registry; // owns `padron-sib-<tag>` outright — the widening guard
    let renamedMember: string;
    let siblingMember: string;
    const q = `Renamed ${tag}`;

    // The post-0029 shape of the row, seeded directly: a folded slug, with the
    // transcription demoted to an ordinary alias beside it.
    async function seedRenamed(name: string, slug: string, aliases: string[]): Promise<Registry> {
      const rows = await h.deps.db
        .insert(brands)
        .values({ name, slug, aliases })
        .returning({ id: brands.id });
      return { id: rows[0]!.id, slug, name };
    }

    beforeAll(async () => {
      renamed = await seedRenamed(`Padrón ${tag}`, `padron-${tag}`, [
        `padr-n-${tag}`,
        `padron-${tag}`,
      ]);
      // A DIFFERENT marca that owns its slug outright and also carries the folded
      // key of an accented spelling in its aliases — the shape that makes an
      // unguarded alias probe widen a correct link into two marcas.
      sibling = await seedRenamed(`Padron Sib ${tag}`, `padron-sib-${tag}`, [
        `padron-sib-${tag}`,
        `padr-n-sib-${tag}`,
      ]);
      renamedMember = await h.seedCigar({ canonicalName: `${q} Renamed`, brandId: renamed.id });
      siblingMember = await h.seedCigar({ canonicalName: `${q} Sibling`, brandId: sibling.id });
    });

    it("resolves the retired slug the legacy brand route redirects with", async () => {
      // `/cigars/brands/padr-n-<tag>` 307s to exactly this param.
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: `padr-n-${tag}` } })),
      ).toEqual([renamedMember]);
      // ...and the drill header names the marca rather than echoing the slug.
      expect((await resolveCatalogHierarchy(h.deps, { brand: `padr-n-${tag}` })).brand).toEqual({
        slug: renamed.slug,
        name: renamed.name,
        id: renamed.id,
      });
    });

    it("still resolves the pre-wave NAME link, which folds to the retired slug", async () => {
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: renamed.name } })),
      ).toEqual([renamedMember]);
      expect((await resolveCatalogHierarchy(h.deps, { brand: renamed.name })).brand).toEqual({
        slug: renamed.slug,
        name: renamed.name,
        id: renamed.id,
      });
    });

    it("resolves the new canonical slug, unchanged", async () => {
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: renamed.slug } })),
      ).toEqual([renamedMember]);
    });

    // THE GUARD. The alias arm fires only when NO brand owns the value as a slug,
    // so a link that already resolves can never pick up a second marca — the same
    // widening the negative pin above refuses, now that `aliases` is in play.
    it("never widens a link that a slug already answers", async () => {
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: sibling.slug } })),
      ).toEqual([siblingMember]);
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: sibling.name } })),
      ).toEqual([siblingMember]);
      expect((await resolveCatalogHierarchy(h.deps, { brand: sibling.slug })).brand).toEqual({
        slug: sibling.slug,
        name: sibling.name,
        id: sibling.id,
      });
    });

    // The alias arm widens the spellings a param may take, never the scope it
    // means: a key no brand carries is still an empty result, not the catalog.
    it("leaves an unknown key empty", async () => {
      expect(
        idsOf(await browseCatalog(h.deps, userA, { q, hierarchy: { brand: `padr-x-${tag}` } })),
      ).toEqual([]);
      expect(await resolveCatalogHierarchy(h.deps, { brand: `padr-x-${tag}` })).toEqual({});
    });

    // The retired slug scopes a descendant lookup too — `?brand=padr-n&line=…`
    // must keep naming the line, or an old deep link loses its header.
    it("scopes a line lookup by the retired brand slug", async () => {
      const line = await seedLine(renamed.id, `Anniversary ${tag}`);
      await h.seedCigar({
        canonicalName: `${q} Line Leaf`,
        brandId: renamed.id,
        lineId: line.id,
      });
      const resolved = await resolveCatalogHierarchy(h.deps, {
        brand: `padr-n-${tag}`,
        line: line.slug,
      });
      expect(resolved.brand).toEqual({ slug: renamed.slug, name: renamed.name, id: renamed.id });
      expect(resolved.line).toEqual({ slug: line.slug, name: line.name, id: line.id });
    });
  });

  // --- drill-header resolution (D-04) ---------------------------------------

  describe("resolveCatalogHierarchy", () => {
    it("names each pinned level, scoping a line slug by its brand", async () => {
      const brandOne = await seedBrand(`ResolveOne ${tag}`);
      const brandTwo = await seedBrand(`ResolveTwo ${tag}`);
      // The SAME line slug under two brands — unique per brand, ambiguous globally.
      const lineOne = await seedLine(brandOne.id, `Reserva ${tag}`);
      const lineTwo = await h.deps.db
        .insert(lines)
        .values({ brandId: brandTwo.id, name: `Reserva ${tag}`, slug: lineOne.slug })
        .returning({ id: lines.id });
      const blend = await seedBlend(lineOne.id, `Doble ${tag}`);
      await h.seedCigar({ canonicalName: `Resolve ${tag} Leaf`, vitolaName: `Gordo ${tag}` });

      const resolved = await resolveCatalogHierarchy(h.deps, {
        brand: brandOne.slug,
        line: lineOne.slug,
        blend: blend.slug,
        vitola: brandSlug(`Gordo ${tag}`),
      });
      expect(resolved.brand).toEqual({ slug: brandOne.slug, name: brandOne.name, id: brandOne.id });
      expect(resolved.line).toEqual({ slug: lineOne.slug, name: lineOne.name, id: lineOne.id });
      expect(resolved.blend).toEqual({ slug: blend.slug, name: blend.name, id: blend.id });
      expect(resolved.vitola).toEqual({
        slug: brandSlug(`Gordo ${tag}`),
        name: `Gordo ${tag}`,
        id: brandSlug(`Gordo ${tag}`),
      });

      // Scoped by the ancestor: the same line slug under the other brand is a
      // different row, and the blend hanging off brandOne's line is not reachable.
      const wrongScope = await resolveCatalogHierarchy(h.deps, {
        brand: brandTwo.slug,
        line: lineOne.slug,
        blend: blend.slug,
      });
      // The other brand's row — same slug, different id, which is the whole point.
      expect(wrongScope.line).toEqual({
        slug: lineOne.slug,
        name: `Reserva ${tag}`,
        id: lineTwo[0]!.id,
      });
      expect(wrongScope.blend).toBeUndefined();
    });

    it("resolves the reserved slug to Unfiled and omits a slug that matches nothing", async () => {
      const resolved = await resolveCatalogHierarchy(h.deps, {
        brand: "unfiled",
        line: `ghost-${tag}`,
      });
      // Unfiled is a drill target with no registry row behind it, so it has no id.
      expect(resolved.brand).toEqual({ slug: "unfiled", name: "Unfiled", id: null });
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
        id: brand.id,
      });
    });
  });


  // --- the group card's two labelled aggregates (ADR-013 §3, DESIGN-006) ----

  describe("group card scores", () => {
    it("carries both populations at the card's OWN level, whole-numbered", async () => {
      const brand = await seedBrand(`ScoreBrand ${tag}`);
      const line = await seedLine(brand.id, `Score Line ${tag}`);
      const blend = await seedBlend(line.id, `Score Blend ${tag}`);
      const q = `ScoreCards ${tag}`;
      const one = await h.seedCigar({
        canonicalName: `${q} One`,
        brandId: brand.id,
        lineId: line.id,
        blendId: blend.id,
        type: "NC",
      });
      const two = await h.seedCigar({
        canonicalName: `${q} Two`,
        brandId: brand.id,
        lineId: line.id,
        blendId: blend.id,
        type: "NC",
      });
      await recordReviewObservation(h.deps.db, {
        source: `cards-${tag}`,
        url: `https://critic.example/cards/${tag}-1`,
        nativeScale: "0-100",
        nativeScore: 90,
        cigarId: one,
        seenAt: new Date("2026-09-03T09:00:00.000Z"),
      });
      await recordReviewObservation(h.deps.db, {
        source: `cards-${tag}`,
        url: `https://critic.example/cards/${tag}-2`,
        nativeScale: "0-100",
        nativeScore: 81,
        cigarId: two,
        seenAt: new Date("2026-09-03T09:00:00.000Z"),
      });
      // userA publishes, so their ratings are in the community population.
      await h.deps.db.execute(
        sql`UPDATE users SET journal_visibility = 'public' WHERE id = ${userA.userId}`,
      );
      await saveSmoke(h.deps, userA, {
        clientRequestId: newRequestId(),
        cigar: { cigarId: one },
        assessment: { rating: 71, impression: "Mine." },
      });

      // 90 + 81 = 171 / 2 = 85.5 → 86, over 2 observations; one journal at 71.
      const byBlend = await browseCatalogGroups(h.deps, userA, { q, by: "blend" });
      expect(byBlend.groups).toHaveLength(1);
      expect(byBlend.groups[0]!.critics).toEqual({ score: 86, count: 2 });
      expect(byBlend.groups[0]!.journal).toEqual({ score: 71, count: 1 });

      // The same rows seen at the line and the brand recompute from the raw
      // observations at THAT level — never by averaging the level below.
      const byBrand = await browseCatalogGroups(h.deps, userA, { q, by: "brand" });
      expect(byBrand.groups[0]!.critics).toEqual({ score: 86, count: 2 });
    });

    it("gives a vitola card no scores, and the Unfiled bucket none either", async () => {
      // A vitola is a size label spanning every marca that uses it, so a number
      // there would average unrelated products; Unfiled is the absence of a level.
      const brand = await seedBrand(`ScoreVitola ${tag}`);
      const q = `ScoreVitola ${tag}`;
      const leaf = await h.seedCigar({
        canonicalName: `${q} Robusto`,
        brandId: brand.id,
        vitolaName: "Robusto",
        type: "NC",
      });
      await h.seedCigar({ canonicalName: `${q} Nameless`, brandId: brand.id, type: "NC" });
      await recordReviewObservation(h.deps.db, {
        source: `cards-${tag}`,
        url: `https://critic.example/cards/${tag}-v`,
        nativeScale: "0-100",
        nativeScore: 95,
        cigarId: leaf,
        seenAt: new Date("2026-09-03T09:00:00.000Z"),
      });

      const byVitola = await browseCatalogGroups(h.deps, userA, { q, by: "vitola" });
      expect(byVitola.groups.every((g) => g.critics === null && g.journal === null)).toBe(true);
      // The evidence is not lost — it counts at the brand, which is a level.
      const byBrand = await browseCatalogGroups(h.deps, userA, { q, by: "brand" });
      expect(byBrand.groups[0]!.critics).toEqual({ score: 95, count: 1 });
    });

    it("leaves both null where nothing has been observed", async () => {
      const brand = await seedBrand(`ScoreNone ${tag}`);
      const q = `ScoreNone ${tag}`;
      await h.seedCigar({ canonicalName: `${q} Leaf`, brandId: brand.id, type: "NC" });
      const byBrand = await browseCatalogGroups(h.deps, userA, { q, by: "brand" });
      expect(byBrand.groups[0]!.critics).toBeNull();
      expect(byBrand.groups[0]!.journal).toBeNull();
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
