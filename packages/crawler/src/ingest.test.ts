import { randomUUID } from "node:crypto";
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
  enrichmentAttempts,
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

  // `type` is explicit for the enrich cases: the drain filters on the cigar's
  // market, and an untyped row is selectable by EVERY vendor (see the untyped case
  // below), which would quietly defeat a focus assertion.
  const seedCigar = async (canonicalName: string, type: "NC" | "CC" | null = null): Promise<string> => {
    const rows = await pg.db
      .insert(cigars)
      .values({ canonicalName, type, verification: "verified" })
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

  // --- mode: enrich, per-vendor budgets (#158, migration 0023) ---------------
  //
  // The ruling these tests encode: a vendor's catalogue is PARTIAL, so "no match
  // at Fox" is evidence about Fox and about nothing else. Every case below is one
  // consequence of that sentence. The fleet is a fleet-wide fact, so each case
  // sets it explicitly rather than inheriting whatever a neighbour left enabled.

  // The drain reads the WHOLE open queue, and eligibility is a fleet-wide fact, so
  // a request or an enabled vendor left over from a neighbouring case would change
  // this one's denominator. `arrange` declares both at the top of a case; `setFleet`
  // alone is the mid-case registry change several cases are actually about.
  async function setFleet(enabled: string[]): Promise<void> {
    await pg.db.update(vendors).set({ crawlEnabled: false });
    for (const id of enabled) {
      await pg.db.update(vendors).set({ crawlEnabled: true }).where(eq(vendors.id, id));
    }
  }

  async function arrange(enabled: string[]): Promise<void> {
    await pg.db.delete(enrichmentRequests);
    await setFleet(enabled);
  }

  // A vendor gets a succeeded `enrich` run by default, because the exhaustion
  // denominator is LIVENESS and not `crawl_enabled` — nothing in the crawler reads
  // that flag (#156), so an enabled vendor whose CronJob is suspended counts
  // against nothing. `enrichRun: false` is the prod Cuban Lou's shape and the
  // cases that pass it are about exactly that.
  async function makeVendor(
    name: string,
    focus: "NC" | "CC" | "both",
    opts: { enrichRun?: boolean } = {},
  ): Promise<string> {
    const rows = await pg.db
      .insert(vendors)
      .values({ name: `${name} ${randomUUID().slice(0, 8)}`, url: "https://foxcigar.com", focus, crawlEnabled: true })
      .returning({ id: vendors.id });
    const id = rows[0]!.id;
    if (opts.enrichRun ?? true) {
      await pg.db.insert(crawlRuns).values({ vendorId: id, kind: "enrich", status: "succeeded", startedAt: now() });
    }
    return id;
  }

  // `createdAt` is explicit where a case depends on drain ORDER (the queue is
  // drained oldest-first), so the assertion does not ride on insert timing.
  async function seedRequest(cigarId: string, createdAt?: Date): Promise<string> {
    const rows = await pg.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "pending", ...(createdAt ? { createdAt } : {}) })
      .returning({ id: enrichmentRequests.id });
    return rows[0]!.id;
  }

  const requestRow = async (id: string) =>
    (await pg.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.id, id)))[0]!;

  const ledgerRows = async (requestId: string) =>
    pg.db.select().from(enrichmentAttempts).where(eq(enrichmentAttempts.requestId, requestId));

  // A sitemap that enumerates products, none of which resemble the requested
  // cigar: the shape of a real "this vendor does not carry that brand" drain.
  const missRoutes = {
    [ROBOTS]: { body: loadFixture("robots.txt") },
    [SITEMAP]: { body: urlsetXml([PADRON_URL]) },
    [PADRON_URL]: { body: loadFixture("product-padron.html") },
  };

  const hitRoutes = {
    [ROBOTS]: { body: loadFixture("robots.txt") },
    [SITEMAP]: { body: urlsetXml([OLIVA_URL]) },
    [OLIVA_URL]: { body: loadFixture("product-oliva.html") },
    [OLIVA_IMG]: { binary: Buffer.from("oliva-image"), contentType: "image/jpeg" },
  };

  const enrichRun = (vendor: string, routes: Record<string, unknown>, storage: PhotoStorage | null = null) =>
    runIngest(deps(createMockFetcher(routes as Parameters<typeof createMockFetcher>[0]), storage), {
      adapter: foxCigar,
      vendorId: vendor,
      mode: "enrich",
    });

  it("enrich fulfills a pending request on a name hit, and a miss burns exactly one attempt at that vendor", async () => {
    await arrange([vendorId]);
    const storage = createMemoryPhotoStorage();

    const olivaId = await seedCigar(OLIVA_NAME, "NC");
    const hitReqId = await seedRequest(olivaId);

    const hit = await enrichRun(vendorId, hitRoutes, storage);
    expect(hit.status).toBe("succeeded");
    expect(hit.stats.offersWritten).toBe(1);
    expect(hit.stats.matchesAuto).toBe(1);
    expect(hit.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 1, errored: 0, spent: 0 });

    const fulfilled = await requestRow(hitReqId);
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.resolvedAt).not.toBeNull();
    // `attempts` counts every COMPLETED look across vendors, a match included.
    expect(fulfilled.attempts).toBe(1);
    const olivaOffers = await pg.db.select().from(offers).where(eq(offers.listingUrl, OLIVA_URL));
    expect(olivaOffers).toHaveLength(1);

    // A fulfilled ask is terminal — the next drain must not re-select it.
    const again = await enrichRun(vendorId, hitRoutes, storage);
    expect(again.stats.enrich!.requests).toBe(0);
  });

  // THE #158 REGRESSION. Before migration 0023 the budget was one counter on the
  // REQUEST, shared by the whole fleet: vendor A's two looks retired the row and
  // vendor B — which might well stock the brand — was never asked. This is the
  // owner's Red Anchor case in miniature (Fox does not carry it; 2 Guys does).
  it("one vendor spending its whole budget does not retire a request another vendor has not looked at", async () => {
    const a = await makeVendor("Lane A", "NC");
    const b = await makeVendor("Lane B", "NC");
    await arrange([a, b]);

    const cigarId = await seedCigar("Red Anchor Captain Robusto", "NC");
    const requestId = await seedRequest(cigarId);

    await enrichRun(a, missRoutes);
    await enrichRun(a, missRoutes);

    // A is spent. Pre-0023 this row would read `exhausted` right here.
    let row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.resolvedAt).toBeNull();
    let ledger = await ledgerRows(requestId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.vendorId).toBe(a);
    expect(ledger[0]!.attempts).toBe(2);

    // A's third run does not even select it — its own budget is spent.
    const skipped = await enrichRun(a, missRoutes);
    expect(skipped.stats.enrich!.requests).toBe(0);

    await enrichRun(b, missRoutes);
    expect((await requestRow(requestId)).status).toBe("pending");
    const spending = await enrichRun(b, missRoutes);
    expect(spending.stats.enrich).toMatchObject({ requests: 1, looked: 1, spent: 1 });

    row = await requestRow(requestId);
    expect(row.status).toBe("exhausted");
    expect(row.resolvedAt).not.toBeNull();
    // `attempts` on the request is now a REPORTING total of completed looks across
    // vendors — four real looks happened.
    expect(row.attempts).toBe(4);

    // And the verdict NAMES the vendors. An `exhausted` state that does not is
    // meaningless (ADR-006 amendment 2026-08-30).
    ledger = await ledgerRows(requestId);
    expect(ledger.map((r) => r.vendorId).sort()).toEqual([a, b].sort());
    expect(ledger.every((r) => r.attempts === 2 && r.errors === 0)).toBe(true);
  });

  // The live shape: one enabled NC vendor, one NC cigar it does not stock.
  // Exhaustion is legitimate here — but it is unreachable without a ledger row
  // saying WHO looked.
  it("a single-vendor fleet exhausts after its own two looks, and never without a ledger row", async () => {
    const only = await makeVendor("Sole Lane", "NC");
    await arrange([only]);

    const cigarId = await seedCigar("Nonexistent Phantom Cigar Zeta", "NC");
    const requestId = await seedRequest(cigarId);

    await enrichRun(only, missRoutes);
    let row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect((await ledgerRows(requestId))[0]!.attempts).toBe(1);

    await enrichRun(only, missRoutes);
    row = await requestRow(requestId);
    expect(row.status).toBe("exhausted");
    expect(row.attempts).toBe(2);

    const ledger = await ledgerRows(requestId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.vendorId).toBe(only);
    expect(ledger[0]!.attempts).toBe(2);

    // No exhausted row anywhere in the table lacks its evidence.
    const retired = await pg.db
      .select()
      .from(enrichmentRequests)
      .where(eq(enrichmentRequests.status, "exhausted"));
    for (const r of retired) expect((await ledgerRows(r.id)).length).toBeGreaterThan(0);
  });

  // `focus` as a NEGATIVE filter: a CC-only lane will not carry an NC cigar, so it
  // must never spend a look there — not even to learn what it already knows.
  it("a CC-only vendor never selects an NC cigar's request and spends nothing", async () => {
    const cc = await makeVendor("Havana Only", "CC");
    await arrange([cc]);

    const cigarId = await seedCigar("Padron Family Reserve No 45 NC Only", "NC");
    const requestId = await seedRequest(cigarId);

    const run = await enrichRun(cc, missRoutes);
    expect(run.stats.enrich!.requests).toBe(0);
    expect(await ledgerRows(requestId)).toHaveLength(0);
    const row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  // THE PROD SHAPE, and the blocker of the #158 review. Fox Cigar (NC) drains
  // nightly; Cuban Lou's (CC) is crawl-enabled with a SUSPENDED enrich CronJob and
  // only a `seed` run to its name. 890 of 977 catalog rows are untyped, so they
  // need both markets — and holding them against a lane that has never run left
  // every one of them permanently un-exhausted, which also put them permanently
  // out of `retryExhausted`'s reach. A lane that has never run counts against
  // nothing; it reopens what it has not looked at the night it does run.
  it("a lane that has never run holds no untyped request open, and reopens it when it does run", async () => {
    const fox = await makeVendor("Fox Prod Shape", "NC");
    const cubanLous = await makeVendor("Cuban Lous Prod Shape", "CC", { enrichRun: false });
    await arrange([fox, cubanLous]);

    const rows = await pg.db
      .insert(cigars)
      .values({ canonicalName: `Untyped Prod Row ${randomUUID().slice(0, 8)}`, type: null, verification: "verified" })
      .returning({ id: cigars.id });
    const requestId = await seedRequest(rows[0]!.id);

    await enrichRun(fox, missRoutes);
    expect((await requestRow(requestId)).status).toBe("pending");
    const retiring = await enrichRun(fox, missRoutes);
    expect(retiring.stats.enrich).toMatchObject({ spent: 1, blocked: 0 });
    expect((await requestRow(requestId)).status).toBe("exhausted");

    // Cuban Lou's lane comes up. `exhausted` is in the drain's open set and it has
    // no ledger row, so its first night picks the request straight up — no reopen
    // job, no backfill — and the row is open again.
    const first = await enrichRun(cubanLous, missRoutes);
    expect(first.stats.enrich!.requests).toBe(1);
    expect((await requestRow(requestId)).status).toBe("pending");
    await enrichRun(cubanLous, missRoutes);
    expect((await requestRow(requestId)).status).toBe("exhausted");
    expect((await ledgerRows(requestId)).map((r) => r.vendorId).sort()).toEqual([fox, cubanLous].sort());
  });

  // An untyped cigar could belong to either market, so EVERY lane that runs is in
  // its denominator — the generalization of the backlog's both-markets rule.
  it("an untyped cigar is selectable by every vendor and retires only when all of them are spent", async () => {
    const nc = await makeVendor("Untyped NC", "NC");
    const cc = await makeVendor("Untyped CC", "CC");
    await arrange([nc, cc]);

    const rows = await pg.db
      .insert(cigars)
      .values({ canonicalName: `Unknown Market Mystery ${randomUUID().slice(0, 8)}`, type: null, verification: "verified" })
      .returning({ id: cigars.id });
    const requestId = await seedRequest(rows[0]!.id);

    await enrichRun(nc, missRoutes);
    await enrichRun(nc, missRoutes);
    expect((await requestRow(requestId)).status).toBe("pending");

    // The CC lane really does select it — an unknown market cannot rule it out.
    const ccRun = await enrichRun(cc, missRoutes);
    expect(ccRun.stats.enrich!.requests).toBe(1);
    await enrichRun(cc, missRoutes);
    expect((await requestRow(requestId)).status).toBe("exhausted");
    expect((await ledgerRows(requestId)).map((r) => r.vendorId).sort()).toEqual([nc, cc].sort());
  });

  // THE REOPEN PATH, and the reason this design needs no reopen job. `exhausted`
  // only ever meant "exhausted at the vendors that looked"; a newly enabled vendor
  // is new evidence, not a retry of old evidence. No cron, no backfill, no manual
  // reset appears anywhere in this test.
  it("enabling a vendor reopens an exhausted request, which its first run can fulfil", async () => {
    const a = await makeVendor("Reopen A", "NC");
    await arrange([a]);

    const olivaId = await seedCigar(OLIVA_NAME, "NC");
    const requestId = await seedRequest(olivaId);

    await enrichRun(a, missRoutes);
    await enrichRun(a, missRoutes);
    expect((await requestRow(requestId)).status).toBe("exhausted");

    // The registry gains a lane that might stock the brand.
    const b = await makeVendor("Reopen B", "NC");
    await setFleet([a, b]);

    const reopened = await enrichRun(b, hitRoutes, createMemoryPhotoStorage());
    expect(reopened.stats.enrich).toMatchObject({ requests: 1, matched: 1 });
    const row = await requestRow(requestId);
    expect(row.status).toBe("fulfilled");
    expect(row.resolvedAt).not.toBeNull();
  });

  it("a reopened request that the new vendor also misses returns to exhausted, naming both vendors", async () => {
    const a = await makeVendor("Reopen Miss A", "NC");
    await arrange([a]);

    const cigarId = await seedCigar("Nonexistent Phantom Cigar Omega", "NC");
    const requestId = await seedRequest(cigarId);
    await enrichRun(a, missRoutes);
    await enrichRun(a, missRoutes);
    expect((await requestRow(requestId)).status).toBe("exhausted");

    const b = await makeVendor("Reopen Miss B", "NC");
    await setFleet([a, b]);

    // The moment B is eligible the row is open again, and its cached status falls
    // back to `pending` with resolved_at cleared at the first finalize.
    await enrichRun(b, missRoutes);
    let row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.resolvedAt).toBeNull();

    await enrichRun(b, missRoutes);
    row = await requestRow(requestId);
    expect(row.status).toBe("exhausted");
    expect((await ledgerRows(requestId)).map((r) => r.vendorId).sort()).toEqual([a, b].sort());
  });

  // A look that could not COMPLETE is not evidence about a catalogue. A 503 says
  // nothing about whether the vendor stocks the brand, so it must not burn budget —
  // but it is bounded, or a permanently broken vendor pins the request open and
  // re-fetches the same failures every night forever.
  it("a look that could not complete records an error, not an attempt, and retires the vendor at ERROR_BUDGET", async () => {
    const only = await makeVendor("Broken Lane", "NC");
    await arrange([only]);

    const cigarId = await seedCigar("Padron 1964 Anniversary Maduro Torpedo Unreachable", "NC");
    const requestId = await seedRequest(cigarId);

    // The candidate ranks (the slug shares tokens) but answers 500 every time.
    const brokenRoutes = {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([PADRON_URL]) },
      [PADRON_URL]: { status: 500, body: "" },
    };

    const first = await enrichRun(only, brokenRoutes);
    expect(first.stats.enrich).toMatchObject({ requests: 1, looked: 0, matched: 0, errored: 1, spent: 0 });
    let row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    let ledger = await ledgerRows(requestId);
    expect(ledger[0]!.errors).toBe(1);
    expect(ledger[0]!.attempts).toBe(0);
    expect(ledger[0]!.lastOutcome).toBe("error");

    await enrichRun(only, brokenRoutes);
    const third = await enrichRun(only, brokenRoutes);
    // BLOCKED, never `exhausted` (#158 review). The ledger holds zero completed
    // looks, so "we looked and found nothing" would be a fabrication — the request
    // is retired because nobody could finish looking, which is a different fact and
    // is counted and reported as one.
    expect(third.stats.enrich).toMatchObject({ spent: 0, blocked: 1 });
    row = await requestRow(requestId);
    expect(row.status).not.toBe("exhausted");
    expect(row.resolvedAt).toBeNull();
    expect(row.attempts).toBe(0);
    ledger = await ledgerRows(requestId);
    expect(ledger[0]!.errors).toBe(3);

    // Retired all the same: the fourth run does not select it.
    expect((await enrichRun(only, brokenRoutes)).stats.enrich!.requests).toBe(0);
  });

  // An enumeration that yields NO product URLs is an adapter/gate failure, not a
  // fact about the cigar. It must not burn budget.
  it("an empty product enumeration is an error, never a miss", async () => {
    const only = await makeVendor("Bad Gate", "NC");
    await arrange([only]);

    const cigarId = await seedCigar("Nonexistent Phantom Cigar Iota", "NC");
    const requestId = await seedRequest(cigarId);

    // Every URL the sitemap enumerates fails the product gate.
    const run = await enrichRun(only, {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml(["https://foxcigar.com/about/", "https://foxcigar.com/contact/"]) },
    });
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 0, errored: 1 });
    expect((await requestRow(requestId)).attempts).toBe(0);
    expect((await ledgerRows(requestId))[0]!.errors).toBe(1);
  });

  // THE 2 GUYS SHAPE, which the empty-enumeration case above does NOT cover and
  // which the previous round misclassified (#158 review). An over-matching product
  // gate does not enumerate nothing — it enumerates plenty. The live probe in
  // ADR-006 had `/store/` pass 1,462 locs that were gift-registry pages: they
  // ANSWER 200, they simply carry no schema.org Product, so `parsed = 0`. Calling
  // that a miss burns real budget for a gate defect and then reports "2 Guys looked
  // and does not carry it" — manufactured evidence about a vendor, which is exactly
  // what the ADR amendment forbids.
  it("candidates that answer 200 with no product JSON-LD are an error, never a miss", async () => {
    const only = await makeVendor("Registry Pages", "NC");
    await arrange([only]);

    const cigarId = await seedCigar("Padron 1964 Anniversary Maduro Torpedo Gated", "NC");
    const requestId = await seedRequest(cigarId);

    // The gate admits the URL and the page answers 200 — it is simply not a
    // product. That is the ONLY difference from the case above, and it is the one
    // that decides between `miss` and `error`.
    const gateRoutes = {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([PADRON_URL]) },
      [PADRON_URL]: { status: 200, body: "<html><body><h1>Gift registry</h1></body></html>" },
    };

    const run = await enrichRun(only, gateRoutes);
    expect(run.stats.listingsParsed).toBe(0);
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 0, matched: 0, errored: 1 });
    const ledger = await ledgerRows(requestId);
    expect(ledger[0]!.attempts).toBe(0);
    expect(ledger[0]!.errors).toBe(1);
    expect(ledger[0]!.lastOutcome).toBe("error");

    // Two more nights and the request is BLOCKED, not `exhausted`: no vendor is
    // ever reported as having looked at a cigar it was never actually shown.
    await enrichRun(only, gateRoutes);
    const third = await enrichRun(only, gateRoutes);
    expect(third.stats.enrich).toMatchObject({ spent: 0, blocked: 1 });
    expect((await requestRow(requestId)).status).not.toBe("exhausted");
  });

  // The other side of that line: a page that DOES parse as a product and simply is
  // not this cigar is a completed look. We read the vendor's catalogue.
  it("a parsed product that is not the cigar is a miss, and burns an attempt", async () => {
    const only = await makeVendor("Parses Fine", "NC");
    await arrange([only]);

    // Shares a slug token with the Padron listing (so it ranks and IS fetched) and
    // nothing else (so it falls under the similarity floor).
    const cigarId = await seedCigar("Vega Fina Nicaragua Torpedo", "NC");
    const requestId = await seedRequest(cigarId);

    const run = await enrichRun(only, missRoutes);
    expect(run.stats.listingsParsed).toBe(1);
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 0, errored: 0 });
    const ledger = await ledgerRows(requestId);
    expect(ledger[0]!.attempts).toBe(1);
    expect(ledger[0]!.errors).toBe(0);
    expect(ledger[0]!.lastOutcome).toBe("miss");
  });

  // The tempting mis-read this guards against: "no candidate scored" is not an
  // absence of evidence. The vendor's product list WAS read and nothing in it
  // resembled the cigar — the Red Anchor/Fox drain (10 pages, 8 listings, 0
  // matches) is exactly this, and it is honest evidence about Fox.
  it("'no candidate scored above zero' is a completed look and burns an attempt", async () => {
    const only = await makeVendor("Scoreless", "NC");
    await arrange([only]);

    const cigarId = await seedCigar("Nonexistent Phantom Cigar Kappa", "NC");
    const requestId = await seedRequest(cigarId);

    const run = await enrichRun(only, missRoutes);
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, errored: 0 });
    const ledger = await ledgerRows(requestId);
    expect(ledger[0]!.attempts).toBe(1);
    expect(ledger[0]!.errors).toBe(0);
    expect(ledger[0]!.lastOutcome).toBe("miss");
  });

  // #157 defect 2 cannot form. The drain no longer claims a request with
  // `status = 'in_progress'` — that was a request-level lock on a per-vendor
  // operation — so a run that dies mid-drain leaves the row exactly as it found it,
  // with no reaper anywhere in the system.
  it("a run that throws mid-drain strands nothing: the row stays pending, never in_progress", async () => {
    const only = await makeVendor("Crashing", "NC");
    await arrange([only]);

    const firstId = await seedRequest(await seedCigar("Nonexistent Phantom Cigar Mu", "NC"), new Date("2026-08-30T09:00:00.000Z"));
    const secondId = await seedRequest(
      await seedCigar("Padron 1964 Anniversary Maduro Torpedo Exploding", "NC"),
      new Date("2026-08-30T10:00:00.000Z"),
    );

    // The second request's candidate blows up the whole run.
    const base = createMockFetcher(missRoutes);
    const exploding: MockFetcher = {
      requested: base.requested,
      get pagesFetched() {
        return base.pagesFetched;
      },
      fetchText: async (url: string) => {
        if (url === PADRON_URL) throw new Error("connection reset");
        return base.fetchText(url);
      },
      fetchBinary: (url: string) => base.fetchBinary(url),
    };

    const crashed = await runIngest(deps(exploding, null), { adapter: foxCigar, vendorId: only, mode: "enrich" });
    expect(crashed.status).toBe("failed");

    // The first request completed its look and was written before the crash.
    const first = await requestRow(firstId);
    expect(first.status).toBe("pending");
    expect(first.attempts).toBe(1);
    // The second was selected and never finalized — and is simply retried, because
    // nothing marked it claimed.
    const second = await requestRow(secondId);
    expect(second.status).toBe("pending");
    expect(await ledgerRows(secondId)).toHaveLength(0);

    // Nothing anywhere in the table is in_progress: the drain never writes it.
    const stranded = await pg.db
      .select()
      .from(enrichmentRequests)
      .where(eq(enrichmentRequests.status, "in_progress"));
    expect(stranded).toHaveLength(0);
  });

  // A robots refusal fails the whole run before any request is touched — no ledger
  // writes at all, which is right: we never asked the vendor anything.
  it("a robots refusal spends nothing", async () => {
    const only = await makeVendor("Refused", "NC");
    await arrange([only]);
    const requestId = await seedRequest(await seedCigar("Nonexistent Phantom Cigar Nu", "NC"));

    const refused = await enrichRun(only, {
      [ROBOTS]: { body: "User-agent: *\nDisallow: /\n" },
    });
    expect(refused.status).toBe("failed");
    expect(await ledgerRows(requestId)).toHaveLength(0);
    expect((await requestRow(requestId)).attempts).toBe(0);
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
      // Marginal contribution per sample — the number `samples` is tuned from.
      // Recorded in crawl_runs.stats, not just computed and dropped.
      newPerSample: [1, 0, 1],
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
