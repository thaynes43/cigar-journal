import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import {
  vendors,
  cigars,
  offers,
  productPhotos,
  crawlRuns,
  listingMatches,
  enrichmentRequests,
} from "@cj/db";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
import { runIngest, type IngestDeps } from "./core/ingest.js";
import { upsertListingMatch } from "./core/match.js";
import { foxCigar } from "./adapters/fox-cigar.js";
import { smallBatchCigar } from "./adapters/small-batch-cigar.js";
import { createMockFetcher, urlsetXml, loadFixture, fakeProcessPhoto, type MockFetcher } from "./testing/fixtures.js";
import type { VendorAdapter } from "./adapters/types.js";

// End-to-end over a real embedded Postgres (migrated to head). The fetch layer is
// mocked per the guardrail (NEVER live sites); the photo pipeline is stubbed so
// the harness needs no image bytes.

const PADRON_URL = "https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo/";
const LIGHTER_URL = "https://foxcigar.com/shop/xikar-hp3-lighter/";
const SAMPLER_URL = "https://foxcigar.com/shop/fox-5-cigar-sampler/";
const OLIVA_URL = "https://foxcigar.com/shop/oliva-serie-v-melanio-torpedo/";
const PADRON_IMG = "https://foxcigar.com/wp-content/uploads/padron-1964-torpedo.jpg";
const OLIVA_IMG = "https://foxcigar.com/wp-content/uploads/oliva-melanio-torpedo.jpg";
const ROBOTS = "https://foxcigar.com/robots.txt";
const SITEMAP = "https://foxcigar.com/sitemap.xml";

const PADRON_NAME = "Padron 1964 Anniversary Maduro Torpedo";
const OLIVA_NAME = "Oliva Serie V Melanio Torpedo";

