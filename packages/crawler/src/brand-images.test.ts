import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { brandImages, cigars, productPhotos, type BrandImageRow } from "@cj/db";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
import { runBrandImages, selectWork, type BrandImagesDeps } from "./core/brand-images.js";
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

const UNSEEDED: WikidataTaxonomy = {
  negative: [],
  tobaccoClass: [],
  tobaccoIndustry: [],
  tobaccoProduct: [],
  genericBrand: [],
  origin: [],
};

const BRAND = "Montecristo";
const COMMONS_FILE = "Montecristo band.jpg";
const QID = "Q9100010";

function fixture(name: string): string {
  return loadFixture(name, "wikidata");
}

// The Commons file a later P18 edit points the entity at — a different file, a
// different author, a different licence.
const EDITED_FILE = "Old cigar label.jpg";

// The exact bytes URL the licence gate hands the driver — derived from the
// fixture rather than hardcoded, so a fixture edit cannot silently unhook it.
function imageBytesUrl(fixtureName = "commons-imageinfo-ccbysa.json", file = COMMONS_FILE): string {
  const parsed = parseImageInfo(fixture(fixtureName), file);
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

// The same entity after someone edits its P18 to name another Commons file —
// Wikidata is openly editable, so this is an ordinary edit, not an attack.
function editedP18Routes(): Record<string, MockRoute> {
  const entity = fixture("wbgetentities-montecristo.json").split(COMMONS_FILE).join(EDITED_FILE);
  const qids = parseSearch(fixture("wbsearchentities-montecristo.json")).map((h) => h.id);
  return {
    ...routes(),
    [entitiesUrl(qids)]: { body: entity },
    [entitiesUrl([QID])]: { body: entity },
    [imageInfoUrl(EDITED_FILE)]: { body: fixture("commons-imageinfo-pd.json") },
    [imageBytesUrl("commons-imageinfo-pd.json", EDITED_FILE)]: {
      binary: Buffer.from("other-bytes"),
      contentType: "image/jpeg",
    },
  };
}

// A PhotoStorage that records every key it is asked to hold or drop, so a test
// can assert the bucket holds exactly what the rows point at.
function recordingStorage(): PhotoStorage & { putKeys: string[]; deletedKeys: string[] } {
  const inner = createMemoryPhotoStorage();
  const putKeys: string[] = [];
  const deletedKeys: string[] = [];
  return {
    putKeys,
    deletedKeys,
    put(key, body, contentType) {
      putKeys.push(key);
      return inner.put(key, body, contentType);
    },
    get: (key) => inner.get(key),
    delete(key) {
      deletedKeys.push(key);
      return inner.delete(key);
    },
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

  it("refuses to run at all on an unseeded taxonomy rather than caching no_match for a month", async () => {
    await seedBrand();
    const fetcher = createMockFetcher(routes());
    const unseeded = { ...deps(fetcher, createMemoryPhotoStorage()), taxonomy: UNSEEDED };

    const result = await runBrandImages(unseeded, { brand: BRAND });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("unseeded");
    expect(fetcher.requested).toEqual([]);
    // Nothing written: a no_match row here IS the 30-day negative cache, so the
    // seeded follow-up run would find no work and report a clean, empty success.
    expect(await pg.db.select().from(brandImages)).toEqual([]);

    // --dry-run writes nothing, so it stays usable for inspecting the worklist.
    const dry = await runBrandImages(unseeded, { brand: BRAND, dryRun: true });
    expect(dry.status).toBe("succeeded");
    expect(dry.report.some((line) => line.includes("unseeded"))).toBe(true);
    expect(await pg.db.select().from(brandImages)).toEqual([]);
  });

  it("a storage-less run leaves a row that already carries bytes untouched", async () => {
    await seedBrand();
    const storage = createMemoryPhotoStorage();
    await runBrandImages(deps(createMockFetcher(routes()), storage), { brand: BRAND });
    const before = await row();

    // The Dockerfile presents PHOTOS_S3_* as optional on this role, so a --refresh
    // can land without an object store. It can neither re-store nor delete, so it
    // must not blank the keys: that would strip a live cover AND orphan its two
    // objects with nothing left pointing at them.
    const fetcher = createMockFetcher(routes());
    const result = await runBrandImages(deps(fetcher, null), { brand: BRAND, refresh: true });

    expect(result.stats.leftUnchecked).toBe(1);
    expect(fetcher.requested).toEqual([]);
    const after = await row();
    expect(after!.objectKey).toBe(before!.objectKey);
    expect(after!.thumbKey).toBe(before!.thumbKey);
    expect(after!.status).toBe("resolved");
    expect(await stored(storage, before!.objectKey!)).toBe(true);
  });

  it("a refresh that disqualifies the image clears the keys AND deletes the objects", async () => {
    await seedBrand();
    const storage = createMemoryPhotoStorage();
    await runBrandImages(deps(createMockFetcher(routes()), storage), { brand: BRAND });
    const before = await row();
    expect(before!.objectKey).not.toBeNull();

    // The licence changed on Commons — the same entity, no longer servable.
    const revoked = { ...routes(), [imageInfoUrl(COMMONS_FILE)]: { body: fixture("commons-imageinfo-unknown-license.json") } };
    await runBrandImages(deps(createMockFetcher(revoked), storage), { brand: BRAND, refresh: true });

    const after = await row();
    expect(after!.status).toBe("blocked");
    expect(after!.objectKey).toBeNull();
    expect(after!.thumbKey).toBeNull();
    // The bucket follows the row: nothing references those objects again.
    expect(await stored(storage, before!.objectKey!)).toBe(false);
    expect(await stored(storage, before!.thumbKey!)).toBe(false);
  });

  it("fails the run when every brand it attempted errored — a dead object store is not a green run", async () => {
    await seedBrand();
    const dead: PhotoStorage = {
      ...createMemoryPhotoStorage(),
      put: () => Promise.reject(new Error("AccessDenied")),
    };

    const result = await runBrandImages(deps(createMockFetcher(routes()), dead), { brand: BRAND });
    expect(result.status).toBe("failed");
    expect(result.stats.errors).toBe(1);
    expect(result.error).toContain("every brand failed");
    // Nothing was written, so the row is not even a record that something broke.
    expect(await pg.db.select().from(brandImages)).toEqual([]);
  });

  it("a refresh onto a different P18 file demotes the curator's approval back to pending", async () => {
    await seedBrand();
    const storage = createMemoryPhotoStorage();
    await runBrandImages(deps(createMockFetcher(routes()), storage), { brand: BRAND });
    await pg.db.update(brandImages).set({ rights: "approved" }).where(eq(brandImages.brandSlug, "montecristo"));
    const before = await row();
    expect(before!.commonsFile).toBe(COMMONS_FILE);

    // Someone edits the entity's P18. The re-check stores a different file, by a
    // different author, under a different licence — none of which the curator saw.
    await runBrandImages(deps(createMockFetcher(editedP18Routes()), storage), { brand: BRAND, refresh: true });

    const after = await row();
    expect(after!.commonsFile).toBe(EDITED_FILE);
    expect(after!.creditLine).toBe("Public domain");
    expect(after!.objectKey).not.toBe(before!.objectKey);
    // The approval was a verdict on the file it replaced, so it does not carry.
    expect(after!.rights).toBe("pending");
  });

  it("a refresh that finds the same file keeps the approval — a licence re-check must not dark the wall", async () => {
    await seedBrand();
    const storage = createMemoryPhotoStorage();
    await runBrandImages(deps(createMockFetcher(routes()), storage), { brand: BRAND });
    await pg.db.update(brandImages).set({ rights: "approved" }).where(eq(brandImages.brandSlug, "montecristo"));
    const before = await row();

    await runBrandImages(deps(createMockFetcher(routes()), storage), { brand: BRAND, refresh: true });

    const after = await row();
    expect(after!.commonsFile).toBe(before!.commonsFile);
    expect(after!.creditLine).toBe(before!.creditLine);
    // Fresh bytes under a fresh key, same provenance: the verdict still applies.
    expect(after!.objectKey).not.toBe(before!.objectKey);
    expect(after!.rights).toBe("approved");
  });

  it("folds two spellings of one brand onto a single row, one lookup, and one pair of objects", async () => {
    await seedBrand(); // "Montecristo" ×2
    await pg.db
      .insert(cigars)
      .values({ canonicalName: "MONTECRISTO No. 3", brand: "MONTECRISTO", verification: "verified" });

    const storage = recordingStorage();
    const fetcher = createMockFetcher(routes());
    const result = await runBrandImages(deps(fetcher, storage), {});

    expect(result.stats.brandsUncovered).toBe(2);
    expect(result.stats.imagesStored).toBe(1);
    // One set of Wikidata round trips, not two.
    expect(fetcher.requested.filter((url) => url.includes("wbsearchentities")).length).toBe(1);

    const rows = await pg.db.select().from(brandImages);
    expect(rows.length).toBe(1);
    // The dominant spelling wins the row (uncoveredBrands orders by member count).
    expect(rows[0]!.brandName).toBe(BRAND);
    // Nothing orphaned: the bucket holds exactly the two objects the row names.
    expect(storage.putKeys.sort()).toEqual([rows[0]!.objectKey, rows[0]!.thumbKey].sort());
    expect(storage.deletedKeys).toEqual([]);
  });

  it("fails the run when every put failed, even though other brands wrote their rows fine", async () => {
    await seedBrand();
    await pg.db
      .insert(cigars)
      .values({ canonicalName: "Nonesuch Robusto", brand: "Nonesuch Cigars", verification: "verified" });
    const dead: PhotoStorage = {
      ...createMemoryPhotoStorage(),
      put: () => Promise.reject(new Error("AccessDenied")),
    };
    const fetcher = createMockFetcher({
      ...routes(),
      [searchUrl("Nonesuch Cigars")]: { body: fixture("wbsearchentities-empty.json") },
    });

    const result = await runBrandImages(deps(fetcher, dead), {});

    // The no_match brand writes its row against a dead object store and would
    // otherwise carry the whole run green — most of a real sweep looks like this.
    expect(result.status).toBe("failed");
    expect(result.stats).toMatchObject({ resolved: 1, noMatch: 1, storeAttempts: 1, imagesStored: 0, errors: 1 });
    expect(result.error).toContain("stored no image");
    const rows = await pg.db.select().from(brandImages);
    expect(rows.map((r) => r.status)).toEqual(["no_match"]);
  });

  it("stays green when a download is refused rather than broken — a blocked file is not a dead store", async () => {
    await seedBrand();
    const refused = { ...routes(), [imageBytesUrl()]: { status: 404 } };

    const result = await runBrandImages(deps(createMockFetcher(refused), createMemoryPhotoStorage()), { brand: BRAND });

    expect(result.status).toBe("succeeded");
    expect(result.stats).toMatchObject({ storeAttempts: 1, imagesStored: 0, errors: 0 });
    expect((await row())?.status).toBe("blocked");
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

// selectWork is a pure function over the uncovered list and the existing rows —
// no Postgres needed, so this sits outside the harness above.
describe("selectWork", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const uncovered = [
    { brand: "CAO", n: 3 },
    { brand: BRAND, n: 2 },
  ];
  const noRows: BrandImageRow[] = [];

  it("keeps a slug too short to disambiguate out of the sweep, but honours an explicit --brand", () => {
    // "cao" is three characters and is also a Chinese surname; the unattended
    // sweep will not gamble a wbsearchentities on it.
    expect(selectWork(uncovered, noRows, now, {}).map((w) => w.brand)).toEqual([BRAND]);
    // Naming the shelf IS the disambiguation, so the request is honoured rather
    // than silently dropped.
    expect(selectWork(uncovered, noRows, now, { brand: "CAO" }).map((w) => w.slug)).toEqual(["cao"]);
  });

  it("folds spellings that share a slug into one item, in both the sweep and --brand", () => {
    // uncoveredBrands groups on btrim(brand); brandSlug() folds case and
    // punctuation away, so these arrive as four brands and land on TWO rows.
    const collide = [
      { brand: "Montecristo", n: 4 },
      { brand: "MONTECRISTO", n: 1 },
      { brand: "H. Upmann", n: 3 },
      { brand: "H Upmann", n: 1 },
    ];
    expect(selectWork(collide, noRows, now, {}).map((w) => w.brand)).toEqual(["Montecristo", "H. Upmann"]);
    // --brand is case-insensitive, so it matches both spellings — still one item.
    expect(selectWork(collide, noRows, now, { brand: "montecristo" }).map((w) => w.brand)).toEqual(["Montecristo"]);
  });

  it("does not let a second spelling resurrect a slug the first one is barred from", () => {
    const collide = [
      { brand: "Montecristo", n: 4 },
      { brand: "MONTECRISTO", n: 1 },
    ];
    const tombstone = {
      brandSlug: "montecristo",
      rights: "suppressed",
      status: "no_match",
      checkedAt: new Date("2020-01-01T00:00:00.000Z"),
    } as BrandImageRow;
    expect(selectWork(collide, [tombstone], now, { refresh: true })).toEqual([]);
  });
});
