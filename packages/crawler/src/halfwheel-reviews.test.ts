import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { auditLog, blends, brands, cigars, crawlRuns, lines, vendors } from "@cj/db";
import { brandSlug, fold } from "@cj/domain";
import { runIngest, type IngestDeps } from "./core/ingest.js";
import { adapterPosture } from "./core/vendor-posture.js";
import { halfwheel } from "./adapters/halfwheel.js";
import { createMockFetcher, loadFixture, type MockFetcher } from "./testing/fixtures.js";

// THE REVIEWER LANE END TO END, over a real embedded Postgres (ADR-013 §2, issue
// #199 slice 2a). The fetch layer is mocked against the live captures under
// `__fixtures__/halfwheel/` — the guardrail is that a test never touches a live
// site — and everything below the fetcher is the real thing: the real adapter,
// the real matcher, the real `recordReviewObservation`, the real migrations.
//
// Three claims are being made here, and they are the three ADR-013's acceptance
// criteria turn on: a re-crawl creates ZERO duplicates, a review that resolves to
// nothing is COUNTED AND SKIPPED (a reviewer never mints), and the row that lands
// carries the provenance a human could check the claim with.

const ROBOTS = "https://halfwheel.com/robots.txt";
const INDEX_1 = "https://halfwheel.com/category/reviews/cigars/";
const INDEX_2 = "https://halfwheel.com/category/reviews/cigars/page/2/";
const INDEX_3 = "https://halfwheel.com/category/reviews/cigars/page/3/";
const ALADINO = "https://halfwheel.com/aladino-250th/478243/";
const ASHLAR = "https://halfwheel.com/hiram-solomon-ashlar/477873/";
const JAMIE_FOXX = "https://halfwheel.com/ag-cigars-legendary-moment-jamie-foxx/476898/";
// Enumerated on index page 2 and deliberately given NO page fixture: it answers
// 404, which is what a deleted or moved post does.
const ZINO = "https://halfwheel.com/zino-honduras-robusto/478174/";

const fixture = (name: string): string => loadFixture(name, "halfwheel");

interface ObservationRow {
  source: string;
  url: string;
  reviewer: string | null;
  native_scale: string;
  native_score: string;
  normalized_score: string;
  reviewed_at: string | null;
  excerpt: string | null;
  cigar_id: string | null;
  blend_id: string | null;
  raw: Record<string, unknown> | null;
  last_seen_at: string;
  updated_at: string;
}

