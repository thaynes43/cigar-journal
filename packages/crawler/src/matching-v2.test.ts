import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { blends, brands, cigars, lines, listingMatches, offers, vendors } from "@cj/db";
import { brandSlug, fold } from "@cj/domain";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
import { runIngest, type IngestDeps } from "./core/ingest.js";
import { foxCigar } from "./adapters/fox-cigar.js";
import { createMockFetcher, urlsetXml, loadFixture, fakeProcessPhoto, type MockFetcher } from "./testing/fixtures.js";

// THE ACCEPTANCE SUITE FOR MATCHING V2 (ADR-012, issue #196 Wave 2). Each case
// here is one of the failures the ADR was written about, arranged end-to-end
// through a real crawl over a real embedded Postgres. Where ingest.test.ts proves
// the crawler's mechanics still work, this file proves the specific things that
// used to be wrong are now right.

const ROBOTS = "https://foxcigar.com/robots.txt";
const SITEMAP = "https://foxcigar.com/sitemap.xml";
const PADRON_URL = "https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo/";
const PADRON_BOX_URL = "https://foxcigar.com/shop/padron-1964-anniversary-maduro-torpedo-box-of-20/";
const UNKNOWN_URL = "https://foxcigar.com/shop/vuelta-abajo-reserva-especial-robusto/";
const PADRON_IMG = "https://foxcigar.com/wp-content/uploads/padron-1964-torpedo.jpg";

const PADRON_NAME = "Padron 1964 Anniversary Maduro Torpedo";