describe("crawler ingest (embedded Postgres)", () => {
  let pg: TestPostgres;
  let vendorId: string;
  const now = () => new Date("2026-08-28T12:00:00.000Z");

  function deps(fetcher: MockFetcher, storage: PhotoStorage | null): IngestDeps {
    return { db: pg.db, fetcher, storage, now, processPhoto: fakeProcessPhoto };
  }

  const seedCigar = async (canonicalName: string): Promise<string> => {
    const rows = await pg.db
      .insert(cigars)
      .values({ canonicalName, verification: "verified" })
      .returning({ id: cigars.id });
    return rows[0]!.id;
  };

  beforeAll(async () => {
    pg = await startTestPostgres();
    const inserted = await pg.db
      .insert(vendors)
      .values({ name: "Fox Cigar", url: "https://foxcigar.com", focus: "NC", crawlEnabled: true, approvalStatus: "owner-added" })
      .returning({ id: vendors.id });
    vendorId = inserted[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("seed creates one unverified cigar, an offer, and a photo; a second identical run dedupes the offer", async () => {
    const storage = createMemoryPhotoStorage();
    const routes = {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([PADRON_URL, LIGHTER_URL, SAMPLER_URL]) },
      [PADRON_URL]: { body: loadFixture("product-padron.html") },
      [LIGHTER_URL]: { body: loadFixture("product-lighter.html") },
      [SAMPLER_URL]: { body: loadFixture("product-sampler.html") },
      [PADRON_IMG]: { binary: Buffer.from("padron-image"), contentType: "image/jpeg" },
    };

    const first = await runIngest(deps(createMockFetcher(routes), storage), {
      adapter: foxCigar,
      vendorId,
      mode: "seed",
    });

    expect(first.status).toBe("succeeded");
    expect(first.stats.listingsParsed).toBe(3);
    expect(first.stats.skippedNonCigar).toBe(2); // lighter + sampler
    expect(first.stats.cigarsCreated).toBe(1);
    expect(first.stats.matchesAuto).toBe(1);
    expect(first.stats.offersWritten).toBe(1);
    expect(first.stats.photosCaptured).toBe(1);
    expect(first.stats.errors).toBe(0);

    // The catalog cigar is unverified and brand-inferred to null (no prior taxonomy).
    const created = await pg.db.select().from(cigars).where(eq(cigars.canonicalName, PADRON_NAME));
    expect(created).toHaveLength(1);
    expect(created[0]!.verification).toBe("unverified");
    expect(created[0]!.brand).toBeNull();
    const cigarId = created[0]!.id;

    // One offer, priced and stocked from the JSON-LD.
    const offerRows = await pg.db.select().from(offers).where(eq(offers.vendorId, vendorId));
    expect(offerRows).toHaveLength(1);
    expect(Number(offerRows[0]!.price)).toBe(24.5);
    expect(offerRows[0]!.currency).toBe("USD");
    expect(offerRows[0]!.inStock).toBe(true);
    expect(offerRows[0]!.listingUrl).toBe(PADRON_URL);

    // The listing match is auto-linked on the URL path.
    const matches = await pg.db.select().from(listingMatches).where(eq(listingMatches.vendorId, vendorId));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.status).toBe("auto");
    expect(matches[0]!.cigarId).toBe(cigarId);
    expect(matches[0]!.listingKey).toBe("/shop/padron-1964-anniversary-maduro-torpedo/");

    // One product photo, rights pending.
    const photos = await pg.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId));
    expect(photos).toHaveLength(1);
    expect(photos[0]!.rights).toBe("pending");
    expect(photos[0]!.sourceUrl).toBe(PADRON_IMG);
    await expect(storage.get(photos[0]!.objectKey)).resolves.toBeDefined();
    await expect(storage.get(photos[0]!.thumbKey)).resolves.toBeDefined();

    // Second run at the same instant, identical price/stock: the 24h dedupe skips
    // the offer (ADR-009) — no new offer, cigar, or photo.
    const second = await runIngest(deps(createMockFetcher(routes), storage), {
      adapter: foxCigar,
      vendorId,
      mode: "seed",
    });
    expect(second.stats.cigarsCreated).toBe(0);
    expect(second.stats.photosCaptured).toBe(0);
    expect(second.stats.offersWritten).toBe(0);
    expect(second.stats.matchesAuto).toBe(1);

    expect(await pg.db.select().from(cigars).where(eq(cigars.canonicalName, PADRON_NAME))).toHaveLength(1);
    expect(await pg.db.select().from(offers).where(eq(offers.vendorId, vendorId))).toHaveLength(1);
    expect(await pg.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId))).toHaveLength(1);

    // A later run whose price changed DOES append (history is never rewritten).
    const laterRoutes = {
      ...routes,
      [PADRON_URL]: { body: loadFixture("product-padron.html").replace("24.50", "26.00") },
    };
    const third = await runIngest(
      { db: pg.db, fetcher: createMockFetcher(laterRoutes), storage, now: () => new Date("2026-08-29T12:00:00.000Z"), processPhoto: fakeProcessPhoto },
      { adapter: foxCigar, vendorId, mode: "offers" },
    );
    expect(third.stats.offersWritten).toBe(1);
    const afterThird = await pg.db.select().from(offers).where(eq(offers.vendorId, vendorId));
    expect(afterThird).toHaveLength(2);
    expect(afterThird.some((o) => Number(o.price) === 26)).toBe(true);

    // All three runs wrote a succeeded crawl_runs row with stats.
    const runs = await pg.db.select().from(crawlRuns).where(eq(crawlRuns.vendorId, vendorId));
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);
    expect(runs.every((r) => r.finishedAt !== null && r.stats !== null)).toBe(true);
  });

  it("upsertListingMatch never downgrades a confirmed match", async () => {
    const cigarA = await seedCigar("Match Guard A");
    const cigarB = await seedCigar("Match Guard B");
    const listingKey = "/shop/match-guard/";

    const auto = await upsertListingMatch(pg.db, { vendorId, listingKey, cigarId: cigarA, status: "auto", now: now() });
    expect(auto.status).toBe("auto");
    expect(auto.cigarId).toBe(cigarA);

    // A curator confirms the match.
    await pg.db.update(listingMatches).set({ status: "confirmed" }).where(eq(listingMatches.id, auto.id));

    // A later crawl trying to set it unmatched is ignored.
    const unmatchedAttempt = await upsertListingMatch(pg.db, {
      vendorId,
      listingKey,
      cigarId: null,
      status: "unmatched",
      now: now(),
    });
    expect(unmatchedAttempt.status).toBe("confirmed");
    expect(unmatchedAttempt.cigarId).toBe(cigarA);

    // And re-linking to another cigar is ignored too.
    const relinkAttempt = await upsertListingMatch(pg.db, {
      vendorId,
      listingKey,
      cigarId: cigarB,
      status: "auto",
      now: now(),
    });
    expect(relinkAttempt.status).toBe("confirmed");
    expect(relinkAttempt.cigarId).toBe(cigarA);
  });

  // --- decided_by guard (migration 0017) ------------------------------------
  it("upsertListingMatch upgrades a crawler-set unmatched to auto (the enrich path)", async () => {
    const cigar = await seedCigar("Decided Enrich Path");
    const listingKey = "/shop/decided-enrich/";

    // The crawler first saw the listing with no catalog hit → unmatched, decided_by crawler.
    const unmatched = await upsertListingMatch(pg.db, {
      vendorId,
      listingKey,
      cigarId: null,
      status: "unmatched",
      now: now(),
    });
    expect(unmatched.status).toBe("unmatched");
    expect(unmatched.decidedBy).toBe("crawler");

    // A later crawl matches it → auto. A crawler-owned unmatched is freely upgradeable.
    const upgraded = await upsertListingMatch(pg.db, {
      vendorId,
      listingKey,
      cigarId: cigar,
      status: "auto",
      now: now(),
    });
    expect(upgraded.status).toBe("auto");
    expect(upgraded.cigarId).toBe(cigar);
    expect(upgraded.decidedBy).toBe("crawler");
  });

  it("upsertListingMatch preserves a curator-set unmatched (no silent re-auto)", async () => {
    const cigar = await seedCigar("Decided Curator Unmatch");
    const listingKey = "/shop/decided-curator/";

    const auto = await upsertListingMatch(pg.db, { vendorId, listingKey, cigarId: cigar, status: "auto", now: now() });
    // A curator unmatches it (status unmatched, decided_by curator) — as setListingMatchStatus stamps it.
    await pg.db
      .update(listingMatches)
      .set({ status: "unmatched", cigarId: null, decidedBy: "curator" })
      .where(eq(listingMatches.id, auto.id));

    // A re-crawl re-matching the same listing must NOT flip it back to auto.
    const recrawl = await upsertListingMatch(pg.db, { vendorId, listingKey, cigarId: cigar, status: "auto", now: now() });
    expect(recrawl.status).toBe("unmatched");
    expect(recrawl.cigarId).toBeNull();
    expect(recrawl.decidedBy).toBe("curator");
  });

  it("upsertListingMatch preserves an agent decision", async () => {
    const cigar = await seedCigar("Decided Agent Verdict");
    const listingKey = "/shop/decided-agent/";

    const auto = await upsertListingMatch(pg.db, { vendorId, listingKey, cigarId: cigar, status: "auto", now: now() });
    await pg.db
      .update(listingMatches)
      .set({ status: "unmatched", cigarId: null, decidedBy: "agent" })
      .where(eq(listingMatches.id, auto.id));

    const recrawl = await upsertListingMatch(pg.db, { vendorId, listingKey, cigarId: cigar, status: "auto", now: now() });
    expect(recrawl.status).toBe("unmatched");
    expect(recrawl.decidedBy).toBe("agent");
  });

  it("enrich fulfills a pending request on a name hit and exhausts after repeated misses", async () => {
    const storage = createMemoryPhotoStorage();

    // --- hit case -----------------------------------------------------------
    const olivaId = await seedCigar(OLIVA_NAME);
    const hitReq = await pg.db
      .insert(enrichmentRequests)
      .values({ cigarId: olivaId, status: "pending" })
      .returning({ id: enrichmentRequests.id });
    const hitReqId = hitReq[0]!.id;

    const hitRoutes = {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([OLIVA_URL]) },
      [OLIVA_URL]: { body: loadFixture("product-oliva.html") },
      [OLIVA_IMG]: { binary: Buffer.from("oliva-image"), contentType: "image/jpeg" },
    };

    const hit = await runIngest(deps(createMockFetcher(hitRoutes), storage), {
      adapter: foxCigar,
      vendorId,
      mode: "enrich",
    });
    expect(hit.status).toBe("succeeded");
    expect(hit.stats.offersWritten).toBe(1);
    expect(hit.stats.matchesAuto).toBe(1);

    const fulfilled = await pg.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.id, hitReqId));
    expect(fulfilled[0]!.status).toBe("fulfilled");
    expect(fulfilled[0]!.resolvedAt).not.toBeNull();
    // An offer was linked to the requested cigar.
    const olivaOffers = await pg.db.select().from(offers).where(eq(offers.listingUrl, OLIVA_URL));
    expect(olivaOffers).toHaveLength(1);

    // --- miss case ----------------------------------------------------------
    const phantomId = await seedCigar("Nonexistent Phantom Cigar Zeta");
    const missReq = await pg.db
      .insert(enrichmentRequests)
      .values({ cigarId: phantomId, status: "pending" })
      .returning({ id: enrichmentRequests.id });
    const missReqId = missReq[0]!.id;

    // A sitemap sharing no slug tokens with the phantom name → no candidates.
    const missRoutes = {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([PADRON_URL]) },
      [PADRON_URL]: { body: loadFixture("product-padron.html") },
    };

    await runIngest(deps(createMockFetcher(missRoutes), storage), { adapter: foxCigar, vendorId, mode: "enrich" });
    let miss = await pg.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.id, missReqId));
    expect(miss[0]!.status).toBe("pending");
    expect(miss[0]!.attempts).toBe(1);

    await runIngest(deps(createMockFetcher(missRoutes), storage), { adapter: foxCigar, vendorId, mode: "enrich" });
    miss = await pg.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.id, missReqId));
    expect(miss[0]!.status).toBe("exhausted");
    expect(miss[0]!.attempts).toBe(2);
    expect(miss[0]!.resolvedAt).not.toBeNull();

    // Every enrich run recorded a crawl_runs row.
    const enrichRuns = await pg.db
      .select()
      .from(crawlRuns)
      .where(eq(crawlRuns.kind, "enrich"));
    expect(enrichRuns.length).toBe(3);
    expect(enrichRuns.every((r) => r.status === "succeeded")).toBe(true);
  });

  // --- sitemap sampling (adapters whose enumeration varies per fetch) --------

  it("sampling unions varying sitemap fetches so the walk sees listings from every sample", async () => {
    const adapter: VendorAdapter = { ...foxCigar, sitemapSampling: { samples: 3 } };
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: {
        sequence: [
          { body: urlsetXml([PADRON_URL]) },
          { body: urlsetXml([]) },
          { body: urlsetXml([OLIVA_URL]) },
        ],
      },
      [PADRON_URL]: { body: loadFixture("product-padron.html") },
      [OLIVA_URL]: { body: loadFixture("product-oliva.html") },
    });

    const result = await runIngest(deps(fetcher, null), { adapter, vendorId, mode: "offers" });

    expect(result.status).toBe("succeeded");
    // Both products were walked — neither single fetch alone enumerated both.
    expect(result.stats.listingsParsed).toBe(2);
    expect(fetcher.requested).toContain(PADRON_URL);
    expect(fetcher.requested).toContain(OLIVA_URL);
    expect(result.stats.sitemapSampling).toEqual({
      samples: 3,
      locsPerSample: [1, 0, 1],
      unionLocs: 2,
      productLocs: 2,
      varied: true,
    });
  });

  it("sampling that enumerates nothing FAILS the run rather than recording a silent zero", async () => {
    const adapter: VendorAdapter = { ...foxCigar, sitemapSampling: { samples: 2 } };
    const result = await runIngest(deps(createMockFetcher({
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([]) },
    }), null), { adapter, vendorId, mode: "offers" });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/sitemap sampling/);
    expect(result.stats.sitemapSampling).toMatchObject({ samples: 2, unionLocs: 0, productLocs: 0 });

    const run = await pg.db.select().from(crawlRuns).where(eq(crawlRuns.id, result.crawlRunId!));
    expect(run[0]!.status).toBe("failed");
    expect(run[0]!.error).toMatch(/sitemap sampling/);
  });

  it("a vendor WITHOUT sampling keeps the old behavior: one fetch, empty sitemap succeeds with zero", async () => {
    const fetcher = createMockFetcher({
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([]) },
    });
    const result = await runIngest(deps(fetcher, null), { adapter: foxCigar, vendorId, mode: "offers" });

    expect(result.status).toBe("succeeded");
    expect(result.stats.listingsParsed).toBe(0);
    expect(result.stats.sitemapSampling).toBeUndefined();
    expect(fetcher.requested.filter((u) => u === SITEMAP)).toHaveLength(1);
  });

  // --- exclusion gate (root-level product slugs, no shared prefix) -----------

  it("an exclusion-gate adapter walks only the root-level product slugs", async () => {
    const inserted = await pg.db
      .insert(vendors)
      .values({ name: "Small Batch Cigar", url: smallBatchCigar.url, focus: "NC", approvalStatus: "owner-added" })
      .returning({ id: vendors.id });
    const sbVendorId = inserted[0]!.id;

    const SB = "https://www.smallbatchcigar.com";
    const NOELLA = `${SB}/tatuaje-brown-label-noella/`;
    const CUTTER = `${SB}/xikar-xi3-cutter/`;
    const fetcher = createMockFetcher({
      [`${SB}/robots.txt`]: { body: loadFixture("robots.txt", "small-batch") },
      [smallBatchCigar.sitemapUrl]: { body: loadFixture("sitemap.xml", "small-batch") },
      [`${SB}/products-sitemap-1.xml`]: { body: loadFixture("products-sitemap-1.xml", "small-batch") },
      [NOELLA]: { body: loadFixture("product.html", "small-batch") },
      [CUTTER]: { body: loadFixture("product-cutter.html", "small-batch") },
    });

    const result = await runIngest(deps(fetcher, null), {
      adapter: smallBatchCigar,
      vendorId: sbVendorId,
      mode: "offers",
    });

    expect(result.status).toBe("succeeded");
    // The sitemap also lists /pages/about-us/ and /cart.php — neither is fetched.
    expect(fetcher.requested).toEqual([
      `${SB}/robots.txt`,
      smallBatchCigar.sitemapUrl,
      `${SB}/products-sitemap-1.xml`,
      NOELLA,
      CUTTER,
    ]);
    expect(result.stats.listingsParsed).toBe(2);
    expect(result.stats.skippedNonCigar).toBe(1); // the cutter
  });

  it("robots disallow fails the run and records the reason in crawl_runs.error", async () => {
    const routes = {
      [ROBOTS]: { body: "User-agent: *\nDisallow: /\n" },
      [SITEMAP]: { body: urlsetXml([PADRON_URL]) },
    };
    const result = await runIngest(deps(createMockFetcher(routes), null), {
      adapter: foxCigar,
      vendorId,
      mode: "seed",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/robots\.txt disallows/);

    const failed = await pg.db
      .select()
      .from(crawlRuns)
      .where(eq(crawlRuns.status, "failed"));
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed.some((r) => (r.error ?? "").includes("robots.txt disallows"))).toBe(true);
  });
});
