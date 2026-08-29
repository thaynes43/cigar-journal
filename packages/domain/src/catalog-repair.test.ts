import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { vendors, offers, enrichmentRequests, productPhotos, cigars } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { requestCigarEnrichment } from "./enrichment.js";
import { updateCigar } from "./update-cigar.js";
import { recordPrice } from "./record-price.js";
import { getCigar, getCigarOffers } from "./reads.js";
import type { Principal } from "./deps.js";
import { CigarNotFoundError, ValidationError, IdempotencyConflictError } from "./errors.js";

// Catalog repair + price observations (ADR-009), end to end over embedded Postgres.
describe("catalog repair + price observations", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("repair@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function addVendor(name: string): Promise<string> {
    const [v] = await h.deps.db.insert(vendors).values({ name }).returning({ id: vendors.id });
    return v!.id;
  }

  // ---- request_cigar_enrichment --------------------------------------------

  describe("requestCigarEnrichment", () => {
    it("queues a sparse cigar, then reports already_queued on repeat", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Sparse One", verification: "unverified" });

      const first = await requestCigarEnrichment(h.deps, user, { cigarId });
      expect(first.status).toBe("queued");
      expect(first.queued).toBe(true);
      expect(first.missingFields).toContain("dimensions");
      expect(first.missingFields).toContain("productPhoto");
      expect(first.verification).toBe("unverified");
      expect(await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId))).toHaveLength(1);

      const second = await requestCigarEnrichment(h.deps, user, { cigarId });
      expect(second.status).toBe("already_queued");
      expect(second.queued).toBe(false);
      // Dedupe held — still exactly one request row.
      expect(await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId))).toHaveLength(1);
    });

    it("reports not_needed for a complete cigar (photo + full dimensions)", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: "Complete One",
        lengthInches: "6.0",
        ringGauge: 52,
      });
      await h.deps.db.insert(productPhotos).values({
        cigarId,
        objectKey: `k-${cigarId}`,
        thumbKey: `t-${cigarId}`,
        contentType: "image/jpeg",
        width: 10,
        height: 10,
        bytes: 100,
      });

      const result = await requestCigarEnrichment(h.deps, user, { cigarId });
      expect(result.status).toBe("not_needed");
      expect(result.queued).toBe(false);
      expect(await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId))).toHaveLength(0);
    });

    it("rejects an unknown cigar", async () => {
      await expect(
        requestCigarEnrichment(h.deps, user, { cigarId: "00000000-0000-0000-0000-000000000000" }),
      ).rejects.toBeInstanceOf(CigarNotFoundError);
    });
  });

  // ---- update_cigar ---------------------------------------------------------

  describe("updateCigar", () => {
    it("fills only null fields, skips non-null ones, and never overwrites", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Fill Me", brand: "Existing Brand", verification: "unverified" });

      const result = await updateCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "New Brand", line: "New Line", vitola: { lengthInches: 5.5, ringGauge: 50 } },
      });
      // brand was already set → skipped; line + dims were null → written.
      expect(result.skipped).toContain("brand");
      expect(result.changedFields).toEqual(
        expect.arrayContaining(["line", "vitola.lengthInches", "vitola.ringGauge"]),
      );
      expect(result.changedFields).not.toContain("brand");

      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.brand).toBe("Existing Brand"); // untouched
      expect(row!.line).toBe("New Line");
      expect(Number(row!.lengthInches)).toBe(5.5);
      expect(row!.ringGauge).toBe(50);
    });

    it("writes nothing to a verified cigar — all fields skipped", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Locked", verification: "verified" });
      const result = await updateCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "Nope", blendNotes: "should not land" },
      });
      expect(result.changedFields).toEqual([]);
      expect(result.skipped).toEqual(expect.arrayContaining(["brand", "blendNotes"]));
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.brand).toBeNull();
      expect(row!.blendNotes).toBeNull();
    });

    it("replays on the same clientRequestId and conflicts on reuse for a different intent", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Replayable", verification: "unverified" });
      const rid = newRequestId();
      const first = await updateCigar(h.deps, user, { clientRequestId: rid, cigarId, fields: { line: "L1" } });
      expect(first.replayed).toBe(false);
      const replay = await updateCigar(h.deps, user, { clientRequestId: rid, cigarId, fields: { line: "L1" } });
      expect(replay.replayed).toBe(true);
      await expect(
        updateCigar(h.deps, user, { clientRequestId: rid, cigarId, fields: { line: "different" } }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });
  });

  // ---- record_price ---------------------------------------------------------

  describe("recordPrice", () => {
    it("records a vendor-attributed observation with a computed per-stick", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Priced One" });
      await addVendor("Small Batch Cigar");

      const result = await recordPrice(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        vendorName: "small batch cigar", // case-insensitive registry match
        price: 334,
        packaging: "box",
        sticksPerPackage: 20,
      });
      expect(result.recorded).toBe(true);
      expect(result.deduped).toBe(false);
      expect(result.pricePerStick).toBeCloseTo(16.7, 2);
      expect(result.source.vendorName).toBe("Small Batch Cigar");
      expect(result.source.name).toBeNull();

      const [row] = await h.deps.db.select().from(offers).where(eq(offers.cigarId, cigarId));
      expect(row!.vendorId).not.toBeNull();
      expect(row!.pricePerStickCents).toBe(1670);
      expect(row!.packaging).toBe("box");
    });

    it("requires a source when no registry vendor matches, and keeps an unmatched name as the source", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Needs Source" });

      await expect(
        recordPrice(h.deps, user, { clientRequestId: newRequestId(), cigarId, price: 12 }),
      ).rejects.toBeInstanceOf(ValidationError);

      const adHoc = await recordPrice(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        vendorName: "Some Random Shop", // not in the registry → becomes the ad-hoc source
        sourceUrl: "https://example.com/x",
        price: 15,
        packaging: "single",
        sticksPerPackage: 1,
      });
      expect(adHoc.source.vendorId).toBeNull();
      expect(adHoc.source.name).toBe("Some Random Shop");
      const [row] = await h.deps.db
        .select()
        .from(offers)
        .where(and(eq(offers.cigarId, cigarId), eq(offers.sourceName, "Some Random Shop")));
      expect(row!.vendorId).toBeNull();
      expect(row!.sourceName).toBe("Some Random Shop");
    });

    it("dedupes an identical observation within 24h; a changed price appends", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Dedupe One" });
      const base = {
        cigarId,
        sourceName: "Vendor X",
        price: 20,
        packaging: "box",
        sticksPerPackage: 20,
        observedAt: "2026-08-29T10:00:00Z",
      };

      const a = await recordPrice(h.deps, user, { clientRequestId: newRequestId(), ...base });
      expect(a.recorded).toBe(true);

      // Identical content, different envelope, within 24h → deduped (no new row).
      const b = await recordPrice(h.deps, user, {
        clientRequestId: newRequestId(),
        ...base,
        observedAt: "2026-08-29T18:00:00Z",
      });
      expect(b.deduped).toBe(true);
      expect(b.recorded).toBe(false);
      expect(await h.deps.db.select().from(offers).where(eq(offers.cigarId, cigarId))).toHaveLength(1);

      // A changed price always inserts.
      const c = await recordPrice(h.deps, user, {
        clientRequestId: newRequestId(),
        ...base,
        price: 22,
        observedAt: "2026-08-29T19:00:00Z",
      });
      expect(c.recorded).toBe(true);
      expect(await h.deps.db.select().from(offers).where(eq(offers.cigarId, cigarId))).toHaveLength(2);
    });

    it("surfaces the observation on get_cigar pricing (per-stick WITH packaging) and get_cigar_offers", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Surfaced One", verification: "unverified" });
      h.setNow(new Date("2026-08-29T12:00:00Z"));

      // A box (cheaper per stick) and a single (dearer per stick) from two sources.
      await recordPrice(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        sourceName: "Box Shop",
        price: 334,
        packaging: "box",
        sticksPerPackage: 20,
        observedAt: "2026-08-29T11:00:00Z",
        inStock: true,
      });
      await recordPrice(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        sourceName: "Single Shop",
        price: 18,
        packaging: "single",
        sticksPerPackage: 1,
        observedAt: "2026-08-29T11:30:00Z",
        inStock: true,
      });

      const detail = await getCigar(h.deps, user, { cigarId });
      expect(detail.pricing).not.toBeNull();
      expect(detail.pricing!.lowest).toEqual({
        perStick: true,
        amount: 16.7,
        packaging: "box",
        sticksPerPackage: 20,
      });
      expect(detail.pricing!.sourceCount).toBe(2);
      expect(detail.pricing!.observationCount).toBe(2);
      expect(detail.pricing!.refreshRecommended).toBe(false);
      // Sparse cigar → enrichment recommended.
      expect(detail.enrichment.recommended).toBe(true);

      const list = await getCigarOffers(h.deps, { cigarId });
      expect(list).toHaveLength(2);
      // Cheapest per-stick leads.
      expect(list[0]!.vendor).toBe("Box Shop");
      expect(list[0]!.pricePerStick).toBeCloseTo(16.7, 2);
      expect(list[0]!.packaging).toBe("box");
      expect(list[0]!.isRegistryVendor).toBe(false);
    });

    it("flags refreshRecommended when the latest observation is older than 30 days", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Stale One" });
      await recordPrice(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        sourceName: "Old Shop",
        price: 10,
        packaging: "single",
        sticksPerPackage: 1,
        observedAt: "2026-06-01T00:00:00Z",
      });
      h.setNow(new Date("2026-08-29T12:00:00Z"));
      const detail = await getCigar(h.deps, user, { cigarId });
      expect(detail.pricing!.refreshRecommended).toBe(true);
    });
  });
});
