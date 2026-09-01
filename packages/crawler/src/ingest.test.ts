import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, ne, sql } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import {
  createDatabase,
  vendors,
  brands,
  cigars,
  offers,
  productPhotos,
  crawlRuns,
  listingMatches,
  enrichmentRequests,
  enrichmentAttempts,
  auditLog,
  type NewCigarRow,
} from "@cj/db";
import { brandSlug, curationWorklist, enrichmentCoverageForCigar, enrichVendorFleet, fold } from "@cj/domain";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
import { runIngest, type IngestDeps } from "./core/ingest.js";
import { resolveListing, upsertListingMatch } from "./core/match.js";
import { pathOf } from "./core/product-url.js";
import {
  markRunTerminated,
  openCrawlRun,
  reclaimStrandedRuns,
  withVendorLaneLock,
  type SignalHost,
} from "./core/run-record.js";
import { foxCigar } from "./adapters/fox-cigar.js";
import { smallBatchCigar } from "./adapters/small-batch-cigar.js";
import { createMockFetcher, urlsetXml, loadFixture, fakeProcessPhoto, type MockFetcher } from "./testing/fixtures.js";
import type { VendorAdapter } from "./adapters/types.js";

// End-to-end over a real embedded Postgres (migrated to head). The fetch layer is
// mocked per the guardrail (NEVER live sites); the photo pipeline is stubbed so
// the harness needs no image bytes.

const PADRON_URL = "https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo/";
const PADRON_BOX_URL = "https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo-box-of-20/";
const UNKNOWN_MARCA_URL = "https://foxcigar.com/shop/vuelta-abajo-reserva-especial-robusto/";
const LIGHTER_URL = "https://foxcigar.com/shop/xikar-hp3-lighter/";
const SAMPLER_URL = "https://foxcigar.com/shop/fox-5-cigar-sampler/";
const OLIVA_URL = "https://foxcigar.com/shop/oliva-serie-v-melanio-torpedo/";
// The two shelf-mates the enrich drain's miss cases read: a product the ask's own
// marca is on, which is not the ask. See `missRoutes`.
const OLIVA_ROBUSTO_URL = "https://foxcigar.com/shop/oliva-serie-v-melanio-robusto/";
const RED_ANCHOR_URL = "https://foxcigar.com/shop/red-anchor-admiral/";
const PADRON_IMG = "https://foxcigar.com/wp-content/uploads/padron-1964-torpedo.jpg";
const OLIVA_IMG = "https://foxcigar.com/wp-content/uploads/oliva-melanio-torpedo.jpg";
const ROBOTS = "https://foxcigar.com/robots.txt";
const SITEMAP = "https://foxcigar.com/sitemap.xml";

const PADRON_NAME = "Padron 1964 Anniversary Maduro Torpedo";
const OLIVA_NAME = "Oliva Serie V Melanio Torpedo";
const UNKNOWN_MARCA_NAME = "Vuelta Abajo Reserva Especial Robusto";