describe("halfwheel reviewer lane (embedded Postgres)", () => {
  let pg: TestPostgres;
  let sourceId: string;
  let ashlarCigarId: string;
  let foxxBlendId: string;
  let now = () => new Date("2026-09-03T02:00:00.000Z");

  function deps(fetcher: MockFetcher): IngestDeps {
    // No photo storage, and no `processPhoto`: this lane fetches no image, ever
    // (halfwheel's own image policy — see the adapter header). Passing null is
    // the assertion that nothing in the path needs one.
    return { db: pg.db, fetcher, storage: null, now: () => now() };
  }

  const routes = (overrides: Record<string, { status?: number; body?: string }> = {}) => ({
    [ROBOTS]: { body: fixture("robots.txt") },
    [INDEX_1]: { body: fixture("reviews-index.html") },
    [INDEX_2]: { body: fixture("reviews-index-page2.html") },
    [INDEX_3]: { body: fixture("reviews-index-empty.html") },
    [ALADINO]: { body: fixture("review-aladino-250th.html") },
    [ASHLAR]: { body: fixture("review-hiram-solomon-ashlar.html") },
    [JAMIE_FOXX]: { body: fixture("review-ag-cigars-legendary-moment-jamie-foxx.html") },
    // ZINO is intentionally absent — createMockFetcher answers 404.
    ...overrides,
  });

  const observations = async (): Promise<ObservationRow[]> => {
    const result = await pg.db.execute(sql`
      SELECT source, url, reviewer, native_scale, native_score, normalized_score,
             reviewed_at::text AS reviewed_at, excerpt, cigar_id, blend_id, raw,
             last_seen_at::text AS last_seen_at, updated_at::text AS updated_at
      FROM review_observations ORDER BY url
    `);
    return result.rows as unknown as ObservationRow[];
  };

  const cigarCount = async (): Promise<number> =>
    (await pg.db.select({ id: cigars.id }).from(cigars)).length;

  beforeAll(async () => {
    pg = await startTestPostgres();

    // THE REGISTRY ROW THE SEED PATH WOULD WRITE. `adapterPosture` is the same
    // projection `resolveVendor` inserts, so this INSERT is the assertion that a
    // reviewer adapter's posture is a row `vendors_non_vendor_source_chk` will
    // hold: no focus, and `purchase_linkout` explicitly false against a column
    // that defaults to true.
    const posture = adapterPosture(halfwheel);
    expect(posture).toMatchObject({ kind: "reviewer", focus: null, purchaseLinkout: false, displayEnabled: false });
    sourceId = (
      await pg.db
        .insert(vendors)
        .values({ name: halfwheel.name, url: halfwheel.url, ...posture })
        .returning({ id: vendors.id })
    )[0]!.id;

    // Matching v2 anchors on a brand alias before it reads a title as a name
    // (ADR-012), so a review only resolves once its marca is in the registry.
    const seedBrand = async (name: string): Promise<string> =>
      (
        await pg.db
          .insert(brands)
          .values({ name, slug: brandSlug(name), aliases: [...new Set([brandSlug(name), fold(name)])] })
          .returning({ id: brands.id })
      )[0]!.id;

    // A LEAF the reviewer's headline names exactly → a cigar-linked observation.
    const ashlarBrandId = await seedBrand("Hiram & Solomon");
    ashlarCigarId = (
      await pg.db
        .insert(cigars)
        .values({ canonicalName: "Hiram & Solomon Ashlar", brandId: ashlarBrandId })
        .returning({ id: cigars.id })
    )[0]!.id;

    // A BLEND WITH NO LEAVES UNDER IT → a blend-linked observation. The headline
    // `AG Cigars Legendary Moment Jamie Foxx` names a brand, a line and a blend
    // and NO VITOLA — halfwheel smoked the Gordo, but the title does not say so —
    // so the blend is the most specific level the SOURCE stated, which is exactly
    // what ADR-013 §2 asks the linkage to be.
    const foxxBrandId = await seedBrand("AG Cigars");
    const foxxLineId = (
      await pg.db
        .insert(lines)
        .values({
          brandId: foxxBrandId,
          name: "Legendary Moment",
          slug: "legendary-moment",
          aliases: ["legendary-moment"],
        })
        .returning({ id: lines.id })
    )[0]!.id;
    foxxBlendId = (
      await pg.db
        .insert(blends)
        .values({ lineId: foxxLineId, name: "Jamie Foxx", slug: "jamie-foxx", aliases: ["jamie-foxx"] })
        .returning({ id: blends.id })
    )[0]!.id;

    // Aladino is seeded NOWHERE. Its review anchors no brand alias and is the
    // unresolved one — counted, skipped, and never minted.
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it("walks the archive, links what resolves, and mints nothing for what does not", async () => {
    const before = await cigarCount();
    const fetcher = createMockFetcher(routes());
    const result = await runIngest(deps(fetcher), { adapter: halfwheel, vendorId: sourceId, mode: "enrich" });

    expect(result.status).toBe("succeeded");
    expect(result.stats.reviews).toEqual({
      // Page 3 is the empty one: fetched, yields nothing, ends the walk.
      indexPages: 3,
      candidates: 4,
      // Zino 404s.
      parsed: 3,
      unparsed: 1,
      linkedCigar: 1,
      linkedBlend: 1,
      // Aladino anchors no brand alias.
      unresolved: 1,
      recorded: 2,
      amended: 0,
    });
    // A REVIEWER STOCKS NOTHING, SO IT MINTS NOTHING. The unresolved review is
    // the exact population seed mode would have minted from a vendor listing;
    // here it is registry debt and the catalog is untouched.
    expect(await cigarCount()).toBe(before);
    // …and it is named in the run's report, not merely counted.
    expect(result.report.join("\n")).toContain("Aladino 250th");
    expect(result.report.join("\n")).toContain("no catalog target — not minted");

    // The lane fetched robots, three index pages and four reviews — no sitemap,
    // no images, nothing else.
    expect(fetcher.requested).toEqual([ROBOTS, INDEX_1, INDEX_2, INDEX_3, ALADINO, ASHLAR, JAMIE_FOXX, ZINO]);
  });

  it("writes the score, the provenance and exactly one target per row", async () => {
    const rows = await observations();
    expect(rows).toHaveLength(2);

    const foxx = rows.find((r) => r.url === JAMIE_FOXX)!;
    expect(foxx).toMatchObject({
      // The ADAPTER SLUG, lowercased — the key half that outlives registry churn.
      source: "halfwheel",
      reviewer: "Charlie Minato",
      native_scale: "0-100",
      native_score: "85",
      reviewed_at: "2026-08-21",
      // The blend, because the headline named no vitola. Exactly one target, per
      // `review_observations_target_chk`.
      cigar_id: null,
      blend_id: foxxBlendId,
    });
    expect(Number(foxx.normalized_score)).toBe(85);
    expect(foxx.excerpt).toContain("who once served as the custom roller");
    // Evidence about how the row was derived — never a place to park prose.
    expect(foxx.raw).toMatchObject({ adapter: "halfwheel", headline: "AG Cigars Legendary Moment Jamie Foxx" });
    // The URL is the archive's, normalized — never the page's own JSON-LD `@id`,
    // which on this very page is `https://halfwheel.com/?p=476898`.
    expect(foxx.url).toBe(JAMIE_FOXX);

    const ashlar = rows.find((r) => r.url === ASHLAR)!;
    expect(ashlar).toMatchObject({
      reviewer: "Brooks Whittington",
      native_score: "89",
      reviewed_at: "2026-08-26",
      cigar_id: ashlarCigarId,
      blend_id: null,
    });

    // The licence bound, on every row that lands.
    for (const row of rows) expect((row.excerpt ?? "").length).toBeLessThanOrEqual(400);
  });

  it("audits each write as a review.record", async () => {
    const rows = await pg.db
      .select({ action: auditLog.action, actor: auditLog.actor })
      .from(auditLog)
      .where(eq(auditLog.action, "review.record"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.actor === "system")).toBe(true);
  });

  it("brackets the walk in a crawl_runs row carrying the reviewer stats", async () => {
    const runs = await pg.db.select().from(crawlRuns).where(eq(crawlRuns.vendorId, sourceId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
    // A reviewer rides the existing enrich lane rather than needing a schedule of
    // its own (fleet.ts: modes are the adapter's business).
    expect(runs[0]!.kind).toBe("enrich");
    expect((runs[0]!.stats as { reviews?: { recorded: number } }).reviews?.recorded).toBe(2);
  });

  // ------------------------------------------------------------------------
  // ADR-013's first acceptance criterion, stated as a test.
  // ------------------------------------------------------------------------
  it("creates zero duplicates on a re-crawl, and moves last_seen without touching updated_at", async () => {
    const before = await observations();
    now = () => new Date("2026-09-04T02:00:00.000Z");
    const result = await runIngest(deps(createMockFetcher(routes())), {
      adapter: halfwheel,
      vendorId: sourceId,
      mode: "enrich",
    });

    expect(result.stats.reviews).toMatchObject({ recorded: 2, amended: 0, unresolved: 1 });
    const after = await observations();
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.url)).toEqual(before.map((r) => r.url));
    for (let i = 0; i < after.length; i++) {
      // "Still up" moved; "the score changed" did not. Conflating the two would
      // make every row look freshly amended after every nightly run.
      expect(new Date(after[i]!.last_seen_at).getTime()).toBeGreaterThan(
        new Date(before[i]!.last_seen_at).getTime(),
      );
      expect(after[i]!.updated_at).toBe(before[i]!.updated_at);
    }
    // No second audit row for a night of no news.
    const audits = await pg.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "review.record"));
    expect(audits).toHaveLength(2);
  });

  it("records a corrected score as an amendment, not a second observation", async () => {
    now = () => new Date("2026-09-05T02:00:00.000Z");
    const corrected = fixture("review-hiram-solomon-ashlar.html")
      .replace('class="post-review score-89"', 'class="post-review score-91"')
      .replace('<span class="overall">89</span>', '<span class="overall">91</span>');
    const result = await runIngest(deps(createMockFetcher(routes({ [ASHLAR]: { body: corrected } }))), {
      adapter: halfwheel,
      vendorId: sourceId,
      mode: "enrich",
    });

    expect(result.stats.reviews).toMatchObject({ recorded: 2, amended: 1 });
    const rows = await observations();
    expect(rows).toHaveLength(2);
    const ashlar = rows.find((r) => r.url === ASHLAR)!;
    expect(ashlar.native_score).toBe("91");
    expect(Number(ashlar.normalized_score)).toBe(91);
    const amendments = await pg.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "review.amend"));
    expect(amendments).toHaveLength(1);
  });

  // ------------------------------------------------------------------------
  // The other two modes. A reviewer sells nothing, so the weekly offers fleet
  // must not fail a whole run over it — and must not walk it twice either.
  // ------------------------------------------------------------------------
  for (const mode of ["seed", "offers"] as const) {
    it(`does nothing under --mode ${mode}, and says so`, async () => {
      const rowsBefore = (await observations()).length;
      const fetcher = createMockFetcher(routes());
      const result = await runIngest(deps(fetcher), { adapter: halfwheel, vendorId: sourceId, mode });

      expect(result.status).toBe("succeeded");
      expect(result.stats.reviews).toBeUndefined();
      // Not one request: no robots read, no index, nothing.
      expect(fetcher.requested).toEqual([]);
      expect((await observations()).length).toBe(rowsBefore);
      expect(result.report.join("\n")).toContain("is a reviewer source");
      expect(result.report.join("\n")).toContain("--mode enrich");
    });
  }

  it("refuses to crawl when robots.txt disallows us", async () => {
    const result = await runIngest(
      deps(createMockFetcher(routes({ [ROBOTS]: { body: "User-agent: *\nDisallow: /\n" } }))),
      { adapter: halfwheel, vendorId: sourceId, mode: "enrich" },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("robots.txt disallows the review index");
  });

  it("honors --limit and reports would-writes without touching the database on a dry run", async () => {
    const before = await observations();
    const fetcher = createMockFetcher(routes());
    const result = await runIngest(deps(fetcher), {
      adapter: halfwheel,
      vendorId: sourceId,
      mode: "enrich",
      limit: 2,
      dryRun: true,
    });

    expect(result.crawlRunId).toBeNull();
    // Two candidates, so page 1 alone satisfies the cap and page 2 is never fetched.
    expect(result.stats.reviews).toMatchObject({ indexPages: 1, candidates: 3, parsed: 2, unresolved: 1 });
    expect(fetcher.requested).toEqual([ROBOTS, INDEX_1, ALADINO, ASHLAR]);
    expect(result.report.join("\n")).toContain("score=89/0-100");
    // The dry run wrote nothing: same rows, same timestamps.
    expect(await observations()).toEqual(before);
  });
});
