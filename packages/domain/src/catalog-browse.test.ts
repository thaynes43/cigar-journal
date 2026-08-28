import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { productPhotos } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
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

    const { brands } = await browseBrands(h.deps);

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

    const { brands } = await browseBrands(h.deps);

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
});
