import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  cigars,
  smokes,
  purchases,
  listingMatches,
  offers,
  productPhotos,
  enrichmentRequests,
  vendors,
  auditLog,
} from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { mergeCigars, verifyCigar, curationQueue } from "./curation.js";
import type { Principal } from "./index.js";
import { UnauthorizedError, CigarNotFoundError, ValidationError } from "./errors.js";

describe("curation", () => {
  let h: DomainHarness;
  let admin: Principal;
  let user: Principal;
  let vendorId: string;

  beforeAll(async () => {
    h = await createHarness();
    admin = await h.createUser("curator@example.com", "admin");
    user = await h.createUser("member@example.com");
    const [v] = await h.deps.db.insert(vendors).values({ name: "Test Vendor" }).returning({ id: vendors.id });
    vendorId = v!.id;
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // --- seeding helpers ------------------------------------------------------

  async function seedUnverified(name: string, createdAt?: Date): Promise<string> {
    const [row] = await h.deps.db
      .insert(cigars)
      .values({ canonicalName: name, verification: "unverified", ...(createdAt ? { createdAt } : {}) })
      .returning({ id: cigars.id });
    return row!.id;
  }

  async function addSmoke(cigarId: string, owner = user): Promise<string> {
    const [row] = await h.deps.db
      .insert(smokes)
      .values({ userId: owner.userId, cigarId, provenanceSource: "manual" })
      .returning({ id: smokes.id });
    return row!.id;
  }

  async function addPurchase(cigarId: string, owner = user): Promise<string> {
    const [row] = await h.deps.db
      .insert(purchases)
      .values({ userId: owner.userId, cigarId })
      .returning({ id: purchases.id });
    return row!.id;
  }

  async function addOffer(cigarId: string, listingKey: string): Promise<string> {
    const [match] = await h.deps.db
      .insert(listingMatches)
      .values({ vendorId, listingKey, cigarId, status: "auto" })
      .returning({ id: listingMatches.id });
    const [offer] = await h.deps.db
      .insert(offers)
      .values({ vendorId, listingMatchId: match!.id })
      .returning({ id: offers.id });
    return offer!.id;
  }

  async function addProductPhoto(cigarId: string, tag: string): Promise<void> {
    await h.deps.db.insert(productPhotos).values({
      cigarId,
      objectKey: `obj/${tag}`,
      thumbKey: `thumb/${tag}`,
      contentType: "image/webp",
      width: 800,
      height: 600,
      bytes: 1234,
    });
  }

  async function addEnrichment(cigarId: string): Promise<string> {
    const [row] = await h.deps.db
      .insert(enrichmentRequests)
      .values({ cigarId })
      .returning({ id: enrichmentRequests.id });
    return row!.id;
  }

  // --- mergeCigars ----------------------------------------------------------

  describe("mergeCigars", () => {
    it("rejects a non-admin principal", async () => {
      const source = await seedUnverified("Merge Reject Source");
      const target = await seedUnverified("Merge Reject Target");
      const error = await mergeCigars(h.deps, user, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
      // Nothing happened — both rows survive.
      expect(await h.deps.db.select().from(cigars).where(eq(cigars.id, source))).toHaveLength(1);
    });

    it("re-points every referencing table, deletes the source, and audits cigar.merge", async () => {
      const source = await seedUnverified("Padron Dupe Source");
      const target = await seedUnverified("Padron Keeper Target");

      const smokeId = await addSmoke(source);
      const purchaseId = await addPurchase(source);
      await addOffer(source, "sku-merge-1");
      const enrichmentId = await addEnrichment(source);
      // Only the source has a product photo → the target adopts it.
      await addProductPhoto(source, "merge-adopt");

      const result = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });

      expect(result.replayed).toBe(false);
      expect(result.repointed).toEqual({
        smokes: 1,
        purchases: 1,
        listingMatches: 1,
        productPhotos: 1,
        enrichmentRequests: 1,
      });

      // Source cigar is gone.
      expect(await h.deps.db.select().from(cigars).where(eq(cigars.id, source))).toHaveLength(0);

      // Every reference now points at the target.
      const [smoke] = await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId));
      expect(smoke!.cigarId).toBe(target);
      const [purchase] = await h.deps.db.select().from(purchases).where(eq(purchases.id, purchaseId));
      expect(purchase!.cigarId).toBe(target);
      const matchRows = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.cigarId, target));
      expect(matchRows).toHaveLength(1);
      const [enrichment] = await h.deps.db
        .select()
        .from(enrichmentRequests)
        .where(eq(enrichmentRequests.id, enrichmentId));
      expect(enrichment!.cigarId).toBe(target);
      const photoRows = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, target));
      expect(photoRows).toHaveLength(1);

      // Audit row with before/after snapshots.
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.merge"));
      const audit = audits.find((a) => (a.after as { deletedSourceId?: string }).deletedSourceId === source);
      expect(audit).toBeDefined();
      expect(audit!.actor).toBe("web");
      expect((audit!.before as { source: { id: string } }).source.id).toBe(source);
      expect((audit!.before as { target: { id: string } }).target.id).toBe(target);
      expect((audit!.after as { repointed: { smokes: number } }).repointed.smokes).toBe(1);
    });

    it("keeps the target's own photo when it already has one (source photo discarded)", async () => {
      const source = await seedUnverified("Photo Source Loses");
      const target = await seedUnverified("Photo Target Keeps");
      await addProductPhoto(source, "keep-src");
      await addProductPhoto(target, "keep-tgt");

      const result = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });
      expect(result.repointed.productPhotos).toBe(0);

      // Target still has exactly its own photo; the source's is gone with the row.
      const photos = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, target));
      expect(photos).toHaveLength(1);
      expect(photos[0]!.objectKey).toBe("obj/keep-tgt");
    });

    it("rejects a self-merge with a field-pathed validation_error", async () => {
      const cigarId = await seedUnverified("Self Merge Guard");
      const error = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: cigarId,
        targetCigarId: cigarId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields.some((f) => f.path === "targetCigarId")).toBe(true);
    });

    it("errors cigar_not_found when either side is missing", async () => {
      const target = await seedUnverified("Merge Exists Target");
      const error = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: "00000000-0000-0000-0000-000000000000",
        targetCigarId: target,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CigarNotFoundError);
    });

    it("replays an identical retry without re-running the merge", async () => {
      const source = await seedUnverified("Replay Merge Source");
      const target = await seedUnverified("Replay Merge Target");
      await addSmoke(source);
      const input = {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      };
      const first = await mergeCigars(h.deps, admin, input);
      const second = await mergeCigars(h.deps, admin, input);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.repointed).toEqual(first.repointed);
      // Exactly one cigar.merge audit row for this source.
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.merge"));
      const forSource = audits.filter((a) => (a.after as { deletedSourceId?: string }).deletedSourceId === source);
      expect(forSource).toHaveLength(1);
    });
  });

  // --- verifyCigar ----------------------------------------------------------

  describe("verifyCigar", () => {
    it("rejects a non-admin principal", async () => {
      const cigarId = await seedUnverified("Verify Reject");
      const error = await verifyCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.verification).toBe("unverified");
    });

    it("flips verification to verified and audits cigar.verify", async () => {
      const cigarId = await seedUnverified("Verify Me Now");
      const result = await verifyCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId });
      expect(result.verification).toBe("verified");
      expect(result.replayed).toBe(false);

      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.verification).toBe("verified");

      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.verify"));
      const audit = audits.find((a) => (a.after as { id?: string }).id === cigarId);
      expect(audit).toBeDefined();
      expect(audit!.actor).toBe("web");
      expect((audit!.before as { verification: string }).verification).toBe("unverified");
      expect((audit!.after as { verification: string }).verification).toBe("verified");
    });

    it("errors cigar_not_found for a missing cigar", async () => {
      const error = await verifyCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId: "00000000-0000-0000-0000-000000000000",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CigarNotFoundError);
    });

    it("replays an identical retry", async () => {
      const cigarId = await seedUnverified("Verify Replay");
      const input = { clientRequestId: newRequestId(), cigarId };
      const first = await verifyCigar(h.deps, admin, input);
      const second = await verifyCigar(h.deps, admin, input);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.verify"));
      const forCigar = audits.filter((a) => (a.after as { id?: string }).id === cigarId);
      expect(forCigar).toHaveLength(1);
    });
  });

  // --- curationQueue --------------------------------------------------------

  describe("curationQueue", () => {
    it("rejects a non-admin principal", async () => {
      const error = await curationQueue(h.deps, user).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("reports unverified rows oldest-first with smoke/purchase/offer counts", async () => {
      const older = await seedUnverified("Queue Older Entry", new Date("2020-01-01T00:00:00Z"));
      const newer = await seedUnverified("Queue Newer Entry", new Date("2020-06-01T00:00:00Z"));
      await addSmoke(older);
      await addSmoke(older);
      await addPurchase(older);
      await addOffer(older, "sku-queue-1");

      const queue = await curationQueue(h.deps, admin);
      const olderRow = queue.unverified.find((c) => c.cigarId === older);
      const newerRow = queue.unverified.find((c) => c.cigarId === newer);
      expect(olderRow).toBeDefined();
      expect(newerRow).toBeDefined();
      expect(olderRow).toMatchObject({ smokeCount: 2, purchaseCount: 1, offerCount: 1 });
      expect(newerRow).toMatchObject({ smokeCount: 0, purchaseCount: 0, offerCount: 0 });

      // Oldest-first: the older seeded row precedes the newer one in the list.
      const olderIdx = queue.unverified.findIndex((c) => c.cigarId === older);
      const newerIdx = queue.unverified.findIndex((c) => c.cigarId === newer);
      expect(olderIdx).toBeLessThan(newerIdx);
    });

    it("surfaces near-duplicate pairs (accent variant) above the similarity threshold", async () => {
      const plain = await seedUnverified("Padron 1964 Anniversary Maduro Imperial");
      const accented = await seedUnverified("Padrón 1964 Anniversary Maduro Imperial");

      const queue = await curationQueue(h.deps, admin);
      const pair = queue.duplicates.find(
        (p) =>
          (p.a.cigarId === plain && p.b.cigarId === accented) ||
          (p.a.cigarId === accented && p.b.cigarId === plain),
      );
      expect(pair).toBeDefined();
      expect(pair!.similarity).toBeGreaterThan(0.6);
      // Pairs are ordered highest-similarity first.
      const sims = queue.duplicates.map((p) => p.similarity);
      expect([...sims]).toEqual([...sims].sort((x, y) => y - x));
    });
  });
});