describe("crawler ingest (embedded Postgres)", () => {
  let pg: TestPostgres;
  let vendorId: string;
  // The two marcas this file's fixtures sell. Matching v2 anchors on a brand
  // alias before it reads a title as a name (ADR-012 Wave 2), so these ids are
  // what every seed/offers case below is standing on.
  let padronBrandId: string;
  let olivaBrandId: string;
  const now = () => new Date("2026-08-28T12:00:00.000Z");

  function deps(fetcher: MockFetcher, storage: PhotoStorage | null): IngestDeps {
    return { db: pg.db, fetcher, storage, now, processPhoto: fakeProcessPhoto };
  }

  // THE REGISTRY ENTRY A LISTING NEEDS BEFORE IT CAN RESOLVE TO ANYTHING.
  // Matching v2 anchors on a brand alias first and refuses everything downstream
  // without one — no match, and in seed mode no mint either (`no_anchor`). So a
  // fixture listing is unresolvable until its marca is registered, which is why
  // this exists and why migration 0026's registry is a precondition of the whole
  // matcher rather than a lookup table beside it.
  //
  // `aliases` holds folded MATCHING KEYS and never display text — the convention
  // 0026 seeds and the GIN probe is an exact array-containment test, so a
  // source-case spelling stored here would simply never be probed for.
  const seedBrand = async (name: string): Promise<string> => {
    const rows = await pg.db
      .insert(brands)
      .values({ name, slug: brandSlug(name), aliases: [...new Set([brandSlug(name), fold(name)])] })
      .onConflictDoNothing()
      .returning({ id: brands.id });
    if (rows[0]) return rows[0].id;
    const existing = await pg.db
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.slug, brandSlug(name)))
      .limit(1);
    return existing[0]!.id;
  };

  // `type` is explicit for the enrich cases: the drain filters on the cigar's
  // market, and an untyped row is selectable by EVERY vendor (see the untyped case
  // below), which would quietly defeat a focus assertion.
  //
  // `extra` carries the structural ancestry matching v2 reads. A cigar a listing
  // must be able to FIND has to sit in the anchored brand's scope: either
  // `brandId` set, or — the transitional bridge in `scopedLeafCandidates`, which
  // dies with the Wave 3 backfill — its own canonical name folding to the brand's
  // key. The cases below set `brandId` explicitly wherever the scope is the point.
  const seedCigar = async (
    canonicalName: string,
    type: "NC" | "CC" | null = null,
    extra: Partial<NewCigarRow> = {},
  ): Promise<string> => {
    const rows = await pg.db
      .insert(cigars)
      .values({ canonicalName, type, verification: "verified", ...extra })
      .returning({ id: cigars.id });
    return rows[0]!.id;
  };

  // MATCHING V2 SCOPES CANDIDATES TO THE ANCHORED BRAND, which makes this file's
  // habit of seeding a dozen rows all called `Oliva Serie V Melanio Torpedo`
  // visible for the first time: under one marca they are a real ambiguity, and v2
  // refuses to choose between them (`kind: 'ambiguous'`) rather than guessing. v1
  // hid the same collision instead of resolving it — its exact-name lookup took
  // `LIMIT 1` and kept whichever row Postgres handed back first — which is the
  // only reason the cases below used to reach the guard they are actually about.
  //
  // A case about the MARKET guard, or about the upsert guard, needs the resolver
  // to reach a single leaf before its own subject comes up. So it retires the
  // namesakes it did not create: `catalog_status` is the catalog's own lifecycle
  // gate and `scopedLeafCandidates` filters on `active`, so this removes the
  // duplicates from the scope without touching what any earlier case asserted.
  const soleActiveLeaf = async (canonicalName: string, keep: string): Promise<void> => {
    await pg.db
      .update(cigars)
      .set({ catalogStatus: "excluded" })
      .where(and(eq(cigars.canonicalName, canonicalName), ne(cigars.id, keep)));
  };

  beforeAll(async () => {
    pg = await startTestPostgres();
    const inserted = await pg.db
      .insert(vendors)
      .values({ name: "Fox Cigar", url: "https://foxcigar.com", focus: "NC", crawlEnabled: true, approvalStatus: "owner-added" })
      .returning({ id: vendors.id });
    vendorId = inserted[0]!.id;
    // Both marcas the Fox fixtures sell. Without them every fixture listing
    // resolves `no_anchor` and the seed cases below would assert nothing —
    // 0 created, 0 matched, everything in triage.
    padronBrandId = await seedBrand("Padron");
    olivaBrandId = await seedBrand("Oliva");
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
    // The brand anchored, so this is the one arm that still mints: `none` — we
    // know the marca, we looked under it, and the leaf is genuinely not there.
    // Absent-when-zero like their siblings, so a clean run's stats serialise into
    // crawl_runs exactly as they did before matching v2 added the counters.
    expect(first.stats.linksNoAnchor).toBeUndefined();
    expect(first.stats.linksAmbiguous).toBeUndefined();

    // The catalog cigar is unverified, and STRUCTURED. It used to be minted from
    // the raw vendor title with `brand` left null — "no prior taxonomy" — which is
    // how packaging SKUs became catalog rows. v2 writes what the parse actually
    // established: the REGISTRY's spelling of the marca (not the vendor's, so the
    // free-text column and the `brand_id` link cannot disagree the moment the row
    // is born), the link itself, and the vitola read off the trade vocabulary.
    // `line`/`blend` stay null because nothing seeded any — absent is never
    // inferred (ADR-012).
    const created = await pg.db.select().from(cigars).where(eq(cigars.canonicalName, PADRON_NAME));
    expect(created).toHaveLength(1);
    expect(created[0]!.verification).toBe("unverified");
    expect(created[0]!.brand).toBe("Padron");
    expect(created[0]!.brandId).toBe(padronBrandId);
    expect(created[0]!.line).toBeNull();
    expect(created[0]!.lineId).toBeNull();
    expect(created[0]!.blendId).toBeNull();
    expect(created[0]!.vitolaName).toBe("Torpedo");
    // This title states no dimensions, so none are invented.
    expect(created[0]!.lengthInches).toBeNull();
    expect(created[0]!.ringGauge).toBeNull();
    // `canonical_name` is the title with PACKAGING STRIPPED; this one carries
    // none, so it survives verbatim. (The boxed listing next door is the case
    // where the two differ.)
    expect(created[0]!.canonicalName).toBe(PADRON_NAME);
    // The NAME is still the vendor's phrasing, not a composition the catalog
    // stands behind — composing it is curation's call (Wave 3), not a crawl's.
    expect(created[0]!.nameSource).toBe("freeform");
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
    // A clean link carries NO parse (migration 0027): there is nothing left for a
    // curator to resolve, and a parse left on a row that has become a link reads
    // as an open question that is not open.
    expect(matches[0]!.suggestedParse).toBeNull();
    // The breadcrumbs are kept whatever the verdict — they are a fact about the
    // listing, not about the decision, and they are the one structured taxonomy
    // signal a vendor publishes. Parsed since the crawler was written and thrown
    // away after one boolean category gate until 0027.
    expect(matches[0]!.categoryPath).toEqual(["Home", "Shop", "Cigars", "Padron"]);

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

  // PACKAGING IS NEVER IDENTITY (ADR-012), and this is the case that says so end
  // to end. The same cigar, listed again as a full box: v1 read the title as a
  // name, found `similarity('… Box of 20', '…') ` short of the floor, and minted a
  // SECOND catalog row whose only distinguishing feature was the container it
  // shipped in. v2 strips packaging before the title is read as a name at all, so
  // the boxed listing resolves to the leaf that already exists — and the box
  // itself lands where it belongs, on the offer, which is the thing that is
  // actually sold by the box.
  it("a boxed listing links the leaf that already exists and records the box on the offer", async () => {
    const routes = {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([PADRON_BOX_URL]) },
      [PADRON_BOX_URL]: { body: loadFixture("product-padron-box.html") },
    };

    const before = await pg.db.select({ id: cigars.id }).from(cigars);
    const run = await runIngest(deps(createMockFetcher(routes), null), {
      adapter: foxCigar,
      vendorId,
      mode: "seed",
    });

    // Seed mode, a title it has never seen, and nothing is created: the marca
    // anchored and the leaf under it was already there.
    expect(run.stats.cigarsCreated).toBe(0);
    expect(run.stats.matchesAuto).toBe(1);
    expect((await pg.db.select({ id: cigars.id }).from(cigars)).length).toBe(before.length);
    // In particular, no row is named after a container.
    const boxNamed = await pg.db
      .select({ id: cigars.id })
      .from(cigars)
      .where(eq(cigars.canonicalName, `${PADRON_NAME} Box of 20`));
    expect(boxNamed).toHaveLength(0);

    const leaf = (await pg.db.select().from(cigars).where(eq(cigars.canonicalName, PADRON_NAME)))[0]!;
    const boxMatch = (
      await pg.db
        .select()
        .from(listingMatches)
        .where(eq(listingMatches.listingKey, "/shop/padron-1964-anniversary-maduro-torpedo-box-of-20/"))
    )[0]!;
    expect(boxMatch).toMatchObject({ status: "auto", cigarId: leaf.id, suggestedParse: null });

    // The packaging fact was not discarded with the tokens — it moved onto the
    // offer, which is the whole justification for stripping it out of the name.
    const boxOffer = (await pg.db.select().from(offers).where(eq(offers.listingUrl, PADRON_BOX_URL)))[0]!;
    expect(boxOffer.packaging).toBe("box");
    expect(boxOffer.sticksPerPackage).toBe(20);
    expect(Number(boxOffer.price)).toBe(460);
  });

  // THE HEADLINE BEHAVIOUR CHANGE OF MATCHING V2, asserted through the real seed
  // walk. `no brand anchor → no mint` is the single rule ADR-012 was written for:
  // seed mode used to create a catalog row from ANY title that failed to match,
  // which is how a flat namespace grew a parallel copy of itself for every vendor
  // (Cuban Lou's minted 56 rows over ground Fox already covered). A title the
  // registry cannot anchor is now a question for a curator, and the parse rides
  // the row so the curator inherits the reasoning instead of redoing it by eye.
  it("a title that anchors no brand mints nothing and lands in triage carrying its parse", async () => {
    const routes = {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([UNKNOWN_MARCA_URL]) },
      [UNKNOWN_MARCA_URL]: { body: loadFixture("product-unknown-marca.html") },
    };

    const run = await runIngest(deps(createMockFetcher(routes), null), {
      adapter: foxCigar,
      vendorId,
      mode: "seed",
    });

    expect(run.stats.listingsParsed).toBe(1);
    expect(run.stats.cigarsCreated).toBe(0);
    expect(run.stats.matchesAuto).toBe(0);
    // Counted, and counted separately from a no-match: a high `linksNoAnchor` is a
    // REGISTRY GAP, not a matcher failure, and the fix for it is aliases in Wave 3
    // curation rather than a looser matcher.
    expect(run.stats.linksNoAnchor).toBe(1);
    expect(await pg.db.select().from(cigars).where(eq(cigars.canonicalName, UNKNOWN_MARCA_NAME))).toHaveLength(0);

    const triaged = (
      await pg.db
        .select()
        .from(listingMatches)
        .where(eq(listingMatches.listingKey, "/shop/vuelta-abajo-reserva-especial-robusto/"))
    )[0]!;
    expect(triaged).toMatchObject({ cigarId: null, status: "unmatched", unmatchedReason: "no_anchor" });

    // The parse the resolver got to before it stopped. Every level is null because
    // the anchor is the FIRST step — without a brand there is nothing to look for a
    // line, a blend or a vitola within — and the whole title is residue, which is
    // precisely the "part the catalog cannot explain" a curator needs to read.
    const parse = triaged.suggestedParse!;
    expect(parse.brandId).toBeNull();
    expect(parse.brandName).toBeNull();
    expect(parse.lineId).toBeNull();
    expect(parse.blendId).toBeNull();
    expect(parse.vitolaName).toBeNull();
    expect(parse.cleanedName).toBe(UNKNOWN_MARCA_NAME);
    expect(parse.residue).toBe(UNKNOWN_MARCA_NAME);
    expect(parse.notes).toContain("No brand alias matched — nothing anchors this title.");
    // Evidence is kept on an unresolved row exactly as on a linked one.
    expect(triaged.categoryPath).toEqual(["Home", "Shop", "Cigars"]);

    // The offer is still written. A listing we cannot identify is still a price we
    // observed, and the offer hangs off the match row rather than off a cigar.
    expect(run.stats.offersWritten).toBe(1);
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

  // AN UNLINK MUST BE ATTRIBUTABLE. Every other path that clears a listing→cigar
  // link writes an audit row with a before snapshot — setListingMatchStatus for a
  // curator or an agent, excludeCigar for the cascade. The crawler's own market
  // downgrade, which is the one write #170 exists to perform (the `Romeo y Julieta
  // 1875` unlink), was a bare UPDATE: the row simply changed and nothing anywhere
  // recorded that it had.
  it("upsertListingMatch audits a downgrade that unlinks a cigar, and only a real one", async () => {
    const cigar = await seedCigar(`Downgrade Audit ${randomUUID().slice(0, 8)}`);
    const listingKey = `/shop/downgrade-audit-${randomUUID().slice(0, 8)}/`;
    const auto = await upsertListingMatch(pg.db, { vendorId, listingKey, cigarId: cigar, status: "auto", now: now() });

    await upsertListingMatch(pg.db, {
      vendorId,
      listingKey,
      cigarId: null,
      status: "unmatched",
      unmatchedReason: "market_refusal",
      runId: "crawl-run-downgrade",
      now: now(),
    });

    const audited = async () =>
      pg.db.select().from(auditLog).where(eq(auditLog.action, "listing_match.set_status"));
    const rows = await audited();
    const row = rows.find((a) => (a.before as { id?: string }).id === auto.id);
    expect(row).toBeTruthy();
    // The crawler's shape: no signed-in principal, no OAuth client, the run named.
    expect(row!.actor).toBe("import");
    expect(row!.userId).toBeNull();
    expect(row!.runId).toBe("crawl-run-downgrade");
    expect((row!.before as { cigarId: string | null }).cigarId).toBe(cigar);
    expect((row!.after as { cigarId: string | null }).cigarId).toBeNull();

    // ...and ONLY a real transition. A re-crawl rewrites every match row nightly —
    // 1,284 of them on prod — and an audit log that records "unchanged" that many
    // times a run is an audit log nobody reads.
    await upsertListingMatch(pg.db, {
      vendorId,
      listingKey,
      cigarId: null,
      status: "unmatched",
      unmatchedReason: "market_refusal",
      now: now(),
    });
    expect(await audited()).toHaveLength(rows.length);
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

  // Requests default to an instant BEFORE the fixture's `now()`, which is when
  // makeVendor dates a lane's prior enrich run. That ordering is load-bearing
  // since #185: a lane counts against a request only if it has already looked at
  // it OR started a succeeded enrich run since the request was created. Left at
  // the column default (real wall-clock now) every seeded lane would post-date
  // every request and count against nothing, so a fleet case would exhaust on one
  // vendor. The cases that are ABOUT #185 set the two instants explicitly.
  //
  // `createdAt` is also explicit where a case depends on drain ORDER (the queue is
  // drained oldest-first), so the assertion does not ride on insert timing.
  const REQUEST_AT = new Date("2026-08-26T00:00:00.000Z");

  async function seedRequest(cigarId: string, createdAt: Date = REQUEST_AT): Promise<string> {
    const rows = await pg.db
      .insert(enrichmentRequests)
      .values({ cigarId, status: "pending", createdAt })
      .returning({ id: enrichmentRequests.id });
    return rows[0]!.id;
  }

  const requestRow = async (id: string) =>
    (await pg.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.id, id)))[0]!;

  const ledgerRows = async (requestId: string) =>
    pg.db.select().from(enrichmentAttempts).where(eq(enrichmentAttempts.requestId, requestId));

  // A sitemap that enumerates products the requested cigar's OWN MARCA is on and
  // which are not it: the shape of a real "this vendor stocks the brand, not this
  // stick" drain, and the only shape that produces a `miss`.
  //
  // THE THREE SHELVES ARE THE POINT (#240). A `miss` is a page this run opened, so
  // a case about the attempt ledger has to give the ask something to open — an
  // enumeration that names the ask nowhere is `no_candidate` now and burns
  // nothing. Every miss-path case below therefore asks for a Red Anchor, a Padron
  // or an Oliva, and gets back the sibling this shop actually stocks. The prod
  // shape exactly: Fox carries the Red Anchor Admiral, and the owner's ask is the
  // Captain.
  const missRoutes = {
    [ROBOTS]: { body: loadFixture("robots.txt") },
    [SITEMAP]: { body: urlsetXml([PADRON_URL, RED_ANCHOR_URL, OLIVA_ROBUSTO_URL]) },
    [PADRON_URL]: { body: loadFixture("product-padron.html") },
    [RED_ANCHOR_URL]: { body: loadFixture("product-red-anchor-admiral.html") },
    [OLIVA_ROBUSTO_URL]: { body: loadFixture("product-oliva-robusto.html") },
  };

  // The same enumeration, asked about a cigar it names NOWHERE — no slug carries
  // one of the ask's identity keys or one of its marca's. No page is fetched and
  // no attempt is spent (#240).
  const noCandidateRoutes = missRoutes;

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

    const cigarId = await seedCigar("Red Anchor Zeta", "NC");
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
      .values({ canonicalName: `Red Anchor Untyped Prod Row ${randomUUID().slice(0, 8)}`, type: null, verification: "verified" })
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
      .values({ canonicalName: `Red Anchor Unknown Market Mystery ${randomUUID().slice(0, 8)}`, type: null, verification: "verified" })
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

    const cigarId = await seedCigar("Red Anchor Omega", "NC");
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

    // The Padron shelf, and not the Padron on it: the ask's marca ranks the 1964
    // Torpedo into the shortlist, so the page IS fetched, and `1926`/`6` are
    // required keys that page does not carry.
    const cigarId = await seedCigar("Padron 1926 No 6", "NC");
    const requestId = await seedRequest(cigarId);

    const run = await enrichRun(only, missRoutes);
    expect(run.stats.listingsParsed).toBe(1);
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 0, errored: 0 });
    const ledger = await ledgerRows(requestId);
    expect(ledger[0]!.attempts).toBe(1);
    expect(ledger[0]!.errors).toBe(0);
    expect(ledger[0]!.lastOutcome).toBe("miss");
  });

  // THE INVERSION #240 IS ABOUT, and the case that used to assert the opposite.
  // "No candidate scored" was read as evidence — the enumeration IS the vendor's
  // product list, so nothing in it resembling the cigar was itself the answer —
  // and that reading has one load-bearing premise: that a zero-length shortlist
  // means the shelf is empty rather than that our prefilter is broken. Prod
  // falsified it. Four nights, 58 attempts, 58 `miss`, zero cigars enriched, on
  // vendors whose offers walk auto-matched 992 listings over the same URLs.
  //
  // So a look that opened no page records `no_candidate`, burns neither counter,
  // and leaves the ask exactly where it found it. `exhausted` goes back to meaning
  // "a vendor was read and the cigar was not there".
  it("an ask the enumeration names nowhere fetches nothing and burns nothing", async () => {
    const only = await makeVendor("Scoreless", "NC");
    await arrange([only]);

    const cigarId = await seedCigar("Nonexistent Phantom Cigar Kappa", "NC");
    const requestId = await seedRequest(cigarId);

    const run = await enrichRun(only, noCandidateRoutes);
    // Not a look, and reported apart from one: `looked` is what burns budget.
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 0, matched: 0, errored: 0, noCandidate: 1 });
    // The robots and sitemap reads only — no product page was opened for it.
    expect(run.stats.listingsParsed).toBe(0);

    const ledger = await ledgerRows(requestId);
    expect(ledger[0]!.attempts).toBe(0);
    expect(ledger[0]!.errors).toBe(0);
    expect(ledger[0]!.lastOutcome).toBe("no_candidate");

    // And it never retires, however many nights run: the row stays open, at a cost
    // of zero fetches, until a lane can name it or a curator gives it an alias.
    await enrichRun(only, noCandidateRoutes);
    const third = await enrichRun(only, noCandidateRoutes);
    expect(third.stats.enrich).toMatchObject({ requests: 1, spent: 0, blocked: 0, noCandidate: 1 });
    const row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.resolvedAt).toBeNull();
    expect(row.attempts).toBe(0);
    expect((await ledgerRows(requestId))[0]!.attempts).toBe(0);
  });

  // The counter is absent-when-zero like its siblings, so an enrich run that named
  // every ask serialises into `crawl_runs.stats` exactly as it did before #240.
  it("does not write a noCandidate counter into a run that named every ask", async () => {
    const only = await makeVendor("Named Every Ask", "NC");
    await arrange([only]);
    await seedRequest(await seedCigar("Red Anchor Iota Prime", "NC"));

    const run = await enrichRun(only, missRoutes);
    expect(run.stats.enrich!.looked).toBe(1);
    expect(run.stats.enrich).not.toHaveProperty("noCandidate");
  });

  // #157 defect 2 cannot form. The drain no longer claims a request with
  // `status = 'in_progress'` — that was a request-level lock on a per-vendor
  // operation — so a run that dies mid-drain leaves the row exactly as it found it,
  // with no reaper anywhere in the system.
  it("a run that throws mid-drain strands nothing: the row stays pending, never in_progress", async () => {
    const only = await makeVendor("Crashing", "NC");
    await arrange([only]);

    const firstId = await seedRequest(await seedCigar("Red Anchor Mu", "NC"), new Date("2026-08-30T09:00:00.000Z"));
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

  // --- #170: the evidenced market, and write authority ------------------------
  //
  // #181 put coversMarketSql in the drain's open set, which closes #170 only for
  // cigars whose `type` is set. On prod 884 of 971 active cigars are untyped and
  // the predicate admits an unknown market BY DESIGN, so it is inert for 91% of
  // the catalogue. These cases are about the other 91%: the market EVIDENCED by
  // the links the crawler has already written.

  // A vendor's listing, standing as a market claim about the cigar it links to.
  const stock = (vendor: string, cigarId: string) =>
    upsertListingMatch(pg.db, {
      vendorId: vendor,
      listingKey: `/shop/stock-${randomUUID().slice(0, 8)}/`,
      cigarId,
      status: "auto",
      now: now(),
    });

  const photosFor = (cigarId: string) =>
    pg.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId));

  const matchesFor = (vendor: string) =>
    pg.db.select().from(listingMatches).where(eq(listingMatches.vendorId, vendor));

  // THE HEADLINE OF THE LANE, and the case #181 leaves open. 821 of prod's 884
  // untyped rows are stocked by Fox and nobody else; on `cigars.type` alone a CC
  // lane may select every one of them. Their links say otherwise.
  it("a CC lane does not select an untyped cigar that a single-market NC vendor already stocks", async () => {
    const nc = await makeVendor("Evidence NC Lane", "NC");
    const cc = await makeVendor("Evidence CC Lane", "CC");
    await arrange([nc, cc]);

    const cigarId = await seedCigar(`Untyped But Stocked ${randomUUID().slice(0, 8)}`, null);
    const requestId = await seedRequest(cigarId);
    await stock(nc, cigarId);

    const run = await enrichRun(cc, missRoutes);
    expect(run.stats.enrich!.requests).toBe(0);
    // Nothing spent: a refusal at the open set is not a look, so no ledger row and
    // no attempt counter moves. That is what keeps the rollup honest.
    expect(await ledgerRows(requestId)).toHaveLength(0);
    expect((await requestRow(requestId)).status).toBe("pending");
  });

  // The guard against OVER-tightening. Where there is genuinely no evidence the
  // liberal negative filter must survive intact, or an untyped, unstocked cigar
  // becomes unreachable by every lane and hangs forever.
  it("a CC lane still selects an untyped cigar that nobody stocks", async () => {
    const nc = await makeVendor("Unstocked NC Lane", "NC");
    const cc = await makeVendor("Unstocked CC Lane", "CC");
    await arrange([nc, cc]);

    const cigarId = await seedCigar(`Untyped And Unstocked ${randomUUID().slice(0, 8)}`, null);
    const requestId = await seedRequest(cigarId);

    const run = await enrichRun(cc, missRoutes);
    expect(run.stats.enrich!.requests).toBe(1);
    expect(await ledgerRows(requestId)).toHaveLength(1);
  });

  // `cigars.type` OVERRIDES linkage evidence, so a curator always has the last
  // word — the live `Petit Royales Romeo y Julieta` shape: a CC cigar the crawler
  // auto-linked to an NC vendor's Altadis listing. The wrong link is evidence for
  // NC; the recorded type is CC; CC wins and the NC lane is refused.
  it("cigars.type overrides linkage evidence: an NC lane is refused a CC cigar it already mis-linked", async () => {
    const nc = await makeVendor("Override NC Lane", "NC");
    await arrange([nc]);

    const cigarId = await seedCigar(`Petit Royales Shape ${randomUUID().slice(0, 8)}`, "CC");
    const requestId = await seedRequest(cigarId);
    await stock(nc, cigarId);

    const run = await enrichRun(nc, missRoutes);
    expect(run.stats.enrich!.requests).toBe(0);
    expect(await ledgerRows(requestId)).toHaveLength(0);
  });

  // SELF-EVIDENCING (option A). The photo guard must cost the working lane
  // nothing: a single-market vendor that links a cigar nobody else stocks becomes
  // its own sole evidence, so the market is known by the time the slot is filled.
  it("a lane that links a previously unlinked untyped cigar DOES fill the photo slot", async () => {
    const nc = await makeVendor("Self Evidence NC", "NC");
    await arrange([nc]);

    const cigarId = await seedCigar(OLIVA_NAME, null);
    const requestId = await seedRequest(cigarId);

    const run = await enrichRun(nc, hitRoutes, createMemoryPhotoStorage());
    expect(run.stats.enrich).toMatchObject({ requests: 1, matched: 1 });
    // Both refusal counters are absent-when-zero, like their run-level siblings, so
    // a run that refused nothing serialises byte-identically into crawl_runs.
    expect(run.stats.enrich!.skippedMarket).toBeUndefined();
    expect(run.stats.enrich!.photoRefused).toBeUndefined();
    expect(run.stats.photosCaptured).toBe(1);
    expect(run.stats.photosSkippedMarket).toBeUndefined();
    expect(await photosFor(cigarId)).toHaveLength(1);
    expect((await requestRow(requestId)).status).toBe("fulfilled");
  });

  // THE PHOTO SLOT IS UNIQUE(cigar_id), written onConflictDoNothing, and never
  // deleted by anything in the crawler: one global slot, first write wins,
  // forever. So on CONFLICTING evidence — the shape both live prod mis-links left
  // behind — a single-market vendor may still LINK (revisable, named, re-written
  // next crawl) and must NOT photograph.
  it("on conflicting evidence a lane writes the match and the offer but leaves the photo slot empty", async () => {
    const nc = await makeVendor("Conflict NC", "NC");
    const cc = await makeVendor("Conflict CC", "CC");
    const drainer = await makeVendor("Conflict Drainer CC", "CC");
    await arrange([nc, cc, drainer]);

    const cigarId = await seedCigar(OLIVA_NAME, null);
    const requestId = await seedRequest(cigarId);
    // Two single-market vendors of OPPOSITE markets already stock it, so the
    // evidence disagrees and resolves to unknown — the conservative answer.
    await stock(nc, cigarId);
    await stock(cc, cigarId);

    const run = await enrichRun(drainer, hitRoutes, createMemoryPhotoStorage());
    // Unknown market cannot rule the lane out, so it looks and it links...
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 0, photoRefused: 1 });
    expect(run.stats.offersWritten).toBe(1);
    expect((await matchesFor(drainer)).some((m) => m.cigarId === cigarId)).toBe(true);
    // ...and the one permanent slot stays empty, which is the point of the issue.
    expect(await photosFor(cigarId)).toHaveLength(0);
    expect(run.stats.photosCaptured).toBe(0);
    expect(run.stats.photosSkippedMarket).toBe(1);

    // AND THE ASK IS NOT FULFILLED (#209). It used to be: capturePhoto returned
    // void, the drain read "no throw" as a match, and the request went terminal
    // with the slot still empty — the photo was the whole point of the ask. This
    // assertion asserted `fulfilled`; it was asserting the defect.
    expect((await requestRow(requestId)).status).toBe("pending");

    // Nor does the refusal spend the vendor. `attempts` reaching its budget is what
    // licenses `exhausted` — "we read this catalogue and it is not there" — which
    // this vendor's own link disproves. The ledger records WHAT happened without
    // moving the ask toward a verdict that would be false.
    const ledger = await ledgerRows(requestId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ attempts: 0, errors: 0, lastOutcome: "photo_refused" });
  });

  // THE GUARD IS THE INSERT, NOT THE READ BEFORE IT. The authority used to be read
  // into JS and then trusted across a whole image download — seconds of third-party
  // HTTP — and the lane lock does not close that window, because locks are per
  // (vendor, mode): a `both` lane and a focused lane run concurrently BY DESIGN,
  // and a focused link is exactly what revokes a `both` lane's authority. So the
  // predicate is re-stated as the INSERT's own WHERE clause and evaluated in the
  // write's snapshot. `processPhoto` stands in for the window here, because it is
  // the one seam that is deterministically inside it.
  it("the photo slot guard is evaluated at the INSERT, not before the download", async () => {
    const nc = await makeVendor("Toctou NC", "NC");
    const cc = await makeVendor("Toctou CC", "CC");
    await arrange([nc, cc]);

    const cigarId = await seedCigar(OLIVA_NAME, null);
    const requestId = await seedRequest(cigarId);

    const racing: IngestDeps = {
      ...deps(createMockFetcher(hitRoutes), createMemoryPhotoStorage()),
      processPhoto: async (input, contentType) => {
        // Mid-download: a CC lane links the same cigar. The evidence now disagrees
        // and resolves to unknown, so this NC lane's authority is gone — after its
        // pre-flight read said it had one.
        await stock(cc, cigarId);
        return fakeProcessPhoto(input, contentType);
      },
    };
    const run = await runIngest(racing, { adapter: foxCigar, vendorId: nc, mode: "enrich" });

    // The pre-flight passed (the lane was self-evidencing when it read), so a guard
    // that only ran there would have written the slot.
    expect(await photosFor(cigarId)).toHaveLength(0);
    expect(run.stats.photosCaptured).toBe(0);
    expect(run.stats.photosSkippedMarket).toBe(1);
    expect((await requestRow(requestId)).status).toBe("pending");
  });

  // The same refusal in the other direction, so the guard is not accidentally
  // one-sided: an NC lane on the same conflicted row is refused the slot too.
  it("the photo refusal is symmetric: an NC lane is refused the slot on the same conflicted row", async () => {
    const nc = await makeVendor("Symmetric NC", "NC");
    const cc = await makeVendor("Symmetric CC", "CC");
    const drainer = await makeVendor("Symmetric Drainer NC", "NC");
    await arrange([nc, cc, drainer]);

    const cigarId = await seedCigar(OLIVA_NAME, null);
    await seedRequest(cigarId);
    await stock(nc, cigarId);
    await stock(cc, cigarId);

    const run = await enrichRun(drainer, hitRoutes, createMemoryPhotoStorage());
    expect(run.stats.enrich).toMatchObject({ looked: 1, matched: 0, photoRefused: 1 });
    expect(await photosFor(cigarId)).toHaveLength(0);
    expect(run.stats.photosSkippedMarket).toBe(1);
  });

  // THE LIVE `Romeo y Julieta Mini Red Aroma` SHAPE, replayed. A Fox-created
  // untyped row picked up a Cuban Lou's listing_match and offer on CL's single
  // seed run; only the already-taken photo slot kept a Habanos image out of an NC
  // cigar. Now the CC lane never reaches the row at all — the evidence Fox's own
  // link supplies rules it out one step earlier, so the slot is not the last line
  // of defence.
  it("a Fox photo is not at risk from a later Cuban Lou's drain: the row is never selected", async () => {
    const fox = await makeVendor("Red Aroma Fox", "NC");
    const cubanLous = await makeVendor("Red Aroma Cuban Lous", "CC");
    await arrange([fox, cubanLous]);

    const cigarId = await seedCigar(OLIVA_NAME, null);
    const requestId = await seedRequest(cigarId);

    const first = await enrichRun(fox, hitRoutes, createMemoryPhotoStorage());
    expect(first.stats.photosCaptured).toBe(1);
    const [photo] = await photosFor(cigarId);

    // Re-open the ask the way a curator would, then let the CC lane run.
    await pg.db
      .update(enrichmentRequests)
      .set({ status: "pending", resolvedAt: null })
      .where(eq(enrichmentRequests.id, requestId));
    const second = await enrichRun(cubanLous, hitRoutes, createMemoryPhotoStorage());
    expect(second.stats.enrich!.requests).toBe(0);

    const after = await photosFor(cigarId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(photo!.id);
    expect(after[0]!.vendorId).toBe(fox);
  });

  // THE SEED/OFFERS HALF, and the path BOTH live prod mis-links actually came
  // from — previously untested. A vendor walking its own sitemap must not
  // auto-link a catalogue cigar from the other market.
  //
  // Rewritten for matching v2: `findCatalogMatch` is gone and `resolveListing`
  // stands in its place, but the property under test is #170's and is unchanged —
  // the market guard REJECTS the candidate the resolver had already chosen, in
  // both directions, and never re-ranks. What v2 adds is the step BEFORE it: a
  // title resolves to nothing until a brand alias anchors it, so the arrangement
  // now registers the marca and links its leaf. And v1's single `{kind:'none'}`
  // has split in two — a title nothing recognises is `no_anchor`, while `none`
  // means the marca anchored and holds no matching leaf — so both halves of "a
  // genuine miss stays distinguishable from a refusal" are asserted below.
  it("resolveListing refuses a cross-market candidate, in both directions", async () => {
    const nc = await makeVendor("Seed Match NC", "NC");
    await arrange([nc]);

    // A marca of this case's own. v2 ranks WITHIN a brand, so a namesake seeded by
    // a neighbouring case would make the verdict `ambiguous` before the market
    // guard ever ran; a private brand keeps the scope at exactly one leaf.
    const marca = `Seedguard ${randomUUID().slice(0, 8)}`;
    const brandId = await seedBrand(marca);
    const name = `${marca} Subject`;
    const ncCigar = await seedCigar(name, null, { brandId });
    await stock(nc, ncCigar);

    // No focus supplied: unchanged behaviour, the candidate comes back. Every arm
    // now carries the parse as well — that is what a triage row persists (0027) —
    // so the shape is asserted rather than the whole object compared.
    const open = await resolveListing(pg.db, name);
    expect(open).toMatchObject({ kind: "match", hit: { cigarId: ncCigar, canonicalName: name } });
    expect(open.parse).toMatchObject({ brandId, brandName: marca });
    // An NC vendor may link an NC-evidenced row...
    expect(await resolveListing(pg.db, name, { vendorFocus: "NC" })).toMatchObject({
      kind: "match",
      hit: { cigarId: ncCigar },
    });
    // ...and a CC vendor may not. The refusal NAMES the candidate it refused: that
    // is what stops the seed path reading it as "nothing matched" and creating a
    // duplicate of this very row.
    expect(await resolveListing(pg.db, name, { vendorFocus: "CC" })).toMatchObject({
      kind: "refused",
      hit: { cigarId: ncCigar },
      market: "NC",
    });
    // A both-market vendor has no single market to conflict with.
    expect(await resolveListing(pg.db, name, { vendorFocus: "both" })).toMatchObject({
      kind: "match",
      hit: { cigarId: ncCigar },
    });

    // A genuine miss stays distinguishable from a refusal, in both of its v2
    // shapes. First: a title no alias anchors. This is the arm that used to mint —
    // it names no cigar we can reason about at all, so it names no cigar to
    // create either.
    const unanchored = await resolveListing(pg.db, `No Such Cigar ${randomUUID()}`, { vendorFocus: "CC" });
    expect(unanchored.kind).toBe("no_anchor");
    expect(unanchored.parse.brandId).toBeNull();
    // Second: the marca anchored and none of its leaves fits. THIS is the only arm
    // seed mode mints from, and the difference is the whole point — we know whose
    // cigar it is, we looked under that name, and it is genuinely not there yet.
    const unknownLeaf = await resolveListing(pg.db, `${marca} Zeppelin Quatrain Nine Hundred Twelve`, {
      vendorFocus: "CC",
    });
    expect(unknownLeaf.kind).toBe("none");
    expect(unknownLeaf.parse.brandId).toBe(brandId);
  });

  // The same guard through the real seed path. This used to assert the OPPOSITE —
  // that a refusal fell through to createCigarFromListing, on the reasoning that a
  // listing contradicting its best match is a different cigar. That holds only when
  // the market evidence is right, and #170's own evidence was wrong often enough to
  // sink it (Cuban Lou's recorded 'CC' while stocking Perdomo). When a refusal is
  // false, creating turns a recoverable bad link into a permanent duplicate. So the
  // refusal now leaves the listing UNMATCHED for triage and creates nothing.
  it("a CC seed run leaves a refused listing unmatched instead of minting a duplicate", async () => {
    const nc = await makeVendor("Seed Walk NC", "NC");
    const cc = await makeVendor("Seed Walk CC", "CC");
    await arrange([nc, cc]);

    // The leaf the CC walk must find and be refused. `brandId` puts it in the
    // Oliva scope explicitly, and `soleActiveLeaf` retires the namesakes the
    // enrich cases above seeded — otherwise v2 stops at `ambiguous` and the market
    // guard, which is what this case is about, never runs.
    const ncCigar = await seedCigar(OLIVA_NAME, null, { brandId: olivaBrandId });
    await soleActiveLeaf(OLIVA_NAME, ncCigar);
    await stock(nc, ncCigar);
    const before = (await pg.db.select({ id: cigars.id }).from(cigars)).length;

    const run = await runIngest(deps(createMockFetcher(hitRoutes), createMemoryPhotoStorage()), {
      adapter: foxCigar,
      vendorId: cc,
      mode: "seed",
    });

    // Nothing created for the refused listing, and the refusal is counted.
    expect(run.stats.cigarsCreated).toBe(0);
    expect(run.stats.linksRefusedMarket).toBe(1);
    // And it really was refused on MARKET grounds — not quietly declined one step
    // earlier by the anchor or by an ambiguity, which would make every assertion
    // below pass without the guard ever firing.
    expect(run.stats.linksNoAnchor).toBeUndefined();
    expect(run.stats.linksAmbiguous).toBeUndefined();
    expect((await pg.db.select({ id: cigars.id }).from(cigars)).length).toBe(before);

    // The listing is recorded, unmatched and pointing at no cigar — the triage
    // queue's shape, so a curator can resolve what the crawler would not guess —
    // and it carries the parse that got as far as naming the marca (0027).
    const ccMatches = await matchesFor(cc);
    expect(ccMatches).toHaveLength(1);
    expect(ccMatches[0]).toMatchObject({ cigarId: null, status: "unmatched", unmatchedReason: "market_refusal" });
    expect(ccMatches[0]!.suggestedParse).toMatchObject({ brandId: olivaBrandId, brandName: "Oliva" });

    // The NC row is untouched: no CC listing_match points at it, and its photo
    // slot is still free.
    expect(ccMatches.every((m) => m.cigarId !== ncCigar)).toBe(true);
    expect(await photosFor(ncCigar)).toHaveLength(0);
  });

  // ...AND THE TRIAGE QUEUE ACTUALLY SHOWS IT. The claim above — "the triage queue
  // a curator already works" — was made by the code comments, the CLI summary and
  // the PR body, and was false in all three: `matchTriagePage` read `status='auto'`
  // only, so every refusal landed somewhere nobody could see. Asserted end to end
  // through the real curation read rather than against the row, because the row was
  // never the thing in doubt.
  it("a refused seed listing is visible in match_triage, marked as a market refusal", async () => {
    const nc = await makeVendor("Triage Walk NC", "NC");
    const cc = await makeVendor("Triage Walk CC", "CC");
    await arrange([nc, cc]);

    // Same arrangement as the case above, and for the same reason: the guard only
    // fires once the resolver has settled on a single leaf of the anchored marca.
    const ncCigar = await seedCigar(OLIVA_NAME, null, { brandId: olivaBrandId });
    await soleActiveLeaf(OLIVA_NAME, ncCigar);
    await stock(nc, ncCigar);

    const walk = await runIngest(deps(createMockFetcher(hitRoutes), createMemoryPhotoStorage()), {
      adapter: foxCigar,
      vendorId: cc,
      mode: "seed",
    });
    expect(walk.stats.linksRefusedMarket).toBe(1);
    const refused = (await matchesFor(cc))[0]!;

    const curator = { userId: randomUUID(), role: "admin" as const };
    let found;
    let cursor: string | null = null;
    for (let i = 0; i < 500 && !found; i++) {
      const page = await curationWorklist({ db: pg.db, now }, curator, {
        kind: "match_triage",
        limit: 200,
        cursor,
      });
      found = page.matches!.find((m) => m.matchId === refused.id);
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(found).toBeTruthy();
    // Marked distinguishably from an auto proposal: there is no cigar to confirm,
    // and the reason says a candidate WAS found and declined — which is the signal
    // that this vendor's recorded focus may be the thing that is wrong.
    expect(found).toMatchObject({ status: "unmatched", reason: "market_refusal", cigar: null });
  });

  // --- the `both`-focus vendor: evidence, and the seal that used to close ------
  //
  // Cuban Lou's is recorded `focus='both'` from migration 0025, because measured
  // against its live catalogue it sells Perdomo, Gurkha, CAO, Rocky Patel and
  // Dominican/Nicaraguan bundles alongside genuine Habanos. These three cases pin
  // what that value has to mean, since the whole correctness of #170 now rests on
  // it rather than on the algorithm.

  // THE SELF-SEALING SCENARIO, and the reason the vendor row had to change rather
  // than the predicate. While Cuban Lou's said 'CC', its listing on a Perdomo made
  // that row evidenced-CC; coversMarketSql then dropped Fox — the ONLY live enrich
  // lane — from the row's fleet, so the one vendor that could have contradicted the
  // claim could never be asked, and the wrong inference was permanent. As 'both'
  // the shop asserts no market, the row stays unknown, and Fox keeps its reach.
  it("a both-market vendor stocking a cigar is not evidence: an NC lane can still be asked (the Cuban Lou's sells Perdomo case)", async () => {
    const cubanLous = await makeVendor("Perdomo Case Cuban Lous", "both");
    const fox = await makeVendor("Perdomo Case Fox", "NC");
    await arrange([cubanLous, fox]);

    // A Nicaraguan cigar, untyped, that only the both-market shop stocks — the
    // shape of all 57 such rows in prod.
    const cigarId = await seedCigar(`Perdomo Artesanal Sumatra ${randomUUID().slice(0, 8)}`, null);
    const requestId = await seedRequest(cigarId);
    await stock(cubanLous, cigarId);

    // Had the shop stayed 'CC' this would be 0: the row would read as evidenced-CC
    // and the NC lane would be filtered out of its own open set.
    const run = await enrichRun(fox, missRoutes);
    expect(run.stats.enrich!.requests).toBe(1);
    expect(await ledgerRows(requestId)).toHaveLength(1);
  });

  // THE UN-SEAL IS STRUCTURAL, NOT CIRCUMSTANTIAL. Correcting Cuban Lou's removes
  // today's seal; it does not stop the next one. `approved-import` used to stamp
  // `focus='CC'` on every vendor it added — removed in #210, it mints NULL now —
  // so the next approved Cuban shop would have re-formed the seal the day it
  // landed. That path is narrower now, not closed: curation and evidence still set
  // focus, and a truly CC-focused shop is a row the registry must be able to hold.
  // "No CC-focus vendor exists right now" is a fact about the registry, not a
  // property of the design. Evidence is therefore
  // read only from CRAWL-ENABLED vendors: a lane that cannot be asked cannot be
  // evidence, and the disable lever ADR-006 already promises finally does what the
  // ADR says it does. Without the `crawl_enabled` clause in evidencedMarketSql the
  // second assertion is 0 — the shop is out of the fleet and its evidence still
  // holds the row shut.
  it("disabling a mis-focused shop frees the rows its links sealed", async () => {
    const misfocused = await makeVendor("Unseal Import CC", "CC");
    const fox = await makeVendor("Unseal Fox", "NC");
    await arrange([misfocused, fox]);

    const cigarId = await seedCigar(`Unseal Perdomo ${randomUUID().slice(0, 8)}`, null);
    await seedRequest(cigarId);
    await stock(misfocused, cigarId);

    // Sealed: the CC shop's link is the only evidence, the row reads evidenced-CC,
    // and the NC lane is filtered out of its own open set.
    expect((await enrichRun(fox, missRoutes)).stats.enrich!.requests).toBe(0);

    // The lever, pulled. Nothing else changes — no migration, no re-crawl, no
    // touching the sealed rows.
    await setFleet([fox]);
    expect((await enrichRun(fox, missRoutes)).stats.enrich!.requests).toBe(1);
  });

  // WRITE AUTHORITY FOR A VENDOR WITH NO MARKET. `mayWriteCatalogPhoto('both', …)`
  // used to return true unconditionally, which made `both` the most privileged
  // focus a vendor could hold: it could take the one permanent slot on any cigar,
  // including one a focused vendor already stocks. It may not pre-empt that vendor.
  it("a both-market lane does not pre-empt a focused vendor's photo slot", async () => {
    const fox = await makeVendor("Preempt Fox", "NC");
    const cubanLous = await makeVendor("Preempt Cuban Lous", "both");
    await arrange([fox, cubanLous]);

    const cigarId = await seedCigar(OLIVA_NAME, null);
    const requestId = await seedRequest(cigarId);
    await stock(fox, cigarId);

    const run = await enrichRun(cubanLous, hitRoutes, createMemoryPhotoStorage());
    // 'both' covers every market, so the lane is eligible, looks, and LINKS — the
    // link is named, revisable and re-written next crawl.
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 0, photoRefused: 1 });
    expect((await matchesFor(cubanLous)).some((m) => m.cigarId === cigarId)).toBe(true);
    // ...and the permanent slot is left for the vendor whose focus covers the row.
    expect(await photosFor(cigarId)).toHaveLength(0);
    expect(run.stats.photosCaptured).toBe(0);
    expect(run.stats.photosSkippedMarket).toBe(1);

    // The ask stays OPEN for the vendor that may actually write the slot (#209).
    // This is the case that mattered most: the refusal here is structural — Fox
    // stocks the row and always will — so marking the ask fulfilled retired it
    // permanently with an empty slot and no vendor left to ask.
    expect((await requestRow(requestId)).status).toBe("pending");
    const ledger = await ledgerRows(requestId);
    expect(ledger[0]).toMatchObject({ attempts: 0, lastOutcome: "photo_refused" });

    // And the ask says WHO is holding it open. Without this the row is an
    // `already_queued` indistinguishable from one a lane has simply not reached.
    const coverage = await enrichmentCoverageForCigar(pg.db, cigarId, null);
    expect(coverage.photoRefused.map((v) => v.vendorId)).toEqual([cubanLous]);
  });

  // The other half, or the guard would just be "a `both` vendor never photographs
  // anything" — which would strand the 57 rows only this shop carries with an empty
  // slot forever. With nothing focused to pre-empt, its own product page wins.
  it("a both-market lane DOES fill a slot no focused vendor competes for", async () => {
    const cubanLous = await makeVendor("Sole Source Cuban Lous", "both");
    await arrange([cubanLous]);

    const cigarId = await seedCigar(OLIVA_NAME, null);
    await seedRequest(cigarId);

    const run = await enrichRun(cubanLous, hitRoutes, createMemoryPhotoStorage());
    expect(run.stats.photosCaptured).toBe(1);
    expect(run.stats.photosSkippedMarket).toBeUndefined();
    expect(await photosFor(cigarId)).toHaveLength(1);
  });

  // The 291 `decided_by='agent'` rows in prod are the highest-value data in
  // `listing_matches` and the market guard must not be able to touch them. It only
  // ever refuses a write, and upsertListingMatch's protection is unchanged — but
  // #170 changes findCatalogMatch's signature and therefore this exact path, so
  // the property is asserted through the real seed walk rather than assumed.
  it("an agent decision survives a focus-aware seed walk untouched", async () => {
    const nc = await makeVendor("Agent Guard NC", "NC");
    // A second NC lane stocks the cigar, so its evidenced market is KNOWN and the
    // photo guard would PERMIT the capture. Without it the guard refuses on its own
    // and the photo assertion below passes whatever the capture is aimed at —
    // vacuously, which is exactly how this defect stayed invisible.
    const stockist = await makeVendor("Agent Guard Stockist NC", "NC");
    await arrange([nc, stockist]);

    // The resolver must genuinely REACH this cigar, or the photo assertion below
    // is vacuous for a second reason: under matching v2 the Padron scope also
    // holds the row the first case minted, and two rows of one marca scoring
    // identically is `ambiguous` — no candidate, no capture, and nothing proven
    // about the upsert guard. So this leaf is put in the brand's scope explicitly
    // and its namesake retired.
    const cigarId = await seedCigar(PADRON_NAME, null, { brandId: padronBrandId });
    await soleActiveLeaf(PADRON_NAME, cigarId);
    await stock(stockist, cigarId);
    const decided = await upsertListingMatch(pg.db, {
      vendorId: nc,
      listingKey: "/shop/padron-1964-anniversary-maduro-torpedo/",
      cigarId,
      status: "auto",
      now: now(),
    });
    await pg.db
      .update(listingMatches)
      .set({ status: "unmatched", cigarId: null, decidedBy: "agent" })
      .where(eq(listingMatches.id, decided.id));

    const routes = {
      [ROBOTS]: { body: loadFixture("robots.txt") },
      [SITEMAP]: { body: urlsetXml([PADRON_URL]) },
      [PADRON_URL]: { body: loadFixture("product-padron.html") },
      [PADRON_IMG]: { binary: Buffer.from("padron-image"), contentType: "image/jpeg" },
    };
    const run = await runIngest(deps(createMockFetcher(routes), createMemoryPhotoStorage()), {
      adapter: foxCigar,
      vendorId: nc,
      mode: "offers",
    });

    // The resolver did settle on a leaf — it neither failed to anchor nor gave up
    // on an ambiguity — so what follows is the upsert guard's doing and nothing
    // else's.
    expect(run.stats.linksNoAnchor).toBeUndefined();
    expect(run.stats.linksAmbiguous).toBeUndefined();

    const after = (await pg.db.select().from(listingMatches).where(eq(listingMatches.id, decided.id)))[0]!;
    expect(after).toMatchObject({ status: "unmatched", cigarId: null, decidedBy: "agent" });

    // AND THE REJECTION HOLDS FOR THE PHOTO TOO. The link was correctly declined
    // and the capture fired anyway: ingestListing returned the cigar the resolver
    // had just picked rather than the one the committed row names, so every crawl
    // re-tempted the one permanent artifact against a cigar an agent had rejected —
    // 591 rows on prod, nightly. Reading `match.cigarId` makes a declined upsert
    // yield null, and null captures nothing.
    expect(run.stats.photosCaptured).toBe(0);
    expect(await photosFor(cigarId)).toHaveLength(0);
  });

  // THE SAME GUARD, ONE PATH OVER — and the drain is the path where it pays
  // twice. `matchesAuto` used to increment on the resolver's intent rather than
  // on the committed row, so every drain over one of prod's 591 human-owned rows
  // reported a link that was never written; and the loop then walked on to the
  // photo, aiming the one permanent artifact at the cigar the human had rejected.
  // The committed row is the authority for both, so a declined upsert scores a
  // miss and ends the look before the capture.
  it("a drain over a human-owned row scores no match and captures no photo, but still prices the listing", async () => {
    const lane = await makeVendor("Declined Drain NC", "NC");
    await arrange([lane]);

    const wanted = await seedCigar(OLIVA_NAME, "NC");
    const requestId = await seedRequest(wanted);
    // Where a human actually pointed this listing. The cigar is real and typed, so
    // the photo guard would PERMIT a capture aimed at `wanted` — without that the
    // photo assertion below would pass on the guard's account rather than on the
    // committed row's, which is how this defect stayed invisible next door.
    const elsewhere = await seedCigar(`Curator Choice ${randomUUID().slice(0, 8)}`, "NC");
    const decided = await upsertListingMatch(pg.db, {
      vendorId: lane,
      listingKey: "/shop/oliva-serie-v-melanio-torpedo/",
      cigarId: elsewhere,
      status: "auto",
      now: now(),
    });
    await pg.db
      .update(listingMatches)
      .set({ status: "confirmed", decidedBy: "agent" })
      .where(eq(listingMatches.id, decided.id));

    const run = await enrichRun(lane, hitRoutes, createMemoryPhotoStorage());

    // A COMPLETED LOOK THAT CONCLUDED NOTHING. The row says something other than
    // "linked to this cigar", and no arithmetic on our side changes that.
    expect(run.stats.matchesAuto).toBe(0);
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 0, errored: 0 });
    expect((await requestRow(requestId)).status).toBe("pending");
    expect(await ledgerRows(requestId)).toMatchObject([{ attempts: 1, errors: 0, lastOutcome: "miss" }]);

    const after = (await pg.db.select().from(listingMatches).where(eq(listingMatches.id, decided.id)))[0]!;
    expect(after).toMatchObject({ cigarId: elsewhere, status: "confirmed", decidedBy: "agent" });

    // The slot the ask exists to fill stays empty rather than being filled with
    // the wrong cigar's picture, which is unrecoverable: one slot, first write
    // wins, and nothing in the crawler ever deletes one.
    expect(run.stats.photosCaptured).toBe(0);
    expect(await photosFor(wanted)).toHaveLength(0);

    // The offer is still written. It is a fact about the LISTING and hangs off
    // `match.id`, which exists whoever owns the verdict — discarding it would cost
    // the human's own row the price history it depends on.
    expect(run.stats.offersWritten).toBe(1);
    expect(await pg.db.select().from(offers).where(eq(offers.listingMatchId, decided.id))).toHaveLength(1);

    // THE CONTROL, and without it every zero above is unfalsifiable: a drain that
    // never reached the write at all — a candidate that failed to rank, a market
    // guard refusing the slot on its own account — produces exactly the same
    // numbers. So hand the SAME listing back to the crawler unclaimed. Everything
    // fires, which means the zeros above were the committed row's doing and
    // nothing else's.
    //
    // `cigarId` is released along with the ownership because #233 added a second,
    // independent reason this listing would be skipped: the drain will not repoint
    // a crawler link that already resolves to a DIFFERENT catalog row. Leaving it
    // aimed at `elsewhere` would make the control pass its zeros on that guard's
    // account instead of the human's — the very confusion this control exists to
    // rule out.
    await pg.db
      .update(listingMatches)
      .set({ status: "unmatched", decidedBy: "crawler", cigarId: null })
      .where(eq(listingMatches.id, decided.id));

    const control = await enrichRun(lane, hitRoutes, createMemoryPhotoStorage());
    expect(control.stats.matchesAuto).toBe(1);
    expect(control.stats.photosCaptured).toBe(1);
    expect(await photosFor(wanted)).toHaveLength(1);
    expect((await requestRow(requestId)).status).toBe("fulfilled");
  });

  // --- #233: the drain admits on STRUCTURE, and trigram only ranks -------------
  //
  // The drain's admission rule used to be `similarity(canonical_name, title) >
  // 0.55` — v1's rule, left standing here after Wave 2 rewrote the seed and offers
  // paths, and the last place in the crawler where a threshold decided identity.
  // ADR-012 predicted how it fails and prod's own drain then recorded it. These
  // cases are that recording, replayed: the flagship miss now matches, and each of
  // the three misses beside it stays a miss for a reason that is stated rather
  // than numeric.

  const LIGA_VIVA_URL = "https://foxcigar.com/shop/cigars/liga-privada-no-9-corona-viva-2/";
  const LIGA_DOBLE_URL = "https://foxcigar.com/shop/cigars/liga-privada-no-9-corona-doble-2/";
  const LIGA_VIVA_IMG = "https://foxcigar.com/wp-content/uploads/liga-privada-no-9-corona-viva.jpg";
  const LIGA_DOBLE_IMG = "https://foxcigar.com/wp-content/uploads/liga-privada-no-9-corona-doble.jpg";
  const LIGA_BLEND_ASK = "Drew Estate Liga Privada No. 9";

  // Fox's actual Liga shelf: two vitolas of one blend, no listing named after the
  // blend itself. That absence IS the case — a blend-level ask has nothing to be
  // equal to, only things to be covered by.
  const ligaRoutes = {
    [ROBOTS]: { body: loadFixture("robots.txt") },
    [SITEMAP]: { body: urlsetXml([LIGA_VIVA_URL, LIGA_DOBLE_URL]) },
    [LIGA_VIVA_URL]: { body: loadFixture("product-liga-corona-viva.html") },
    [LIGA_DOBLE_URL]: { body: loadFixture("product-liga-corona-doble.html") },
    [LIGA_VIVA_IMG]: { binary: Buffer.from("liga-viva-image"), contentType: "image/jpeg" },
    [LIGA_DOBLE_IMG]: { binary: Buffer.from("liga-doble-image"), contentType: "image/jpeg" },
  };

  const matchFor = async (vendor: string, listingKey: string) =>
    (
      await pg.db
        .select()
        .from(listingMatches)
        .where(and(eq(listingMatches.vendorId, vendor), eq(listingMatches.listingKey, listingKey)))
    )[0];

  // THE MISS PROD RECORDED ON 2026-08-31, now a match. The ask is blend-level
  // (`Drew Estate Liga Privada No. 9`) and every Fox title is vitola-level, so
  // identity-equality says no and the string said no too — the sub-assertion below
  // measures the trigram between the two names against the floor that used to
  // decide this, so the premise of the whole issue is checked rather than
  // asserted in a comment. A blend-level ask wants a photo of ANY of its vitolas:
  // one catalogue photo per row is what an enrichment request exists to fill
  // (ADR-007), and a Corona Viva IS a picture of Liga Privada No. 9.
  it("a blend-level ask is fulfilled by a vitola listing, with the photo the ask exists for", async () => {
    const lane = await makeVendor("Liga Blend Lane", "NC");
    await arrange([lane]);

    const askId = await seedCigar(LIGA_BLEND_ASK, "NC", { brand: "Drew Estate" });
    const requestId = await seedRequest(askId);

    // The premise, in the database that used to enforce it: under the old
    // hardcoded floor this pair was refused on the strength of this number.
    const scored = await pg.db.execute(
      sql`SELECT similarity(${LIGA_BLEND_ASK}, ${"Liga Privada No. 9 Corona Viva"}) AS sim`,
    );
    expect(Number((scored.rows as unknown as { sim: number }[])[0]!.sim)).toBeLessThan(0.55);

    const run = await enrichRun(lane, ligaRoutes, createMemoryPhotoStorage());
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 1, errored: 0 });
    expect(run.stats.matchesAuto).toBe(1);
    expect(run.stats.offersWritten).toBe(1);

    // THE ARTIFACT, not just the link. A drain that links and does not photograph
    // has not answered the ask (#209).
    expect(run.stats.photosCaptured).toBe(1);
    expect(await photosFor(askId)).toHaveLength(1);

    const row = await requestRow(requestId);
    expect(row.status).toBe("fulfilled");
    expect(row.resolvedAt).not.toBeNull();
    expect(await ledgerRows(requestId)).toMatchObject([{ attempts: 1, errors: 0, lastOutcome: "match" }]);
    // Exactly one of the two vitolas is linked — the drain acts on the best
    // candidate, it does not sweep the shelf. WHICH one is trigram's remaining
    // job: it no longer admits anything, it only orders a shortlist structure has
    // already admitted, and on this shelf it puts the Corona Doble first. The next
    // case takes that listing away and watches the look fall through to the other.
    expect((await matchesFor(lane)).filter((m) => m.cigarId === askId)).toHaveLength(1);
    expect(await matchFor(lane, pathOf(LIGA_DOBLE_URL))).toMatchObject({ cigarId: askId, status: "auto" });
    expect(await matchFor(lane, pathOf(LIGA_VIVA_URL))).toBeUndefined();
  });

  // THE GUARD THAT KEEPS THE FIX FROM BECOMING A REGRESSION. Coverage is
  // deliberately one-way, so `Liga Privada No. 9 Corona Viva` covers the
  // blend-level ask — but if a seed walk has already linked that listing to the
  // Corona Viva ROW, that row is the more specific and therefore better answer for
  // it. Letting the drain win the tug-of-war would migrate the link, and the offer
  // history hanging off it, from the vitola row onto the blend row; and because
  // the title anchors no brand the seed walk would read `no_anchor` next crawl,
  // annotate, and leave the theft standing. A blend-level ask is not positive
  // evidence against a vitola-level link.
  it("the drain never repoints a listing another catalog row already holds", async () => {
    const lane = await makeVendor("Liga Theft Lane", "NC");
    await arrange([lane]);

    const askId = await seedCigar(LIGA_BLEND_ASK, "NC", { brand: "Drew Estate" });
    const requestId = await seedRequest(askId);

    // The vitola row, and the crawler-owned link a seed walk left pointing at it.
    // Crawler-owned and not confirmed, so `upsertListingMatch` would happily
    // rewrite it — nothing but the drain's own refusal protects this row.
    //
    // It is deliberately the CORONA DOBLE that is claimed: the case above pins it
    // as the listing this drain ranks FIRST, so the guard is what makes the look
    // pass over its own best candidate. Claiming the other one would prove nothing
    // — the drain would have taken the Doble anyway, and every assertion below
    // would pass with the guard deleted.
    const vitolaId = await seedCigar("Liga Privada No. 9 Corona Doble", "NC", { brand: "Drew Estate" });
    const claimed = await upsertListingMatch(pg.db, {
      vendorId: lane,
      listingKey: pathOf(LIGA_DOBLE_URL),
      cigarId: vitolaId,
      status: "auto",
      now: now(),
    });

    const run = await enrichRun(lane, ligaRoutes, createMemoryPhotoStorage());
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 1, errored: 0 });

    // The claimed listing still names the vitola row, at the same match id.
    const after = (await pg.db.select().from(listingMatches).where(eq(listingMatches.id, claimed.id)))[0]!;
    expect(after).toMatchObject({ cigarId: vitolaId, status: "auto", decidedBy: "crawler" });

    // ...and the look did not stop there. Skipping a claimed candidate is not a
    // verdict about the catalogue, it is a move to the next one — so the UNCLAIMED
    // sibling answers the ask, and the ask is answered.
    expect(await matchFor(lane, pathOf(LIGA_VIVA_URL))).toMatchObject({ cigarId: askId, status: "auto" });
    expect((await requestRow(requestId)).status).toBe("fulfilled");
    expect(await photosFor(askId)).toHaveLength(1);
    // The vitola row's own slot is untouched: this drain was never about it.
    expect(await photosFor(vitolaId)).toHaveLength(0);
  });

  // ...AND THE SAME GUARD IS CHECKED AGAIN INSIDE THE WRITE, because the first
  // check cannot be authoritative. Admission and write are separated by the rest
  // of the candidate sweep — seconds of polite HTTP — and a seed walk on another
  // lane can link a listing to its own best leaf inside that window. The
  // admission check is an optimization; `priorAtWrite` is the guarantee.
  //
  // THE RACE IS STAGED, NOT SIMULATED. The sitemap order is reversed so the
  // candidate that WINS ranking (the Corona Doble — pinned two cases above, where
  // trigram puts it top) is fetched FIRST and the Corona Viva is fetched LAST. The
  // claim is then planted from inside the Viva fetch, which is strictly after the
  // Doble cleared admission unclaimed and strictly before the transaction opens.
  // Planting it during the winner's own fetch would prove nothing: that page is
  // read at the top of the loop, before its own `existingCrawlerLink` call, so the
  // admission check would catch it and the write site would never be exercised.
  //
  // A claim that lands in this window is NOT a skip-and-continue. The look has
  // already chosen its candidate, so `declined` ends it — the ask goes unanswered
  // this run rather than falling through to a sibling — and that is the correct
  // conservative answer: the drain re-reads the world and finds it changed.
  it("a listing claimed between admission and the write is declined, not stolen", async () => {
    const lane = await makeVendor("Liga Race Lane", "NC");
    await arrange([lane]);

    const askId = await seedCigar(LIGA_BLEND_ASK, "NC", { brand: "Drew Estate" });
    const requestId = await seedRequest(askId);
    const vitolaId = await seedCigar("Liga Privada No. 9 Corona Doble", "NC", { brand: "Drew Estate" });

    // Reversed enumeration: the winner first, so the loser's fetch is the last
    // event before the write.
    const racedRoutes = { ...ligaRoutes, [SITEMAP]: { body: urlsetXml([LIGA_DOBLE_URL, LIGA_VIVA_URL]) } };

    const base = createMockFetcher(racedRoutes);
    let planted = false;
    const racing: MockFetcher = {
      requested: base.requested,
      get pagesFetched() {
        return base.pagesFetched;
      },
      fetchText: async (url: string) => {
        const response = await base.fetchText(url);
        if (!planted && url === LIGA_VIVA_URL) {
          planted = true;
          // The competing seed walk, landing mid-sweep: it links the Doble
          // listing — the one this drain is about to write — to the vitola row.
          // Crawler-owned and unconfirmed, so `upsertListingMatch` would happily
          // rewrite it and nothing but `priorAtWrite` says otherwise.
          await upsertListingMatch(pg.db, {
            vendorId: lane,
            listingKey: pathOf(LIGA_DOBLE_URL),
            cigarId: vitolaId,
            status: "auto",
            now: now(),
          });
        }
        return response;
      },
      fetchBinary: base.fetchBinary,
    };

    const run = await runIngest(deps(racing, createMemoryPhotoStorage()), {
      adapter: foxCigar,
      vendorId: lane,
      mode: "enrich",
    });

    // The claim was planted after the Doble had already been admitted — i.e. the
    // race really was staged, and the admission check really did see it free.
    expect(planted).toBe(true);

    // THE LINK IS NOT REPOINTED. The Doble listing still names the vitola row.
    expect(await matchFor(lane, pathOf(LIGA_DOBLE_URL))).toMatchObject({
      cigarId: vitolaId,
      status: "auto",
      decidedBy: "crawler",
    });

    // THE LOOK IS A MISS, and nothing about the ask moved. `declined` ends the
    // look, so the Viva is not linked as a consolation prize either.
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 0, errored: 0 });
    expect(run.stats.matchesAuto).toBe(0);
    expect(await matchFor(lane, pathOf(LIGA_VIVA_URL))).toBeUndefined();
    expect((await matchesFor(lane)).filter((m) => m.cigarId === askId)).toHaveLength(0);

    // The request survives to be retried, and the ask's one photo slot is empty.
    expect((await requestRow(requestId)).status).toBe("pending");
    expect(run.stats.photosCaptured).toBe(0);
    expect(await photosFor(askId)).toHaveLength(0);
    expect(await ledgerRows(requestId)).toMatchObject([{ attempts: 1, errors: 0, lastOutcome: "miss" }]);
  });

  // THE AUTHORITY GATE STILL BITES FIRST (#192/#170). A looser matcher must not
  // widen what a lane may be SHOWN — the market filter is evaluated in the open
  // set, one step ahead of any comparison, so a CC ask is never offered to an NC
  // lane whatever its title would have covered.
  it("a CC ask is never offered to an NC lane, however well the listing covers it", async () => {
    const lane = await makeVendor("Liga Market Lane", "NC");
    await arrange([lane]);

    const askId = await seedCigar(LIGA_BLEND_ASK, "CC", { brand: "Drew Estate" });
    const requestId = await seedRequest(askId);

    const run = await enrichRun(lane, ligaRoutes, createMemoryPhotoStorage());
    expect(run.stats.enrich!.requests).toBe(0);
    expect(await ledgerRows(requestId)).toHaveLength(0);
    expect((await requestRow(requestId)).status).toBe("pending");
    expect(await photosFor(askId)).toHaveLength(0);
  });

  const TATUAJE_URL = "https://foxcigar.com/shop/cigars/tatuaje-skinny-monsters-tiff/";
  const TATUAJE_IMG = "https://foxcigar.com/wp-content/uploads/tatuaje-skinny-monsters-tiff.jpg";
  const tatuajeRoutes = {
    [ROBOTS]: { body: loadFixture("robots.txt") },
    [SITEMAP]: { body: urlsetXml([TATUAJE_URL]) },
    [TATUAJE_URL]: { body: loadFixture("product-tatuaje-tiff.html") },
    [TATUAJE_IMG]: { binary: Buffer.from("tatuaje-image"), contentType: "image/jpeg" },
  };

  // A MISS IS THE CORRECT VERDICT HERE, and pinning it is the other half of
  // #233. Fox demonstrably stocks Monster-series listings and demonstrably does
  // not stock The Bride, so the ask must come back empty — the failure mode a
  // looser rule invites is a sibling monster's picture landing in The Bride's one
  // permanent photo slot, which nothing in the crawler can ever undo.
  it("a sibling release under the same line does not cover the ask, and takes no photo slot", async () => {
    const lane = await makeVendor("Monster Lane", "NC");
    await arrange([lane]);

    const askId = await seedCigar("Tatuaje Monster Series The Bride", "NC", {
      brand: "Tatuaje",
      line: "Monster Series",
    });
    const requestId = await seedRequest(askId);

    const run = await enrichRun(lane, tatuajeRoutes, createMemoryPhotoStorage());
    // The candidate ranked and was READ — this is the matcher's verdict on a
    // parsed product, not a prefilter's silence, which is what makes it a miss
    // rather than an error.
    expect(run.stats.listingsParsed).toBe(1);
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 0, errored: 0 });
    expect(run.stats.matchesAuto).toBe(0);

    expect(run.stats.photosCaptured).toBe(0);
    expect(await photosFor(askId)).toHaveLength(0);
    expect(await ledgerRows(requestId)).toMatchObject([{ attempts: 1, errors: 0, lastOutcome: "miss" }]);
    const row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  const HOYO_URL = "https://foxcigar.com/shop/cigars/hoyo-de-monterrey-classic-no-450-ems-robusto/";
  const HOYO_IMG = "https://foxcigar.com/wp-content/uploads/hoyo-de-monterrey-classic-no-450-ems-robusto.jpg";
  const hoyoRoutes = {
    [ROBOTS]: { body: loadFixture("robots.txt") },
    [SITEMAP]: { body: urlsetXml([HOYO_URL]) },
    [HOYO_URL]: { body: loadFixture("product-hoyo-classic-450.html") },
    [HOYO_IMG]: { binary: Buffer.from("hoyo-image"), contentType: "image/jpeg" },
  };

  // THE CUBAN LOU'S SHAPE. The ask is the Habanos `Hoyo de Monterrey Epicure
  // Especial`, stored under a name that abbreviates its own marca to `HdM`; the
  // shop's only Hoyo listing is the General Cigar bundle — a different market and
  // a different blend that happens to share the marca's words.
  //
  // WHAT #240 CHANGED HERE, and it is the shape of the whole fix. The old
  // prefilter tokenized the ask's NAME, so `hdm` met `hoyo-de-monterrey-...` on
  // nothing, offered no candidate, and the drain recorded a `miss` — a claim about
  // this shop's Hoyo shelf, written without opening a page on it. The prefilter now
  // reads the ask's registry BRAND, so the shelf is genuinely read, and the miss
  // that comes back is one: `hdm` is still a REQUIRED key and the structural rule
  // refuses the bundle. That arm is pinned pure in core/enrich-cover.test.ts, along
  // with the curator's fix — an alias, never a looser matcher.
  it("a Cuban Hoyo ask reads the shop's Hoyo shelf and is not answered by the non-Cuban bundle", async () => {
    const lane = await makeVendor("Cuban Lous Hoyo", "both");
    await arrange([lane]);

    const askId = await seedCigar("HdM Epicure Especial", "CC", { brand: "Hoyo de Monterrey" });
    const requestId = await seedRequest(askId);

    const run = await enrichRun(lane, hoyoRoutes, createMemoryPhotoStorage());
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 1, matched: 0, errored: 0 });
    // The page WAS opened — that is what makes the `miss` below evidence.
    expect(run.stats.listingsParsed).toBe(1);
    expect(run.stats.photosCaptured).toBe(0);
    expect(await photosFor(askId)).toHaveLength(0);
    expect(await ledgerRows(requestId)).toMatchObject([{ attempts: 1, errors: 0, lastOutcome: "miss" }]);
    expect((await requestRow(requestId)).status).toBe("pending");
  });

  // THE OTHER HALF OF #240, in the prod case the issue names. Fox has never
  // stocked Caldwell: not the marca, not one of the ask's identity words, nothing.
  // The old prefilter still handed it eight pages on `robusto` and `the` alone,
  // spent the fetches, wrote `miss`, and marched the ask toward `exhausted` —
  // "Fox read its catalogue and does not carry it" assembled out of unrelated
  // cigars. Now no page is opened, nothing is spent, and the ask waits for a lane
  // that stocks the brand.
  it("an ask for a marca the catalogue does not carry opens no page and burns nothing", async () => {
    const lane = await makeVendor("Caldwell Lane", "NC");
    await arrange([lane]);

    const askId = await seedCigar("Caldwell Long Live the King The Heater", "NC", { brand: "Caldwell" });
    const requestId = await seedRequest(askId);

    const run = await enrichRun(lane, missRoutes, createMemoryPhotoStorage());
    expect(run.stats.enrich).toMatchObject({ requests: 1, looked: 0, matched: 0, errored: 0, noCandidate: 1 });
    expect(run.stats.listingsParsed).toBe(0);
    expect(run.stats.matchesAuto).toBe(0);
    expect(await photosFor(askId)).toHaveLength(0);
    expect(await ledgerRows(requestId)).toMatchObject([{ attempts: 0, errors: 0, lastOutcome: "no_candidate" }]);
    expect((await requestRow(requestId)).status).toBe("pending");
  });

  // HOW DEEP THE NIGHTLY DRAIN GOES, raised 10 → 50 with #233. At ten a night the
  // backlog outran the drain, and the old ceiling was set when most looks were
  // being thrown away by the trigram floor anyway. The politeness arithmetic that
  // actually bounds this is in ingest.ts; what a test can pin is the number and
  // the ORDER — oldest first, so the queue drains rather than churns its head.
  it("the drain takes 50 open requests a night, oldest first", async () => {
    const lane = await makeVendor("Drain Depth", "NC");
    await arrange([lane]);

    // Names this enumeration carries no word of, so nothing is fetched: the case
    // is about SELECTION, and a page per request would make it about politeness
    // instead. Since #240 that is a `no_candidate` rather than a zero-cost miss,
    // which is why the ledger below reads `attempts: 0` — selection is still
    // visible, because the drain writes a row for every request it took.
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      const cigarId = await seedCigar(`Phantom Depth Zeta ${i}`, "NC");
      ids.push(await seedRequest(cigarId, new Date(Date.UTC(2026, 7, 26, 0, i))));
    }

    const run = await enrichRun(lane, missRoutes);
    expect(run.stats.enrich).toMatchObject({ requests: 50, looked: 0, matched: 0, errored: 0, noCandidate: 50 });

    // The oldest was selected, and so was the 50th...
    expect(await ledgerRows(ids[0]!)).toMatchObject([{ attempts: 0, lastOutcome: "no_candidate" }]);
    expect((await requestRow(ids[0]!)).attempts).toBe(0);
    expect(await ledgerRows(ids[49]!)).toHaveLength(1);

    // ...and the 51st was not touched at all: no ledger row, no attempt, still
    // pending, waiting for tomorrow at the head of the queue.
    expect(await ledgerRows(ids[50]!)).toHaveLength(0);
    const newest = await requestRow(ids[50]!);
    expect(newest.status).toBe("pending");
    expect(newest.attempts).toBe(0);
  });

  // §2c, THE COUPLING. The drain's open set has to be the exact complement of the
  // rollup's denominator over the SAME market value. If the drain filtered on the
  // evidenced market while the rollup filtered on `cigars.type`, the CC lane here
  // would sit in the denominator of a request it will never be sent — and the row
  // would hang forever, which is #185's failure mode arriving by another door.
  it("a request the drain refuses to send to a lane does not count that lane in its denominator", async () => {
    const nc = await makeVendor("Coupling NC", "NC");
    const cc = await makeVendor("Coupling CC", "CC");
    await arrange([nc, cc]);

    const cigarId = await seedCigar(`Red Anchor Coupled Untyped ${randomUUID().slice(0, 8)}`, null);
    const requestId = await seedRequest(cigarId);
    await stock(nc, cigarId); // evidenced NC

    // The CC lane is refused the row...
    expect((await enrichRun(cc, missRoutes)).stats.enrich!.requests).toBe(0);
    // ...and is therefore NOT in the denominator, so the NC lane's own budget is
    // enough to retire it.
    await enrichRun(nc, missRoutes);
    expect((await requestRow(requestId)).status).toBe("pending");
    await enrichRun(nc, missRoutes);
    expect((await requestRow(requestId)).status).toBe("exhausted");
    expect((await ledgerRows(requestId)).map((r) => r.vendorId)).toEqual([nc]);
  });

  // --- #157: one runner per (vendor, mode) ------------------------------------

  // A pool of our own: the harness hands out a Database, and the advisory lock
  // needs a CLIENT it can hold for the length of a run. Ended in the case that
  // opens it, so nothing leaks into a neighbour.
  const withPool = async <T,>(fn: (pool: ReturnType<typeof createDatabase>["pool"]) => Promise<T>): Promise<T> => {
    const { pool } = createDatabase(pg.url);
    try {
      return await fn(pool);
    } finally {
      await pool.end();
    }
  };

  const runsFor = (vendor: string, kind: "seed" | "offers" | "enrich") =>
    pg.db.select().from(crawlRuns).where(and(eq(crawlRuns.vendorId, vendor), eq(crawlRuns.kind, kind)));

  // #181 made the attempt increment atomic, so no look is lost any more. What
  // remained: two overlapping same-vendor runs SELECT the same rows and fetch them
  // twice — burning both nights of ATTEMPTS_PER_VENDOR in one evening and doubling
  // the polite load on the vendor. Neither is corruption; both defeat the "two
  // nights of evidence" the budget exists for.
  it("two same-vendor enrich runs cannot overlap: the second is refused and writes no run row", async () => {
    // No seeded run: this case COUNTS crawl_runs rows, and makeVendor's default
    // fixture row is itself a `succeeded` enrich run.
    const only = await makeVendor("Lane Lock", "NC", { enrichRun: false });
    await arrange([only]);
    const cigarId = await seedCigar("Red Anchor Lock", "NC");
    const requestId = await seedRequest(cigarId);

    await withPool(async (pool) => {
      let innerAcquired: boolean | null = null;
      const outer = await withVendorLaneLock(pool, only, "enrich", async () => {
        const inner = await withVendorLaneLock(pool, only, "enrich", async () => "ran");
        innerAcquired = inner.acquired;
        return enrichRun(only, missRoutes);
      });

      expect(innerAcquired).toBe(false);
      expect(outer.acquired).toBe(true);
    });

    // Exactly one run row, and one look on the ledger — not two.
    expect(await runsFor(only, "enrich")).toHaveLength(1);
    const ledger = await ledgerRows(requestId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.attempts).toBe(1);
  });

  // PER (VENDOR, MODE), not per vendor. Fox's `offers` lane starts at 04:00 with a
  // 9,000 s deadline and can still be running when the 06:00 `enrich` lane starts;
  // a per-vendor lock would make a correctness fix silently cancel a nightly job.
  it("the lock is per (vendor, mode): an offers run in flight does not block the enrich lane", async () => {
    const both = await makeVendor("Two Lane", "NC");
    await arrange([both]);

    await withPool(async (pool) => {
      const outer = await withVendorLaneLock(pool, both, "offers", async () => {
        const enrich = await withVendorLaneLock(pool, both, "enrich", async () => "enrich ran");
        expect(enrich).toEqual({ acquired: true, value: "enrich ran" });
        // ...and its OWN mode is still exclusive.
        const offers = await withVendorLaneLock(pool, both, "offers", async () => "offers ran");
        expect(offers.acquired).toBe(false);
        return "offers held";
      });
      expect(outer).toEqual({ acquired: true, value: "offers held" });
    });
  });

  // The stated, bounded cost of a session-level lock: a pod lost with its node can
  // leave a half-open connection holding it until Postgres reaps the backend, and
  // that lane skips until then. Correctness never depends on it — the run simply
  // does not happen — and the NEXT run proceeds once the holder is gone.
  it("a lock held elsewhere makes the lane skip, and the next run proceeds once it is released", async () => {
    const skipping = await makeVendor("Skipped Lane", "NC", { enrichRun: false });
    await arrange([skipping]);

    await withPool(async (holder) => {
      const held = await holder.connect();
      try {
        const key = `cj:crawl:${skipping}:enrich`;
        await held.query("SELECT pg_advisory_lock(hashtext($1))", [key]);

        await withPool(async (pool) => {
          const refused = await withVendorLaneLock(pool, skipping, "enrich", async () => "must not run");
          expect(refused.acquired).toBe(false);
        });
        expect(await runsFor(skipping, "enrich")).toHaveLength(0);

        await held.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      } finally {
        held.release();
      }

      await withPool(async (pool) => {
        const next = await withVendorLaneLock(pool, skipping, "enrich", () => enrichRun(skipping, missRoutes));
        expect(next.acquired).toBe(true);
      });
    });
    expect(await runsFor(skipping, "enrich")).toHaveLength(1);
  });

  // --- #155: stranded runs ----------------------------------------------------

  // A fake `process`, so a case can drive the handler without signalling — or
  // exiting — the vitest worker. The real one is wired in production.
  function fakeSignalHost() {
    const handlers = new Map<string, Set<() => void>>();
    const exits: number[] = [];
    let resolveExit: (() => void) | null = null;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const host: SignalHost = {
      on(signal, handler) {
        const set = handlers.get(signal) ?? new Set<() => void>();
        set.add(handler);
        handlers.set(signal, set);
      },
      off(signal, handler) {
        handlers.get(signal)?.delete(handler);
      },
      exit(code) {
        exits.push(code);
        resolveExit?.();
      },
    };
    return {
      host,
      exits,
      exited,
      listeners: (signal: string) => handlers.get(signal)?.size ?? 0,
      fire: (signal: "SIGTERM" | "SIGINT") => {
        for (const handler of [...(handlers.get(signal) ?? [])]) handler();
      },
    };
  }

  const runRow = async (id: string) => (await pg.db.select().from(crawlRuns).where(eq(crawlRuns.id, id)))[0]!;

  // THE REPORTED TRIGGER: `activeDeadlineSeconds` fires, Kubernetes sends SIGTERM
  // and waits out the grace period, and the row stays `running` forever because
  // nothing owned closing it.
  it("SIGTERM during a drain marks the open run failed and leaves the request unstranded", async () => {
    // No seeded run: the case reads the ONE crawl_runs row this drain opens.
    const signalled = await makeVendor("Signalled", "NC", { enrichRun: false });
    await arrange([signalled]);
    const cigarId = await seedCigar("Nonexistent Phantom Cigar Signal", "NC");
    const requestId = await seedRequest(cigarId);

    const signals = fakeSignalHost();
    const base = createMockFetcher(missRoutes);
    let fired = false;
    let midRun: { status: string; error: string | null; finishedAt: Date | null } | null = null;

    // The sitemap fetch is the first thing the drain does after opening its run
    // row, so the signal lands with the row `running` and work still to do.
    const interrupting: MockFetcher = {
      requested: base.requested,
      get pagesFetched() {
        return base.pagesFetched;
      },
      fetchText: async (url: string) => {
        const response = await base.fetchText(url);
        if (!fired && url === SITEMAP) {
          fired = true;
          signals.fire("SIGTERM");
          // In production `process.exit(1)` ends the process right here and the
          // success UPDATE never runs. A fake host cannot stop the run, so the row
          // is read at the moment the handler's UPDATE committed — which is the
          // state a killed pod would leave behind.
          await signals.exited;
          const row = (await runsFor(signalled, "enrich"))[0]!;
          midRun = { status: row.status, error: row.error, finishedAt: row.finishedAt };
        }
        return response;
      },
      fetchBinary: base.fetchBinary,
    };

    await runIngest(
      {
        db: pg.db,
        fetcher: interrupting,
        storage: null,
        now,
        processPhoto: fakeProcessPhoto,
        signalHost: signals.host,
      },
      { adapter: foxCigar, vendorId: signalled, mode: "enrich" },
    );

    expect(signals.exits).toEqual([1]);
    expect(midRun).toMatchObject({ status: "failed", error: "terminated: SIGTERM" });
    expect(midRun!.finishedAt).not.toBeNull();
    // The handler is removed once it has fired, so a second signal cannot start a
    // second UPDATE against a connection the process is about to lose.
    expect(signals.listeners("SIGTERM")).toBe(0);
    // The request itself is left OPEN and reachable — no `in_progress` claim to
    // strand it, which is what #181 removed and this must not reintroduce.
    expect((await requestRow(requestId)).status).toBe("pending");
  });

  // `AND status = 'running'` is the whole of the race safety: a signal arriving
  // after the success UPDATE has committed matches nothing and flips nothing.
  it("a signal arriving after normal completion cannot flip a succeeded run to failed", async () => {
    const finishing = await makeVendor("Finishing", "NC");
    await arrange([finishing]);

    const signals = fakeSignalHost();
    const open = await openCrawlRun(pg.db, { vendorId: finishing, kind: "enrich", now, host: signals.host });
    expect(signals.listeners("SIGTERM")).toBe(1);

    await open.close("succeeded", { stats: { pagesFetched: 0 } });
    // close() disarms, so the real handler is already gone...
    expect(signals.listeners("SIGTERM")).toBe(0);
    signals.fire("SIGTERM");
    expect(signals.exits).toEqual([]);

    // ...and even called directly, the guard refuses the row.
    expect(await markRunTerminated(pg.db, open.crawlRunId, "terminated: SIGTERM")).toBe(0);
    expect((await runRow(open.crawlRunId)).status).toBe("succeeded");
  });

  // SIGKILL, OOM and node loss run no handler at all. The sweep is the backstop,
  // and it is scoped to (vendor, kind) for the same reason the lock is.
  it("the startup sweep reclaims this lane's stranded rows and leaves every other lane alone", async () => {
    const swept = await makeVendor("Swept", "NC");
    const neighbour = await makeVendor("Neighbour", "NC");
    await arrange([swept]);

    const stranded = await pg.db
      .insert(crawlRuns)
      .values({ vendorId: swept, kind: "enrich", status: "running", startedAt: now() })
      .returning({ id: crawlRuns.id });
    const otherMode = await pg.db
      .insert(crawlRuns)
      .values({ vendorId: swept, kind: "offers", status: "running", startedAt: now() })
      .returning({ id: crawlRuns.id });
    const otherVendor = await pg.db
      .insert(crawlRuns)
      .values({ vendorId: neighbour, kind: "enrich", status: "running", startedAt: now() })
      .returning({ id: crawlRuns.id });

    await enrichRun(swept, missRoutes);

    const reclaimed = await runRow(stranded[0]!.id);
    expect(reclaimed.status).toBe("failed");
    expect(reclaimed.error).toMatch(/no completion recorded/);
    expect(reclaimed.finishedAt).not.toBeNull();
    // Fox's 04:00 offers lane can still be running at 06:00, and another vendor's
    // lane is none of this run's business.
    expect((await runRow(otherMode[0]!.id)).status).toBe("running");
    expect((await runRow(otherVendor[0]!.id)).status).toBe("running");
  });

  // WHY THE SWEEP NEEDS NO AGE CEILING. It cannot meet a genuinely concurrent run,
  // because a concurrent run is refused the lane lock BEFORE it can reach the
  // sweep. The issue asked for "a sane ceiling"; a lock is exact, and a ceiling
  // would be a constant that has to track the slowest legitimate run.
  it("a concurrent run is refused the lock before any sweep can execute", async () => {
    const contested = await makeVendor("Contested", "NC");
    await arrange([contested]);

    await withPool(async (pool) => {
      const held = await pool.connect();
      try {
        await held.query("SELECT pg_advisory_lock(hashtext($1))", [`cj:crawl:${contested}:enrich`]);

        const inFlight = await pg.db
          .insert(crawlRuns)
          .values({ vendorId: contested, kind: "enrich", status: "running", startedAt: now() })
          .returning({ id: crawlRuns.id });

        await withPool(async (second) => {
          const refused = await withVendorLaneLock(second, contested, "enrich", () =>
            enrichRun(contested, missRoutes),
          );
          expect(refused.acquired).toBe(false);
        });

        // The run that is genuinely in flight is untouched.
        expect((await runRow(inFlight[0]!.id)).status).toBe("running");
        await held.query("SELECT pg_advisory_unlock(hashtext($1))", [`cj:crawl:${contested}:enrich`]);
      } finally {
        held.release();
      }
    });
  });

  // #155 must not be able to corrupt #185's denominator. A stranded row is
  // `running` and a reclaimed one is `failed`; liveness reads only `succeeded`, so
  // the sweep moves a row between two equally uncounted states.
  it("a reclaimed run does not make a vendor live", async () => {
    const reclaimedLane = await makeVendor("Reclaimed Lane", "NC", { enrichRun: false });
    await arrange([reclaimedLane]);
    await pg.db
      .insert(crawlRuns)
      .values({ vendorId: reclaimedLane, kind: "enrich", status: "running", startedAt: now() });

    expect(await reclaimStrandedRuns(pg.db, { vendorId: reclaimedLane, kind: "enrich" })).toBe(1);

    const fleet = await enrichVendorFleet(pg.db, "NC");
    const entry = fleet.find((v) => v.vendorId === reclaimedLane)!;
    expect(entry.lastEnrichStartedAt).toBeNull();
  });
});
