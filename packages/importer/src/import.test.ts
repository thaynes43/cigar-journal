import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { users, smokes, purchases, vendors, cigars, idempotencyKeys } from "@cj/db";
import type { Deps, Principal } from "@cj/domain";
import { runImport } from "./run.js";
import { writePurchase } from "./purchase-writer.js";

// End-to-end against a real embedded Postgres (migrated to head): a full import
// of the fixture archive, then a second identical run to prove idempotency.

const DOCS = fileURLToPath(new URL("./__fixtures__/archive/docs", import.meta.url));

describe("runImport (embedded Postgres)", () => {
  let pg: TestPostgres;
  let deps: Deps;
  let principal: Principal;

  const countSmokes = async (): Promise<number> => (await pg.db.select().from(smokes)).length;
  const countPurchases = async (): Promise<number> => (await pg.db.select().from(purchases)).length;
  const countVendors = async (): Promise<number> => (await pg.db.select().from(vendors)).length;
  const countKeys = async (): Promise<number> => (await pg.db.select().from(idempotencyKeys)).length;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const inserted = await pg.db
      .insert(users)
      .values({ email: "owner@example.com", role: "admin", journalVisibility: "public" })
      .returning({ id: users.id });
    principal = { userId: inserted[0]!.id, role: "admin" };
    deps = { db: pg.db, now: () => new Date("2026-09-01T00:00:00.000Z") };
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("imports smokes via the domain and purchases via the owned writer", async () => {
    const report = await runImport({ docsDir: DOCS, deps, principal, userEmail: "owner@example.com", dryRun: false });

    // 6 smokes across 4 pages; 3 pages skipped (2 malformed, 1 stub).
    expect(report.smokes.imported).toBe(6);
    expect(report.smokes.skipped).toBe(3);
    expect(report.smokes.replayed).toBe(0);
    expect(report.purchases.imported).toBe(12);
    expect(report.vendorsCreated).toBe(5);

    expect(await countSmokes()).toBe(6);
    expect(await countPurchases()).toBe(12);
    expect(await countVendors()).toBe(5);
    expect(await countKeys()).toBe(18); // 6 smoke + 12 purchase keys

    // Vendors carried over disabled + owner-added, under the registry's canonical
    // name — the archive column says "Fox", the shop is "Fox Cigar" (#270).
    const fox = (await pg.db.select().from(vendors).where(eq(vendors.name, "Fox Cigar")))[0]!;
    expect(fox.approvalStatus).toBe("owner-added");
    expect(fox.crawlEnabled).toBe(false);
    expect(fox.displayEnabled).toBe(false);
    expect(await pg.db.select().from(vendors).where(eq(vendors.name, "Fox"))).toHaveLength(0);

    // God of Fire: rating attached (82), day-precision legacy-document provenance,
    // prose preserved verbatim in originalMarkdown, narrative left null, nothing synthesized.
    const gof = (
      await pg.db.select().from(smokes).where(eq(smokes.provenanceClient, "nc-reviews/god-of-fire/series-b.md#1"))
    )[0]!;
    expect(gof.rating).toBe(82);
    expect(gof.smokedAtSource).toBe("legacy-document");
    expect(gof.smokedAtPrecision).toBe("day");
    expect(gof.provenanceSource).toBe("legacy-import");
    expect(gof.originalMarkdown).toContain("## Review 1 - Double Robusto - 11/16/2025");
    expect(gof.journalNarrative).toBeNull();
    expect(gof.journalTitle).toBe("Series B 11/16");
    expect(gof.overallDescriptors).toEqual([]);

    // The malformed LFD page produced no smoke and a needs-review line.
    const laNox = await pg.db
      .select()
      .from(smokes)
      .where(eq(smokes.provenanceClient, "nc-reviews/la-flor-dominicana/la-nox.md#1"));
    expect(laNox).toHaveLength(0);
    expect(report.needsReview.some((n) => n.ref.includes("la-nox") && n.reason.includes("Rview"))).toBe(true);

    // Purchase links to the SAME cigar the review created — no duplicate catalog entry.
    const cigar = (
      await pg.db.select().from(cigars).where(eq(cigars.canonicalName, "Drew Estate Liga Privada No. 9"))
    )[0]!;
    expect(cigar.verification).toBe("unverified");
    expect((await pg.db.select().from(smokes).where(eq(smokes.cigarId, cigar.id)))).toHaveLength(2);
    expect((await pg.db.select().from(purchases).where(eq(purchases.cigarId, cigar.id)))).toHaveLength(1);

    // Brand-drift and placeholder needs-review surfaced for purchases.
    expect(report.needsReview.some((n) => n.reason.includes('brand drift "LFD"'))).toBe(true);
    expect(report.needsReview.some((n) => n.reason.includes("Backordered"))).toBe(true);
  });

  it("is idempotent: a second identical run duplicates nothing", async () => {
    const report = await runImport({ docsDir: DOCS, deps, principal, userEmail: "owner@example.com", dryRun: false });
    expect(report.smokes.imported).toBe(0);
    expect(report.smokes.replayed).toBe(6);
    expect(report.purchases.imported).toBe(0);
    expect(report.purchases.replayed).toBe(12);

    expect(await countSmokes()).toBe(6);
    expect(await countPurchases()).toBe(12);
    expect(await countVendors()).toBe(5);
    expect(await countKeys()).toBe(18);
  });

  // The owner merged the archive's shorthand retailers onto the registry's names
  // by hand (#270); an import that minted "Fox" again would split one shop's
  // purchase history back in two the next time the ledger ran.
  it("resolves a shorthand retailer onto the canonical vendor row, creating nothing", async () => {
    const before = await countVendors();
    const result = await writePurchase(
      deps,
      principal,
      {
        rowNumber: 99,
        cigar: "Liga Privada No. 9",
        brand: "Drew Estate",
        canonicalName: "Drew Estate Liga Privada No. 9",
        packaging: "Loose",
        quantity: 1,
        vitola: "Toro",
        type: "NC",
        lengthInches: 6,
        ringGauge: 52,
        purchasedAt: "2026-09-02",
        humidorAt: null,
        boxDate: null,
        retailer: "Fox",
        pricePerStick: null,
        notes: null,
        placeholderNotes: [],
        brandDrift: null,
      },
      { clientRequestId: "alias-fox-purchase", ref: "purchase-history.md#99" },
    );

    expect(result.status).toBe("imported");
    expect(result.vendorCreated).toBe(false);
    expect(await countVendors()).toBe(before);

    const fox = (await pg.db.select().from(vendors).where(eq(vendors.name, "Fox Cigar")))[0]!;
    const landed = await pg.db.select().from(purchases).where(eq(purchases.vendorId, fox.id));
    expect(landed.some((row) => row.purchasedAt === "2026-09-02")).toBe(true);
  });

  it("dry-run classifies already-imported rows and writes nothing", async () => {
    const before = await countSmokes();
    const report = await runImport({ docsDir: DOCS, deps, principal, userEmail: "owner@example.com", dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.smokes.replayed).toBe(6);
    expect(report.smokes.imported).toBe(0);
    expect(report.purchases.replayed).toBe(12);
    expect(report.plan.length).toBeGreaterThan(0);
    expect(await countSmokes()).toBe(before);
  });
});
