import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { brandImages, cigars, productPhotos } from "@cj/db";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
import { runBrandImages, type BrandImagesDeps } from "./core/brand-images.js";
import { entitiesUrl, imageInfoUrl, parseImageInfo, parseSearch, searchUrl } from "./core/wikidata.js";
import type { WikidataTaxonomy } from "./core/wikidata-taxonomy.js";
import { createMockFetcher, fakeProcessPhoto, loadFixture, type MockFetcher, type MockRoute } from "./testing/fixtures.js";

// The brand-image job end to end over a real embedded Postgres. Wikimedia is
// mocked per the guardrail (NEVER live APIs) and the photo pipeline is stubbed,
// so the harness needs neither network nor image bytes.

// Synthetic QIDs — the shipped allowlists are empty until a crawl-pod --probe
// seeds them (wikidata-taxonomy.ts); see wikidata.test.ts.
const TAXONOMY: WikidataTaxonomy = {
  negative: ["Q9000900", "Q9000901", "Q9000902"],
  tobaccoClass: ["Q9000001", "Q9000002"],
  tobaccoIndustry: ["Q9000100"],
  tobaccoProduct: ["Q9000200"],
  genericBrand: ["Q9000500"],
  origin: ["Q9000010"],
};

const BRAND = "Montecristo";
const COMMONS_FILE = "Montecristo band.jpg";
const QID = "Q9100010";

function fixture(name: string): string {
  return loadFixture(name, "wikidata");
}

// The exact bytes URL the licence gate hands the driver — derived from the
// fixture rather than hardcoded, so a fixture edit cannot silently unhook it.
function imageBytesUrl(): string {
  const parsed = parseImageInfo(fixture("commons-imageinfo-ccbysa.json"), COMMONS_FILE);
  if (!("image" in parsed)) throw new Error("fixture should parse to an image");
  return parsed.image.downloadUrl;
}

// The full happy-path route map: search → entities → imageinfo → bytes.
function routes(): Record<string, MockRoute> {
  const searchBody = fixture("wbsearchentities-montecristo.json");
  const qids = parseSearch(searchBody).map((h) => h.id);
  return {
    [searchUrl(BRAND)]: { body: searchBody },
    [entitiesUrl(qids)]: { body: fixture("wbgetentities-montecristo.json") },
    // The curator-pick path re-reads the single chosen entity.
    [entitiesUrl([QID])]: { body: fixture("wbgetentities-montecristo.json") },
    [imageInfoUrl(COMMONS_FILE)]: { body: fixture("commons-imageinfo-ccbysa.json") },
    [imageBytesUrl()]: { binary: Buffer.from("montecristo-bytes"), contentType: "image/jpeg" },
  };
}