describe("matching v2 (embedded Postgres)", () => {
  let pg: TestPostgres;
  const now = () => new Date("2026-08-31T12:00:00.000Z");

  function deps(fetcher: MockFetcher, storage: PhotoStorage | null): IngestDeps {
    return { db: pg.db, fetcher, storage, now, processPhoto: fakeProcessPhoto };
  }

  // Matching v2 anchors on a brand alias before anything else, so a fixture only
  // resolves once its marca is in the registry. `aliases` holds folded MATCHING
  // KEYS, never display text — the convention migration 0026 seeds and the only
  // thing the exact-match GIN probe can find.
  const seedBrand = async (name: string): Promise<string> => {
    const rows = await pg.db
      .insert(brands)
      .values({ name, slug: brandSlug(name), aliases: [...new Set([brandSlug(name), fold(name)])] })
      .returning({ id: brands.id });
    return rows[0]!.id;
  };

  const makeVendor = async (name: string): Promise<string> => {
    const rows = await pg.db
      .insert(vendors)
      .values({
        name,
        url: "https://foxcigar.com",
        // 'both' keeps the #170 market guard out of the way: these cases are
        // about identity resolution, and the guard has its own coverage.
        focus: "both",
        crawlEnabled: true,
        approvalStatus: "owner-added",
      })
      .returning({ id: vendors.id });
    return rows[0]!.id;
  };

  const matchesFor = (vendorId: string) =>
    pg.db
      .select({
        listingKey: listingMatches.listingKey,
        cigarId: listingMatches.cigarId,
        status: listingMatches.status,
        decidedBy: listingMatches.decidedBy,
        unmatchedReason: listingMatches.unmatchedReason,
        suggestedParse: listingMatches.suggestedParse,
        categoryPath: listingMatches.categoryPath,
      })
      .from(listingMatches)
      .where(eq(listingMatches.vendorId, vendorId));

  const routes = (urls: string[], bodies: Record<string, string>) => ({
    [ROBOTS]: { body: loadFixture("robots.txt") },
    [SITEMAP]: { body: urlsetXml(urls) },
    ...Object.fromEntries(Object.entries(bodies).map(([url, body]) => [url, { body }])),
    [PADRON_IMG]: { binary: Buffer.from("padron-image"), contentType: "image/jpeg" },
  });

  let padronBrandId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    padronBrandId = await seedBrand("Padrón");
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  // ------------------------------------------------------------------------
  // "A re-crawl of a seeded catalog creates 0 new rows."
  //
  // The headline acceptance criterion, and the one the flat matcher could never
  // meet: every vendor titled differently, titles were the only key, so every
  // vendor minted a parallel catalog (Cuban Lou's put 56 rows over ground Fox
  // already covered).
  // ------------------------------------------------------------------------
  it("a re-crawl of a seeded catalog creates no new rows and re-links the same leaf", async () => {
    const vendorId = await makeVendor(`Recrawl Fox ${randomUUID()}`);
    const map = routes([PADRON_URL], { [PADRON_URL]: loadFixture("product-padron.html") });

    const first = await runIngest(deps(createMockFetcher(map), createMemoryPhotoStorage()), {
      adapter: foxCigar,
      vendorId,
      mode: "seed",
    });
    expect(first.stats.cigarsCreated).toBe(1);
    const afterFirst = (await pg.db.select({ id: cigars.id }).from(cigars)).length;

    const linked = (await matchesFor(vendorId))[0]!;
    expect(linked.status).toBe("auto");

    const second = await runIngest(deps(createMockFetcher(map), createMemoryPhotoStorage()), {
      adapter: foxCigar,
      vendorId,
      mode: "seed",
    });

    // Nothing minted, and the listing still points at the row the first run made.
    expect(second.stats.cigarsCreated).toBe(0);
    expect(second.stats.matchesAuto).toBe(1);
    expect((await pg.db.select({ id: cigars.id }).from(cigars)).length).toBe(afterFirst);
    expect((await matchesFor(vendorId))[0]!.cigarId).toBe(linked.cigarId);
  });

  // The minted row is STRUCTURED, which is the whole point of minting through the
  // parse: v1 stored the raw title and guessed a brand from its first two words
  // against a free-text column.
  it("mints a structured row carrying the registry link and the parsed vitola", async () => {
    const vendorId = await makeVendor(`Structured Fox ${randomUUID()}`);
    await runIngest(
      deps(createMockFetcher(routes([PADRON_URL], { [PADRON_URL]: loadFixture("product-padron.html") })), null),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );

    const row = (await pg.db.select().from(cigars).where(eq(cigars.canonicalName, PADRON_NAME)))[0]!;
    expect(row.brandId).toBe(padronBrandId);
    // The REGISTRY spelling, not the vendor's — the same value deriveBrandId
    // would resolve back to this id, so the text column and the link cannot
    // disagree the moment the row is born.
    expect(row.brand).toBe("Padrón");
    expect(row.vitolaName).toBe("Torpedo");
    // Structure without composition authority: the row knows its marca, but its
    // NAME is still the vendor's phrasing, and claiming otherwise would take a
    // decision that belongs to curation (Wave 3).
    expect(row.nameSource).toBe("freeform");
    expect(row.verification).toBe("unverified");
  });

  // ------------------------------------------------------------------------
  // "A bundle/pack listing attaches to the base leaf with packaging on the
  // offer, minting nothing." (ADR-012 folds in #164.)
  // ------------------------------------------------------------------------
  it("a box listing attaches to the base leaf and puts its packaging on the offer", async () => {
    const vendorId = await makeVendor(`Packaging Fox ${randomUUID()}`);

    // Arrange the single-stick leaf first, exactly as a prior crawl would have.
    // (Minted here or already present from an earlier case in this file — the
    // suite shares one database, and either way the leaf exists before the box
    // listing arrives, which is the arrangement under test.)
    await runIngest(
      deps(createMockFetcher(routes([PADRON_URL], { [PADRON_URL]: loadFixture("product-padron.html") })), null),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );
    const base = (await pg.db.select({ id: cigars.id }).from(cigars).where(eq(cigars.canonicalName, PADRON_NAME)))[0]!;
    expect(base).toBeDefined();
    const catalogSize = (await pg.db.select({ id: cigars.id }).from(cigars)).length;

    const second = await runIngest(
      deps(
        createMockFetcher(
          routes([PADRON_BOX_URL], { [PADRON_BOX_URL]: loadFixture("product-padron-box.html") }),
        ),
        null,
      ),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );

    // PACKAGING IS NEVER IDENTITY. The box is the same cigar in a different
    // container, so it links to the leaf and mints nothing.
    expect(second.stats.cigarsCreated).toBe(0);
    expect((await pg.db.select({ id: cigars.id }).from(cigars)).length).toBe(catalogSize);

    const boxMatch = (await matchesFor(vendorId)).find((m) => m.listingKey.includes("box-of-20"))!;
    expect(boxMatch).toMatchObject({ status: "auto", cigarId: base.id });

    // The packaging fact is not lost — it moved to where it belongs.
    const boxOffer = (
      await pg.db.select().from(offers).where(eq(offers.listingMatchId, (await boxMatchRow(vendorId)).id))
    )[0]!;
    expect(boxOffer.packaging).toBe("box");
    expect(boxOffer.sticksPerPackage).toBe(20);
  });

  async function boxMatchRow(vendorId: string) {
    const rows = await pg.db
      .select({ id: listingMatches.id })
      .from(listingMatches)
      .where(
        and(
          eq(listingMatches.vendorId, vendorId),
          eq(listingMatches.listingKey, "/shop/padron-1964-anniversary-maduro-torpedo-box-of-20/"),
        ),
      );
    return rows[0]!;
  }

  // ------------------------------------------------------------------------
  // "A no-anchor seed listing goes to triage with suggested_parse populated and
  // reason 'no_anchor'."
  //
  // THE CHANGE THE ADR WAS WRITTEN FOR. Seed mode used to mint from exactly this
  // state, which is how the flat namespace grew a copy of itself per vendor.
  // ------------------------------------------------------------------------
  it("a title matching no brand alias goes to triage instead of minting", async () => {
    const vendorId = await makeVendor(`No Anchor Fox ${randomUUID()}`);
    const before = (await pg.db.select({ id: cigars.id }).from(cigars)).length;

    const run = await runIngest(
      deps(
        createMockFetcher(routes([UNKNOWN_URL], { [UNKNOWN_URL]: loadFixture("product-unknown-marca.html") })),
        createMemoryPhotoStorage(),
      ),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );

    expect(run.stats.cigarsCreated).toBe(0);
    expect(run.stats.linksNoAnchor).toBe(1);
    // NOTHING WAS HELD, so nothing was annotated. This is the half of the split
    // `linksNoAnchor` cannot express on its own — registry debt over a listing
    // nobody had linked, which is a smaller problem than the next case's.
    expect(run.stats.linksAnnotated).toBeUndefined();
    expect((await pg.db.select({ id: cigars.id }).from(cigars)).length).toBe(before);

    const match = (await matchesFor(vendorId))[0]!;
    expect(match).toMatchObject({ status: "unmatched", cigarId: null, unmatchedReason: "no_anchor" });

    // The parse rides the row so a curator inherits the reasoning rather than
    // redoing it by eye — the residue is the part of the title nobody could
    // explain, which is the most useful field on it.
    expect(match.suggestedParse).toMatchObject({
      // The verdict rides the parse on EVERY unresolved row, not only on the
      // still-linked ones the next two cases are about, so a curator reads where
      // the resolver stopped from one field without first having to work out
      // whether this particular row is a triage row or an annotated link.
      reason: "no_anchor",
      brandId: null,
      cleanedName: "Vuelta Abajo Reserva Especial Robusto",
      residue: "Vuelta Abajo Reserva Especial Robusto",
    });
    expect(match.suggestedParse!.notes.join(" ")).toContain("No brand alias matched");

    // And the vendor's own breadcrumb taxonomy — parsed since the crawler was
    // written and thrown away ever since — is finally kept as evidence.
    expect(match.categoryPath).toEqual(["Home", "Shop", "Cigars"]);
  });

  // ------------------------------------------------------------------------
  // POSITIVE EVIDENCE ONLY — the same verdict as the case above, over a listing
  // that ALREADY LINKS.
  //
  // `no_anchor` is a statement about what the registry could not do, never about
  // the cigar: a title that anchored last night and does not tonight has almost
  // always met a registry gap. v2's first draft let it clear `cigar_id` anyway,
  // so every alias nobody had written yet silently detached a working link and
  // orphaned the offer history hanging off it — the matcher undoing, on silence,
  // work an earlier crawl had done correctly.
  // ------------------------------------------------------------------------
  it("keeps a crawler-owned link the crawl cannot re-derive, and prices the listing anyway", async () => {
    const vendorId = await makeVendor(`Silence Keeps ${randomUUID()}`);
    const listingKey = "/shop/vuelta-abajo-reserva-especial-robusto/";

    // The leaf an earlier crawl linked this listing to, back when its marca was
    // in the registry. The link is the work; the gap is ours.
    const kept = (
      await pg.db
        .insert(cigars)
        .values({ canonicalName: `Kept Leaf ${randomUUID()}`, verification: "unverified" })
        .returning({ id: cigars.id })
    )[0]!;
    await pg.db
      .insert(listingMatches)
      .values({ vendorId, listingKey, cigarId: kept.id, status: "auto", createdAt: now(), updatedAt: now() });

    const run = await runIngest(
      deps(
        createMockFetcher(routes([UNKNOWN_URL], { [UNKNOWN_URL]: loadFixture("product-unknown-marca.html") })),
        createMemoryPhotoStorage(),
      ),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );

    // The resolver reached the same verdict as the triage case above — this is
    // the identical listing — so what differs below is the ROW, not the parse.
    expect(run.stats.linksNoAnchor).toBe(1);
    expect(run.stats.cigarsCreated).toBe(0);
    // AND THE SAME VERDICT LANDS IN A SECOND COUNTER HERE. `linksNoAnchor` alone
    // could not tell an operator which of these listings the crawler is actively
    // holding a link for; this one says so, and it is the number that prices a
    // Wave 3 alias session.
    expect(run.stats.linksAnnotated).toBe(1);

    const match = (await matchesFor(vendorId))[0]!;
    expect(match).toMatchObject({ status: "auto", cigarId: kept.id });
    // NOT A LIE ABOUT THE ROW. `unmatched_reason` describes an unmatched row and
    // this one is matched; a reason here would surface in the triage queue and
    // read as a question a curator has to answer about a link that works.
    expect(match.unmatchedReason).toBeNull();
    // The verdict rides the evidence blob instead, which is where the curator who
    // can close the registry gap already looks.
    expect(match.suggestedParse!.reason).toBe("no_anchor");
    expect(match.suggestedParse!.brandId).toBeNull();

    // PRICING IS INTACT, and it is half the point: annotating rather than
    // unlinking keeps the observation attached to the row it belongs to instead
    // of stranding it behind a link the crawl just broke.
    expect(run.stats.offersWritten).toBe(1);
    const row = (
      await pg.db
        .select({ id: listingMatches.id })
        .from(listingMatches)
        .where(and(eq(listingMatches.vendorId, vendorId), eq(listingMatches.listingKey, listingKey)))
    )[0]!;
    expect(await pg.db.select().from(offers).where(eq(offers.listingMatchId, row.id))).toHaveLength(1);
  });

  // The other half of the rule, and the reason it is "positive evidence only"
  // rather than "never move a link": a parse that RESOLVES still re-decides the
  // row, which is how the 42% slug disagreement heals without a migration.
  it("moves a crawler-owned link when the parse resolves to a different leaf", async () => {
    const vendorId = await makeVendor(`Evidence Moves ${randomUUID()}`);
    const stale = (
      await pg.db
        .insert(cigars)
        .values({ canonicalName: `Stale Leaf ${randomUUID()}`, verification: "unverified" })
        .returning({ id: cigars.id })
    )[0]!;
    await pg.db.insert(listingMatches).values({
      vendorId,
      listingKey: "/shop/padron-1964-anniversary-maduro-torpedo/",
      cigarId: stale.id,
      status: "auto",
      createdAt: now(),
      updatedAt: now(),
    });

    await runIngest(
      deps(createMockFetcher(routes([PADRON_URL], { [PADRON_URL]: loadFixture("product-padron.html") })), null),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );

    const padron = (
      await pg.db
        .select({ id: cigars.id })
        .from(cigars)
        .where(and(eq(cigars.canonicalName, PADRON_NAME), eq(cigars.brandId, padronBrandId)))
    )[0]!;
    const match = (await matchesFor(vendorId))[0]!;
    expect(match).toMatchObject({ status: "auto", cigarId: padron.id, unmatchedReason: null });
    // Nothing is left open on a row that resolved, so nothing is annotated —
    // including the parse the previous crawl may have left here.
    expect(match.suggestedParse).toBeNull();
  });

  it("keeps the breadcrumb trail on a clean link too", async () => {
    const vendorId = await makeVendor(`Breadcrumb Fox ${randomUUID()}`);
    await runIngest(
      deps(createMockFetcher(routes([PADRON_URL], { [PADRON_URL]: loadFixture("product-padron.html") })), null),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );
    const match = (await matchesFor(vendorId))[0]!;
    expect(match.categoryPath).toEqual(["Home", "Shop", "Cigars", "Padron"]);
    // Null on a clean link: there is nothing for a curator to resolve, and a
    // stale parse would read as an open question that is not open.
    expect(match.suggestedParse).toBeNull();
  });

  // ------------------------------------------------------------------------
  // "Matching v2 re-decides CRAWLER-owned rows on re-crawl but never touches
  // agent/curator-decided rows."
  //
  // The re-decision is how the 42% slug disagreement heals without a migration,
  // which is exactly why the guard keeping it away from human verdicts matters
  // MORE now than it did when the matcher was static.
  // ------------------------------------------------------------------------
  it("re-decides a crawler-owned row and leaves an agent verdict untouched", async () => {
    const crawlerVendor = await makeVendor(`Redecide Crawler ${randomUUID()}`);
    const agentVendor = await makeVendor(`Redecide Agent ${randomUUID()}`);
    const map = routes([PADRON_URL], { [PADRON_URL]: loadFixture("product-padron.html") });

    await runIngest(deps(createMockFetcher(map), null), { adapter: foxCigar, vendorId: crawlerVendor, mode: "seed" });
    await runIngest(deps(createMockFetcher(map), null), { adapter: foxCigar, vendorId: agentVendor, mode: "seed" });

    // A crawler-owned row pointed at the wrong cigar: the next crawl must correct
    // it. This is the healing path.
    const decoy = (
      await pg.db
        .insert(cigars)
        .values({ canonicalName: `Decoy Row ${randomUUID()}`, verification: "unverified" })
        .returning({ id: cigars.id })
    )[0]!;
    await pg.db
      .update(listingMatches)
      .set({ cigarId: decoy.id, decidedBy: "crawler", status: "auto" })
      .where(eq(listingMatches.vendorId, crawlerVendor));

    // An agent's verdict on the same listing: unmatched, deliberately, forever
    // until a human changes its mind.
    await pg.db
      .update(listingMatches)
      .set({ cigarId: null, status: "unmatched", decidedBy: "agent" })
      .where(eq(listingMatches.vendorId, agentVendor));

    await runIngest(deps(createMockFetcher(map), null), { adapter: foxCigar, vendorId: crawlerVendor, mode: "seed" });
    await runIngest(deps(createMockFetcher(map), null), { adapter: foxCigar, vendorId: agentVendor, mode: "seed" });

    const healed = (await matchesFor(crawlerVendor))[0]!;
    expect(healed.cigarId).not.toBe(decoy.id);
    expect(healed.status).toBe("auto");

    const respected = (await matchesFor(agentVendor))[0]!;
    expect(respected).toMatchObject({ cigarId: null, status: "unmatched", decidedBy: "agent" });
  });

  // THE SAME GUARD ON THE ANNOTATION PATH, which is new and therefore unproven
  // by the case above. `existingCrawlerLink` deliberately cannot see a human's
  // row, so a no-anchor crawl computes a full triage verdict for one — reason and
  // parse and all — and only `upsertListingMatch` stops it landing. A parse
  // smeared onto an agent's row would be the crawler annotating a question a
  // human already closed.
  it("annotates nothing on an agent-owned row when the title anchors no brand", async () => {
    const vendorId = await makeVendor(`Agent No Anchor ${randomUUID()}`);
    const held = (
      await pg.db
        .insert(cigars)
        .values({ canonicalName: `Agent Held Leaf ${randomUUID()}`, verification: "verified" })
        .returning({ id: cigars.id })
    )[0]!;
    await pg.db.insert(listingMatches).values({
      vendorId,
      listingKey: "/shop/vuelta-abajo-reserva-especial-robusto/",
      cigarId: held.id,
      status: "confirmed",
      decidedBy: "agent",
      createdAt: now(),
      updatedAt: now(),
    });

    const run = await runIngest(
      deps(createMockFetcher(routes([UNKNOWN_URL], { [UNKNOWN_URL]: loadFixture("product-unknown-marca.html") })), null),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );

    const match = (await matchesFor(vendorId))[0]!;
    expect(match).toMatchObject({ status: "confirmed", cigarId: held.id, decidedBy: "agent" });
    expect(match.unmatchedReason).toBeNull();
    expect(match.suggestedParse).toBeNull();
    // Nor is a human's row counted as a link the CRAWLER is holding: the counter
    // reads `existingCrawlerLink`, which cannot see this row, and a debt figure
    // that included rows the crawler may not rewrite would overstate what a Wave 3
    // alias session could actually recover.
    expect(run.stats.linksAnnotated).toBeUndefined();
    // The offer is a fact about the LISTING — this shop, this price, today — and
    // is written whoever owns the verdict.
    expect(run.stats.offersWritten).toBe(1);
  });

  // ------------------------------------------------------------------------
  // Trigram is demoted to a tie-breaker WITHIN one marca. A leaf of another
  // brand can no longer be reached however similar its name.
  // ------------------------------------------------------------------------
  it("never links a listing to a leaf of a different marca", async () => {
    const vendorId = await makeVendor(`Scope Fox ${randomUUID()}`);
    const otherBrandId = await seedBrand(`Impostor Marca ${randomUUID().slice(0, 8)}`);
    // A near-identical name, deliberately, under the wrong brand: under v1 this
    // is the row trigram would have handed back.
    const impostor = (
      await pg.db
        .insert(cigars)
        .values({
          canonicalName: "Padron 1964 Anniversary Maduro Torpedoo",
          brandId: otherBrandId,
          verification: "verified",
        })
        .returning({ id: cigars.id })
    )[0]!;

    await runIngest(
      deps(createMockFetcher(routes([PADRON_URL], { [PADRON_URL]: loadFixture("product-padron.html") })), null),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );

    const match = (await matchesFor(vendorId))[0]!;
    expect(match.cigarId).not.toBe(impostor.id);
  });

  // ------------------------------------------------------------------------
  // "Seed mode never mints from an unparsed title again" also covers the
  // sampler, which spans blends and therefore names no single leaf.
  // ------------------------------------------------------------------------
  it("never mints from a sampler listing", async () => {
    const vendorId = await makeVendor(`Sampler Fox ${randomUUID()}`);
    const before = (await pg.db.select({ id: cigars.id }).from(cigars)).length;
    await runIngest(
      deps(
        createMockFetcher(
          routes(["https://foxcigar.com/shop/fox-5-cigar-sampler/"], {
            "https://foxcigar.com/shop/fox-5-cigar-sampler/": loadFixture("product-sampler.html"),
          }),
        ),
        null,
      ),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );
    expect((await pg.db.select({ id: cigars.id }).from(cigars)).length).toBe(before);
  });

  // ------------------------------------------------------------------------
  // Line and blend resolution through the registry, end to end. This is the
  // shape Wave 3 curation produces and Wave 4 reads.
  // ------------------------------------------------------------------------
  it("resolves through line and blend when the registry carries them", async () => {
    const vendorId = await makeVendor(`Structured Depth Fox ${randomUUID()}`);
    const lineRow = (
      await pg.db
        .insert(lines)
        .values({
          brandId: padronBrandId,
          name: "1964 Anniversary Series",
          slug: "1964-anniversary-series",
          aliases: ["1964-anniversary-series", "1964-anniversary"],
        })
        .returning({ id: lines.id })
    )[0]!;
    const blendRow = (
      await pg.db
        .insert(blends)
        .values({ lineId: lineRow.id, name: "Maduro", slug: "maduro", aliases: ["maduro"] })
        .returning({ id: blends.id })
    )[0]!;

    await runIngest(
      deps(createMockFetcher(routes([PADRON_URL], { [PADRON_URL]: loadFixture("product-padron.html") })), null),
      { adapter: foxCigar, vendorId, mode: "seed" },
    );

    const match = (await matchesFor(vendorId))[0]!;
    const linked = (await pg.db.select().from(cigars).where(eq(cigars.id, match.cigarId!)))[0]!;
    // Whether this run minted the row or linked one an earlier case created, the
    // resolved leaf must belong to the anchored marca.
    expect(linked.brandId).toBe(padronBrandId);
    void blendRow;
  });

  // ------------------------------------------------------------------------
  // THE LAST CHECK BEFORE A MINT. "This cigar is not in the catalog yet" is a
  // claim the scope query cannot make on its own: it only sees rows it can
  // attribute to the anchored marca, and 516 of prod's 570 unlinked rows are
  // attributable to none, because their names do not begin with the brand. A
  // brand that anchors, looks under itself, finds nothing and mints therefore
  // creates a second row for a cigar the catalog already holds — the exact
  // failure ADR-012 exists to end, arriving through the door built to stop it.
  // ------------------------------------------------------------------------

  // A Fox-shaped product page, built here because no recorded fixture has the
  // shape this case needs: a title that anchors a marca whose orphan row the
  // scope query is structurally blind to.
  const foxProductPage = (name: string, url: string): string =>
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<script type="application/ld+json">\n${JSON.stringify(
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: "https://foxcigar.com/" },
              { "@type": "ListItem", position: 2, name: "Shop", item: "https://foxcigar.com/shop/" },
              { "@type": "ListItem", position: 3, name: "Cigars", item: "https://foxcigar.com/shop/cigars/" },
              { "@type": "ListItem", position: 4, name },
            ],
          },
          {
            "@type": "Product",
            name,
            url,
            sku: "AF-OPUSX-PERF2",
            offers: [
              {
                "@type": "Offer",
                priceSpecification: [{ "@type": "PriceSpecification", price: "32.00", priceCurrency: "USD" }],
                availability: "https://schema.org/InStock",
                url,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n</script>\n</head>\n<body><h1>${name}</h1></body>\n</html>\n`;

  it("asks instead of minting when an unlinked row already carries the parsed name", async () => {
    const vendorId = await makeVendor(`Orphan Collision Fox ${randomUUID()}`);
    const fuenteBrandId = await seedBrand("Arturo Fuente");

    // THE ROW NEITHER HALF OF THE SCOPE QUERY CAN SEE: `brand_id` is null, so the
    // brand filter misses it, and its name does not begin with the marca, so the
    // bridge clause's prefix misses it too. 516 prod rows look exactly like this.
    await pg.db
      .insert(cigars)
      .values({ canonicalName: "Fuente Fuente OpusX Perfecxion No. 2", verification: "unverified" });

    const url = "https://foxcigar.com/shop/arturo-fuente-fuente-fuente-opusx-perfecxion-no-2/";
    const title = "Arturo Fuente Fuente Fuente OpusX Perfecxion No. 2";
    const before = (await pg.db.select({ id: cigars.id }).from(cigars)).length;

    const run = await runIngest(deps(createMockFetcher(routes([url], { [url]: foxProductPage(title, url) })), null), {
      adapter: foxCigar,
      vendorId,
      mode: "seed",
    });

    // The brand DID anchor and the scope DID come back empty — the arm that mints
    // — and the unscoped pass turned the mint into a question.
    expect(run.stats.linksNoAnchor).toBeUndefined();
    expect(run.stats.cigarsCreated).toBe(0);
    expect(run.stats.linksAmbiguous).toBe(1);
    expect((await pg.db.select({ id: cigars.id }).from(cigars)).length).toBe(before);

    const match = (await matchesFor(vendorId))[0]!;
    expect(match).toMatchObject({ status: "unmatched", cigarId: null, unmatchedReason: "ambiguous" });
    // The parse names the marca it did anchor, so the curator resolving this row
    // has the one fact that makes the orphan attachable.
    expect(match.suggestedParse).toMatchObject({ reason: "ambiguous", brandId: fuenteBrandId, cleanedName: title });
  });
});
