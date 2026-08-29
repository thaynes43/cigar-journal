import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { productPhotos } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { recordPurchase } from "./record-purchase.js";
import { setWant } from "./wants.js";
import { browseBrands, getBrand, browseCatalog, brandSlug } from "./catalog-browse.js";
import { CigarNotFoundError } from "./errors.js";
import type { Principal } from "./index.js";

describe("catalog browse", () => {
  let h: DomainHarness;
  let userA: Principal;
  let userB: Principal;
  // A per-run tag isolates each test's seeds from the shared harness DB so
  // filter/count assertions stay deterministic as seeds accumulate.
  const tag = newRequestId().slice(0, 8);

  beforeAll(async () => {
    h = await createHarness();
    userA = await h.createUser("catalog-a@example.com");
    userB = await h.createUser("catalog-b@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // Attach a product photo to a cigar (ADR-007, 1:1). Keys carry the cigar id so
  // the unique constraints never collide across seeds.
  async function addProductPhoto(cigarId: string): Promise<void> {
    await h.deps.db.insert(productPhotos).values({
      cigarId,
      objectKey: `obj/${cigarId}`,
      thumbKey: `thumb/${cigarId}`,
      contentType: "image/webp",
      width: 800,
      height: 600,
      bytes: 1234,
    });
  }

  it("brandSlug lowercases, collapses non-alphanumerics, and trims hyphens", () => {
    expect(brandSlug("Arturo Fuente")).toBe("arturo-fuente");
    expect(brandSlug("  E.P. Carrillo — 2020!  ")).toBe("e-p-carrillo-2020");
    expect(brandSlug("OpusX")).toBe("opusx");
  });

  it("groups brands with counts, keeps the unbranded shelf last, and round-trips the slug", async () => {
    const brand = `Fuente ${tag}`;
    await h.seedCigar({ canonicalName: `${brand} Hemingway`, brand, line: "Hemingway", type: "NC" });
    await h.seedCigar({ canonicalName: `${brand} OpusX`, brand, line: "OpusX", type: "NC" });
    await h.seedCigar({ canonicalName: `${brand} Loose`, brand }); // no line
    // A brand-null cigar produces the unbranded shelf.
    await h.seedCigar({ canonicalName: `Orphan ${tag}`, type: "CC" });

    const { brands } = await browseBrands(h.deps, userA);

    const shelf = brands.find((b) => b.brand === brand)!;
    expect(shelf).toBeDefined();
    expect(shelf.cigarCount).toBe(3);
    expect(shelf.lineCount).toBe(2); // Hemingway + OpusX; the loose cigar has no line
    expect(shelf.types).toEqual(["NC"]);
    expect(shelf.slug).toBe(brandSlug(brand));

    // The unbranded shelf exists, carries a null slug, and sorts last.
    const unbranded = brands.find((b) => b.brand === null)!;
    expect(unbranded).toBeDefined();
    expect(unbranded.slug).toBeNull();
    expect(brands[brands.length - 1]!.brand).toBeNull();

    // Round-trip: the slug browseBrands emitted resolves back to the brand page.
    const page = await getBrand(h.deps, userA, { slug: shelf.slug! });
    expect(page.brand).toBe(brand);
  });

  it("getBrand groups lines, trails loose cigars, overlays the caller's history, and isolates it", async () => {
    const brand = `Padron ${tag}`;
    const anniversary = await h.seedCigar({
      canonicalName: `${brand} 1964 Anniversary`,
      brand,
      line: "1964 Anniversary",
    });
    await h.seedCigar({ canonicalName: `${brand} 1926 Serie`, brand, line: "1926 Serie" });
    await h.seedCigar({ canonicalName: `${brand} Thousand`, brand }); // loose, no line

    // userA smokes the Anniversary twice (ratings 80, 90 → avg 85); userB once.
    await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: anniversary },
      overallDescriptors: ["marker"],
      assessment: { rating: 80 },
    });
    await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: anniversary },
      overallDescriptors: ["marker"],
      assessment: { rating: 90 },
    });
    await saveSmoke(h.deps, userB, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: anniversary },
      overallDescriptors: ["marker"],
      assessment: { rating: 10 },
    });

    const slug = brandSlug(brand);
    const page = await getBrand(h.deps, userA, { slug });

    expect(page.brand).toBe(brand);
    // Lines alphabetical: "1926 Serie" before "1964 Anniversary".
    expect(page.lines.map((l) => l.line)).toEqual(["1926 Serie", "1964 Anniversary"]);
    expect(page.loose).toHaveLength(1);
    expect(page.loose[0]!.canonicalName).toBe(`${brand} Thousand`);

    const annivTile = page.lines.find((l) => l.line === "1964 Anniversary")!.cigars[0]!;
    expect(annivTile.userSmokeCount).toBe(2);
    expect(annivTile.userRating).toBe(85); // rounded average of the caller's own smokes

    // userB's overlay counts only userB's smoke — no cross-user leakage.
    const asB = await getBrand(h.deps, userB, { slug });
    const annivAsB = asB.lines.find((l) => l.line === "1964 Anniversary")!.cigars[0]!;
    expect(annivAsB.userSmokeCount).toBe(1);
    expect(annivAsB.userRating).toBe(10);

    // A cigar userA never smoked carries a zeroed overlay.
    const serie = page.lines.find((l) => l.line === "1926 Serie")!.cigars[0]!;
    expect(serie.userSmokeCount).toBe(0);
    expect(serie.userRating).toBeNull();
  });

  it("browseBrands borrows the first-by-name photographed cigar as the brand cover", async () => {
    const withPhotos = `Cover ${tag}`;
    // Alpha sorts first but has no photo; the cover must skip to Bravo, the
    // first-by-name cigar that does have one (Charlie also has one, sorts later).
    await h.seedCigar({ canonicalName: `${withPhotos} Alpha`, brand: withPhotos });
    const bravo = await h.seedCigar({ canonicalName: `${withPhotos} Bravo`, brand: withPhotos });
    const charlie = await h.seedCigar({ canonicalName: `${withPhotos} Charlie`, brand: withPhotos });
    await addProductPhoto(bravo);
    await addProductPhoto(charlie);

    const bare = `Bare ${tag}`;
    await h.seedCigar({ canonicalName: `${bare} Solo`, brand: bare }); // no photo anywhere

    const { brands } = await browseBrands(h.deps, userA);

    const cover = brands.find((b) => b.brand === withPhotos)!;
    expect(cover.coverCigarId).toBe(bravo);
    const none = brands.find((b) => b.brand === bare)!;
    expect(none.coverCigarId).toBeNull();
  });

  it("getBrand borrows line and brand covers from the first-by-name photographed cigar", async () => {
    const brand = `LineCover ${tag}`;
    // Habano: Aged (no photo) sorts before Reserve (photo) → line cover = Reserve.
    await h.seedCigar({ canonicalName: `${brand} Habano Aged`, brand, line: "Habano" });
    const reserve = await h.seedCigar({
      canonicalName: `${brand} Habano Reserve`,
      brand,
      line: "Habano",
    });
    await addProductPhoto(reserve);
    // Maduro: no photos → line cover null.
    await h.seedCigar({ canonicalName: `${brand} Maduro One`, brand, line: "Maduro" });

    const page = await getBrand(h.deps, userA, { slug: brandSlug(brand) });

    const habano = page.lines.find((l) => l.line === "Habano")!;
    expect(habano.coverCigarId).toBe(reserve);
    const maduro = page.lines.find((l) => l.line === "Maduro")!;
    expect(maduro.coverCigarId).toBeNull();
    // Brand hero cover: first-by-name photographed across the whole brand.
    expect(page.coverCigarId).toBe(reserve);
  });

  it("getBrand reports a null brand cover when no cigar has a photo", async () => {
    const brand = `NoCover ${tag}`;
    await h.seedCigar({ canonicalName: `${brand} Uno`, brand, line: "Serie" });

    const page = await getBrand(h.deps, userA, { slug: brandSlug(brand) });
    expect(page.coverCigarId).toBeNull();
    expect(page.lines.find((l) => l.line === "Serie")!.coverCigarId).toBeNull();
  });

  it("getBrand throws CigarNotFoundError for an unknown slug", async () => {
    const error = await getBrand(h.deps, userA, { slug: `no-such-brand-${tag}` }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CigarNotFoundError);
  });

  it("browseCatalog filters by q and type and reports a filtered total", async () => {
    const brand = `Oliva ${tag}`;
    await h.seedCigar({ canonicalName: `${brand} Serie V Melanio`, brand, type: "NC" });
    await h.seedCigar({ canonicalName: `${brand} Serie O`, brand, type: "NC" });
    await h.seedCigar({ canonicalName: `${brand} Cuban CC`, brand, type: "CC" });

    // q matches all three of this brand's cigars (brand ilike).
    const byBrand = await browseCatalog(h.deps, userA, { q: brand });
    expect(byBrand.totalCount).toBe(3);
    expect(byBrand.cigars.every((c) => c.brand === brand)).toBe(true);

    // q + type narrows to the two NC cigars.
    const nc = await browseCatalog(h.deps, userA, { q: brand, type: "NC" });
    expect(nc.totalCount).toBe(2);
    expect(nc.cigars.every((c) => c.type === "NC")).toBe(true);

    // q on canonical name alone.
    const melanio = await browseCatalog(h.deps, userA, { q: `Melanio ${""}`.trim() });
    expect(melanio.cigars.some((c) => c.canonicalName.includes("Melanio"))).toBe(true);
  });

  it("browseCatalog keyset-paginates with no dupes or gaps and a null final cursor", async () => {
    const brand = `Paginate ${tag}`;
    const total = 5;
    for (let i = 0; i < total; i++) {
      // Deliberately repeat a canonical name to prove the id tiebreaker holds.
      const name = i < 2 ? `${brand} Twin` : `${brand} Unit ${i}`;
      await h.seedCigar({ canonicalName: name, brand });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Awaited<ReturnType<typeof browseCatalog>> = await browseCatalog(h.deps, userA, {
        q: brand,
        limit: 2,
        cursor,
      });
      expect(res.totalCount).toBe(total);
      for (const c of res.cigars) seen.push(c.cigarId);
      cursor = res.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(cursor).toBeNull(); // last page reports no next cursor
    expect(seen).toHaveLength(total); // full coverage
    expect(new Set(seen).size).toBe(total); // no duplicates across pages
    expect(pages).toBe(3); // 2 + 2 + 1
  });

  // --- ownership facet (PRD-003 R-UNI-2) -----------------------------------

  it("browseCatalog ownership facet partitions have / want / dont over the caller's overlay", async () => {
    const brand = `Facet ${tag}`;
    const have = await h.seedCigar({ canonicalName: `${brand} Have`, brand });
    const want = await h.seedCigar({ canonicalName: `${brand} Want`, brand });
    const dont = await h.seedCigar({ canonicalName: `${brand} Dont`, brand });

    // Have: an acquisition leaves remaining > 0. Want: a flag, no holding. Dont: nothing.
    await recordPurchase(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: have },
      quantity: 2,
    });
    await setWant(h.deps, userA, { cigarId: want, wanted: true });

    const ids = async (own: "all" | "have" | "want" | "dont"): Promise<string[]> =>
      (await browseCatalog(h.deps, userA, { q: brand, own })).cigars.map((c) => c.cigarId).sort();

    expect(await ids("all")).toEqual([have, want, dont].sort());
    expect(await ids("have")).toEqual([have]);
    expect(await ids("want")).toEqual([want]);
    // Dont = no active holding — the wanted-but-unowned cigar qualifies too.
    expect(await ids("dont")).toEqual([want, dont].sort());

    // totalCount tracks the facet, not the whole q set.
    expect((await browseCatalog(h.deps, userA, { q: brand, own: "have" })).totalCount).toBe(1);

    // Principal-scoped: userB sees none of userA's have/want state.
    expect((await browseCatalog(h.deps, userB, { q: brand, own: "have" })).cigars).toHaveLength(0);
    expect((await browseCatalog(h.deps, userB, { q: brand, own: "want" })).cigars).toHaveLength(0);
  });

  it("browseCatalog moves an emptied humidor cigar from have to dont (explicit consumption)", async () => {
    const brand = `Empty ${tag}`;
    const solo = await h.seedCigar({ canonicalName: `${brand} Solo`, brand });
    await recordPurchase(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: solo },
      quantity: 1,
    });
    expect((await browseCatalog(h.deps, userA, { q: brand, own: "have" })).cigars.map((c) => c.cigarId)).toEqual([
      solo,
    ]);

    // Consume the one stick — remaining floors to 0.
    await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: solo },
      overallDescriptors: ["done"],
      consumption: { fromHumidor: true },
    });

    expect((await browseCatalog(h.deps, userA, { q: brand, own: "have" })).cigars).toHaveLength(0);
    expect((await browseCatalog(h.deps, userA, { q: brand, own: "dont" })).cigars.map((c) => c.cigarId)).toEqual([
      solo,
    ]);
  });

  it("browseBrands ownership facet filters the wall to matching brands and re-badges counts", async () => {
    const owned = `OwnedBrand ${tag}`;
    const unowned = `UnownedBrand ${tag}`;
    const ownedCigar = await h.seedCigar({ canonicalName: `${owned} A`, brand: owned, line: "L1" });
    await h.seedCigar({ canonicalName: `${owned} B`, brand: owned, line: "L2" }); // not owned
    await h.seedCigar({ canonicalName: `${unowned} X`, brand: unowned });
    await recordPurchase(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: ownedCigar },
      quantity: 3,
    });

    // No facet: full counts, both brands present.
    const all = await browseBrands(h.deps, userA);
    expect(all.brands.find((b) => b.brand === owned)!.cigarCount).toBe(2);
    expect(all.brands.find((b) => b.brand === unowned)).toBeDefined();

    // Have facet: the owned brand re-badges to its 1 matching cigar / 1 line; the
    // fully-unowned brand drops off the wall.
    const have = await browseBrands(h.deps, userA, { own: "have" });
    const ownedShelf = have.brands.find((b) => b.brand === owned)!;
    expect(ownedShelf.cigarCount).toBe(1);
    expect(ownedShelf.lineCount).toBe(1);
    expect(have.brands.find((b) => b.brand === unowned)).toBeUndefined();
  });

  it("browseBrands type facet filters and composes with ownership, re-badging counts", async () => {
    const brand = `TypeBrand ${tag}`;
    const ncOwned = await h.seedCigar({ canonicalName: `${brand} NC One`, brand, type: "NC" });
    await h.seedCigar({ canonicalName: `${brand} NC Two`, brand, type: "NC" });
    await h.seedCigar({ canonicalName: `${brand} CC One`, brand, type: "CC" });
    await recordPurchase(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: ncOwned },
      quantity: 1,
    });

    // Type facet on Brands: re-badges to the two NC cigars, types collapses to NC.
    const nc = await browseBrands(h.deps, userA, { type: "NC" });
    const ncShelf = nc.brands.find((b) => b.brand === brand)!;
    expect(ncShelf.cigarCount).toBe(2);
    expect(ncShelf.types).toEqual(["NC"]);

    // Compose type + ownership: only the owned NC cigar survives.
    const ncHave = await browseBrands(h.deps, userA, { type: "NC", own: "have" });
    expect(ncHave.brands.find((b) => b.brand === brand)!.cigarCount).toBe(1);

    // CC facet re-badges to the single CC cigar.
    const cc = await browseBrands(h.deps, userA, { type: "CC" });
    expect(cc.brands.find((b) => b.brand === brand)!.cigarCount).toBe(1);
  });

  // --- sorts (PRD-003 R-UNI-3) ---------------------------------------------

  it("browseCatalog sorts by my-rating (rated desc, unrated last) with keyset paging", async () => {
    const brand = `Rate ${tag}`;
    const hi = await h.seedCigar({ canonicalName: `${brand} Hi`, brand });
    const lo = await h.seedCigar({ canonicalName: `${brand} Lo`, brand });
    const un = await h.seedCigar({ canonicalName: `${brand} Un`, brand });
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

    const res = await browseCatalog(h.deps, userA, { q: brand, sort: "my-rating" });
    expect(res.cigars.map((c) => c.cigarId)).toEqual([hi, lo, un]);

    // Keyset over the aggregate sort: page size 1 covers all three in order.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Awaited<ReturnType<typeof browseCatalog>> = await browseCatalog(h.deps, userA, {
        q: brand,
        sort: "my-rating",
        limit: 1,
        cursor,
      });
      for (const c of p.cigars) seen.push(c.cigarId);
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual([hi, lo, un]);
  });

  it("browseCatalog sorts recently-added newest first with keyset paging", async () => {
    const brand = `Recent ${tag}`;
    const old = await h.seedCigar({
      canonicalName: `${brand} Old`,
      brand,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const mid = await h.seedCigar({
      canonicalName: `${brand} Mid`,
      brand,
      createdAt: new Date("2021-01-01T00:00:00.000Z"),
    });
    const neu = await h.seedCigar({
      canonicalName: `${brand} New`,
      brand,
      createdAt: new Date("2022-01-01T00:00:00.000Z"),
    });

    const res = await browseCatalog(h.deps, userA, { q: brand, sort: "recently-added" });
    expect(res.cigars.map((c) => c.cigarId)).toEqual([neu, mid, old]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Awaited<ReturnType<typeof browseCatalog>> = await browseCatalog(h.deps, userA, {
        q: brand,
        sort: "recently-added",
        limit: 1,
        cursor,
      });
      for (const c of p.cigars) seen.push(c.cigarId);
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual([neu, mid, old]);
  });

  it("a cursor minted under one sort is rejected under another (page restarts, no garbage)", async () => {
    const brand = `SortSwitch ${tag}`;
    await h.seedCigar({ canonicalName: `${brand} A`, brand });
    await h.seedCigar({ canonicalName: `${brand} B`, brand });

    const first = await browseCatalog(h.deps, userA, { q: brand, sort: "name", limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    // Hand a name-sort cursor to a my-rating browse: it decodes as absent, so the
    // page starts fresh rather than paging with a mismatched key.
    const switched = await browseCatalog(h.deps, userA, {
      q: brand,
      sort: "my-rating",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(switched.cigars).toHaveLength(1);
    expect(switched.totalCount).toBe(2);
  });
});