describe("brand images job (embedded Postgres)", () => {
  let pg: TestPostgres;
  const now = () => new Date("2026-08-28T12:00:00.000Z");

  function deps(fetcher: MockFetcher, storage: PhotoStorage | null): BrandImagesDeps {
    return { db: pg.db, fetcher, storage, now, processPhoto: fakeProcessPhoto, taxonomy: TAXONOMY };
  }

  async function stored(storage: PhotoStorage, key: string): Promise<boolean> {
    return storage
      .get(key)
      .then(() => true)
      .catch(() => false);
  }

  async function row() {
    const rows = await pg.db.select().from(brandImages).where(eq(brandImages.brandName, BRAND));
    return rows[0];
  }

  async function seedBrand(count = 2): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const inserted = await pg.db
        .insert(cigars)
        .values({ canonicalName: `${BRAND} No. ${i + 1}`, brand: BRAND, verification: "verified" })
        .returning({ id: cigars.id });
      ids.push(inserted[0]!.id);
    }
    return ids;
  }

  beforeAll(async () => {
    pg = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.db.delete(brandImages);
    await pg.db.delete(productPhotos);
    await pg.db.delete(cigars);
  });

  it("covers an uncovered brand: one row, two objects, and the credit stored with the bytes", async () => {
    await seedBrand();
    const storage = createMemoryPhotoStorage();
    const result = await runBrandImages(deps(createMockFetcher(routes()), storage), { brand: BRAND });

    expect(result.status).toBe("succeeded");
    expect(result.stats.resolved).toBe(1);
    expect(result.stats.imagesStored).toBe(1);

    const saved = await row();
    expect(saved?.status).toBe("resolved");
    expect(saved?.rights).toBe("pending");
    expect(saved?.brandSlug).toBe("montecristo");
    expect(saved?.wikidataQid).toBe(QID);
    expect(saved?.creditLine).toBe("Ana Example · CC BY-SA 4.0");
    expect(saved?.sourceUrl).toContain("commons.wikimedia.org/wiki/File:");
    expect(saved?.note).toBe("trademarked"); // recorded, never a licence blocker
    expect(saved?.objectKey).toMatch(/^brand\/montecristo\/[0-9a-f-]+\.jpg$/);
    expect(await stored(storage, saved!.objectKey!)).toBe(true);
    expect(await stored(storage, saved!.thumbKey!)).toBe(true);
  });

  it("never queries a brand whose member already has a servable product photo", async () => {
    const [cigarId] = await seedBrand(1);
    await pg.db.insert(productPhotos).values({
      cigarId: cigarId!,
      objectKey: `product/${cigarId}/a.jpg`,
      thumbKey: `product/${cigarId}/a.thumb.jpg`,
      contentType: "image/jpeg",
      width: 800,
      height: 600,
      bytes: 100,
      rights: "pending",
    });

    const fetcher = createMockFetcher(routes());
    const result = await runBrandImages(deps(fetcher, createMemoryPhotoStorage()), { brand: BRAND });

    expect(fetcher.requested).toEqual([]);
    expect(result.stats.brandsChecked).toBe(0);
    expect(await row()).toBeUndefined();
  });

  it("is idempotent on re-run, and a --refresh replace deletes the prior objects", async () => {
    await seedBrand();
    const storage = createMemoryPhotoStorage();
    await runBrandImages(deps(createMockFetcher(routes()), storage), { brand: BRAND });
    const first = await row();

    // A plain re-run finds the brand already covered and does nothing.
    const plain = createMockFetcher(routes());
    await runBrandImages(deps(plain, storage), { brand: BRAND });
    expect(plain.requested).toEqual([]);
    expect((await pg.db.select().from(brandImages)).length).toBe(1);
    expect(await stored(storage, first!.objectKey!)).toBe(true);

    // --refresh re-checks and replaces; the superseded objects are cleaned up.
    await runBrandImages(deps(createMockFetcher(routes()), storage), { brand: BRAND, refresh: true });
    const second = await row();
    expect((await pg.db.select().from(brandImages)).length).toBe(1);
    expect(second!.objectKey).not.toBe(first!.objectKey);
    expect(await stored(storage, first!.objectKey!)).toBe(false);
    expect(await stored(storage, first!.thumbKey!)).toBe(false);
    expect(await stored(storage, second!.objectKey!)).toBe(true);
  });

  it("never re-queries or resurrects a suppressed row — it is a tombstone", async () => {
    await seedBrand();
    await pg.db.insert(brandImages).values({
      brandSlug: "montecristo",
      brandName: BRAND,
      status: "no_match",
      rights: "suppressed",
      checkedAt: new Date("2020-01-01T00:00:00.000Z"), // long past the re-check window
    });

    for (const options of [{ brand: BRAND }, { brand: BRAND, refresh: true }]) {
      const fetcher = createMockFetcher(routes());
      await runBrandImages(deps(fetcher, createMemoryPhotoStorage()), options);
      expect(fetcher.requested).toEqual([]);
    }
    const saved = await row();
    expect(saved?.rights).toBe("suppressed");
    expect(saved?.status).toBe("no_match");
    expect(saved?.objectKey).toBeNull();
  });

  it("honors the negative cache inside the window and re-checks it under --refresh", async () => {
    await seedBrand();
    await pg.db.insert(brandImages).values({
      brandSlug: "montecristo",
      brandName: BRAND,
      status: "no_match",
      checkedAt: new Date("2026-08-20T00:00:00.000Z"), // 8 days old
    });

    const cached = createMockFetcher(routes());
    await runBrandImages(deps(cached, createMemoryPhotoStorage()), { brand: BRAND });
    expect(cached.requested).toEqual([]);

    const refreshed = createMockFetcher(routes());
    await runBrandImages(deps(refreshed, createMemoryPhotoStorage()), { brand: BRAND, refresh: true });
    expect(refreshed.requested.length).toBeGreaterThan(0);
    expect((await row())?.status).toBe("resolved");
  });

  it("picks up a curator-chosen row and downloads only that entity's image", async () => {
    await seedBrand();
    await pg.db.insert(brandImages).values({
      brandSlug: "montecristo",
      brandName: BRAND,
      status: "resolved",
      wikidataQid: QID,
      note: "curator-chosen",
      checkedAt: now(),
    });

    const fetcher = createMockFetcher(routes());
    const storage = createMemoryPhotoStorage();
    const result = await runBrandImages(deps(fetcher, storage), { brand: BRAND });

    expect(result.stats.imagesStored).toBe(1);
    // The curator's verdict outranks the resolver: no search is re-run.
    expect(fetcher.requested.some((url) => url.includes("wbsearchentities"))).toBe(false);
    const saved = await row();
    expect(saved?.objectKey).not.toBeNull();
    expect(await stored(storage, saved!.objectKey!)).toBe(true);
  });

  it("--dry-run reports the would-writes and touches neither the DB nor storage", async () => {
    await seedBrand();
    const storage = createMemoryPhotoStorage();
    const fetcher = createMockFetcher(routes());
    const result = await runBrandImages(deps(fetcher, storage), { brand: BRAND, dryRun: true });

    expect(result.stats.resolved).toBe(1);
    expect(result.report.some((line) => line.includes(BRAND) && line.includes("resolved"))).toBe(true);
    expect(await pg.db.select().from(brandImages)).toEqual([]);
    // The licence gate ran (metadata was read) but no bytes were requested.
    expect(fetcher.requested.some((url) => url.includes("commons.wikimedia.org"))).toBe(true);
    expect(fetcher.requested.some((url) => url.includes("upload.wikimedia.org"))).toBe(false);
  });

  it("leaves a brand unchecked rather than caching a false no_match when Wikimedia declines", async () => {
    await seedBrand();
    const searchBody = fixture("wbsearchentities-montecristo.json");
    const qids = parseSearch(searchBody).map((h) => h.id);
    const fetcher = createMockFetcher({
      [searchUrl(BRAND)]: { body: searchBody },
      [entitiesUrl(qids)]: { body: fixture("wbgetentities-maxlag.json") },
    });

    const result = await runBrandImages(deps(fetcher, createMemoryPhotoStorage()), { brand: BRAND });
    expect(result.stats.leftUnchecked).toBe(1);
    expect(result.stats.noMatch).toBe(0);
    expect(await row()).toBeUndefined();
  });
});
