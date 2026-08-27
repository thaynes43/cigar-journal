import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { users, purchases, cigars } from "@cj/db";
import type { Deps, Principal } from "@cj/domain";
import { runImport } from "./run.js";
import { reconcileLedger } from "./ledger-run.js";

// End-to-end against a real embedded Postgres (migrated to head): seed the
// archive purchases through the existing importer path, then reconcile the
// ledger snapshot against them. Proves matched rows are skipped, unmatched rows
// insert once, a second run replays without duplicating, and the same cigar
// bought on two different dates does not false-match.

const DOCS = fileURLToPath(new URL("./__fixtures__/archive/docs", import.meta.url));
const CSV = fileURLToPath(
  new URL("./__fixtures__/archive/ledger/ledger-fixture.csv", import.meta.url),
);

describe("reconcileLedger (embedded Postgres)", () => {
  let pg: TestPostgres;
  let deps: Deps;
  let principal: Principal;

  const countPurchases = async (): Promise<number> => (await pg.db.select().from(purchases)).length;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const inserted = await pg.db
      .insert(users)
      .values({ email: "owner@example.com", role: "admin", journalVisibility: "public" })
      .returning({ id: users.id });
    principal = { userId: inserted[0]!.id, role: "admin" };
    deps = { db: pg.db, now: () => new Date("2026-09-01T00:00:00.000Z") };

    // Seed the 12 archive purchases via the existing importer path.
    await runImport({
      docsDir: DOCS,
      deps,
      principal,
      userEmail: "owner@example.com",
      dryRun: false,
    });
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("dry-run classifies matched / insert / needs-review without writing", async () => {
    const before = await countPurchases();
    const report = await reconcileLedger({
      csvPath: CSV,
      archiveDocsDir: DOCS,
      deps,
      principal,
      userEmail: "owner@example.com",
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.totalRows).toBe(9);
    expect(report.counts.matched).toBe(1); // Liga Privada No. 9 Loose/2/8-6 matches the archive purchase
    expect(report.counts.inserted).toBe(7);
    expect(report.counts.skipped).toBe(1); // the "???" brand row with no cigar name
    expect(await countPurchases()).toBe(before); // nothing written

    // needs-review surfaces every quirk on the rows we would insert.
    const reasons = report.needsReview.map((n) => n.reason);
    expect(reasons.some((r) => r.includes('brand drift "Rockey Patel"'))).toBe(true);
    expect(reasons.some((r) => r.includes("Backordered"))).toBe(true);
    expect(reasons.some((r) => r.includes("Stuck"))).toBe(true);
    expect(reasons.some((r) => r.includes("malformed size"))).toBe(true);
    expect(reasons.some((r) => r.includes('brand "???"'))).toBe(true);
    expect(reasons.some((r) => r.includes("no cigar name"))).toBe(true);
  });

  it("apply inserts only the unmatched rows and never touches existing purchases", async () => {
    const before = await countPurchases();
    const report = await reconcileLedger({
      csvPath: CSV,
      archiveDocsDir: DOCS,
      deps,
      principal,
      userEmail: "owner@example.com",
      dryRun: false,
    });

    expect(report.counts.matched).toBe(1);
    expect(report.counts.inserted).toBe(7);
    expect(report.counts.skipped).toBe(1);
    expect(await countPurchases()).toBe(before + 7);

    // Same cigar bought on a different date is a distinct purchase, not a match.
    const liga = (
      await pg.db
        .select()
        .from(cigars)
        .where(eq(cigars.canonicalName, "Drew Estate Liga Privada No. 9"))
    )[0]!;
    expect(await pg.db.select().from(purchases).where(eq(purchases.cigarId, liga.id))).toHaveLength(
      2,
    );

    // Aging free text lands in notes verbatim; $-PPS coerced to numeric. The
    // Cuban-half rows swap brand/mark into the Cigar/Brand columns, so the
    // importer's `<Brand> <Cigar>` convention yields "No 3 Ramon Allones" —
    // imported faithfully for the curator, never second-guessed.
    const ramon = (
      await pg.db.select().from(cigars).where(eq(cigars.canonicalName, "No 3 Ramon Allones"))
    )[0]!;
    const ramonBuy = (
      await pg.db.select().from(purchases).where(eq(purchases.cigarId, ramon.id))
    )[0]!;
    expect(ramonBuy.notes).toBe('1 Month rest from travel - "RASS"');
    expect(ramonBuy.pricePerStick).toBe("45");

    // "???" brand with a cigar name → cigar created unverified with a null brand.
    const vega = (
      await pg.db.select().from(cigars).where(eq(cigars.canonicalName, "Vega Fina"))
    )[0]!;
    expect(vega.verification).toBe("unverified");
    expect(vega.brand).toBeNull();

    // "???" brand with no cigar name created nothing.
    const empties = await pg.db.select().from(cigars).where(eq(cigars.canonicalName, ""));
    expect(empties).toHaveLength(0);
  });

  it("is idempotent: a second apply replays every insert and duplicates nothing", async () => {
    const before = await countPurchases();
    const report = await reconcileLedger({
      csvPath: CSV,
      archiveDocsDir: DOCS,
      deps,
      principal,
      userEmail: "owner@example.com",
      dryRun: false,
    });

    expect(report.counts.matched).toBe(1);
    expect(report.counts.inserted).toBe(0);
    expect(report.counts.replayed).toBe(7);
    expect(report.counts.skipped).toBe(1);
    expect(await countPurchases()).toBe(before); // no duplicates
  });
});
