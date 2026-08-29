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
  wants,
  auditLog,
  favorites,
} from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import {
  mergeCigars,
  verifyCigar,
  dismissDuplicate,
  curationQueue,
  setListingMatchStatus,
  excludeCigar,
  restoreCigar,
  setProductPhotoRights,
} from "./curation.js";
import { getProductPhoto } from "./product-photos.js";
import { getCigar, searchCigars, getCigarOffers } from "./reads.js";
import { setWant } from "./wants.js";
import { setFavorite } from "./favorites.js";
import type { Principal } from "./index.js";
import { UnauthorizedError, CigarNotFoundError, PhotoNotFoundError, ValidationError } from "./errors.js";

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
      // Nothing happened — both rows survive, source still active.
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, source));
      expect(row!.catalogStatus).toBe("active");
    });

    it("re-points every referencing table, tombstones the source, and audits cigar.merge", async () => {
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
        offers: 0, // the seeded offer links via its listing match, not offers.cigar_id
        productPhotos: 1,
        enrichmentRequests: 1,
        wants: 0,
        favorites: 0,
      });

      // Source cigar is tombstoned, not deleted: it survives with
      // catalog_status='merged' and merged_into pointing at the survivor (DESIGN-003).
      const [sourceRow] = await h.deps.db.select().from(cigars).where(eq(cigars.id, source));
      expect(sourceRow!.catalogStatus).toBe("merged");
      expect(sourceRow!.mergedInto).toBe(target);

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
      const audit = audits.find((a) => (a.after as { tombstonedSourceId?: string }).tombstonedSourceId === source);
      expect(audit).toBeDefined();
      expect(audit!.actor).toBe("web");
      expect((audit!.before as { source: { id: string } }).source.id).toBe(source);
      expect((audit!.before as { target: { id: string } }).target.id).toBe(target);
      expect((audit!.after as { repointed: { smokes: number } }).repointed.smokes).toBe(1);
    });

    it("re-points an ad-hoc price observation (offers.cigar_id) so merge keeps its history", async () => {
      const source = await seedUnverified("AdHoc Price Source");
      const target = await seedUnverified("AdHoc Price Target");

      // A record_price-style observation: linked directly via cigar_id, no listing
      // match, a named ad-hoc source. Its offers.cigar_id ON DELETE CASCADE would
      // otherwise drop it when the source is deleted.
      const [offer] = await h.deps.db
        .insert(offers)
        .values({ cigarId: source, sourceName: "Chat Shop", price: "12.50", currency: "USD" })
        .returning({ id: offers.id });

      const result = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });
      expect(result.repointed.offers).toBe(1);

      const [row] = await h.deps.db.select().from(offers).where(eq(offers.id, offer!.id));
      expect(row!.cigarId).toBe(target); // survived + re-pointed, not cascade-deleted
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

      // Target still has exactly its own photo; the source keeps its own on the
      // tombstone (no longer cascade-deleted), so it never collides with the target's.
      const photos = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, target));
      expect(photos).toHaveLength(1);
      expect(photos[0]!.objectKey).toBe("obj/keep-tgt");
      const srcPhotos = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, source));
      expect(srcPhotos).toHaveLength(1);
      expect(srcPhotos[0]!.objectKey).toBe("obj/keep-src");
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
      const forSource = audits.filter((a) => (a.after as { tombstonedSourceId?: string }).tombstonedSourceId === source);
      expect(forSource).toHaveLength(1);
    });

    it("re-points wants and de-dupes when the same user wanted both sides (#45 gap)", async () => {
      const source = await seedUnverified("Want Merge Source");
      const target = await seedUnverified("Want Merge Target");

      // `user` wanted BOTH sides → the source mark is the de-dupe drop (target's
      // survives). `admin` wanted only the source → it re-points with no collision.
      await setWant(h.deps, user, { cigarId: source, wanted: true });
      await setWant(h.deps, user, { cigarId: target, wanted: true });
      await setWant(h.deps, admin, { cigarId: source, wanted: true });

      const result = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });

      // Only admin's mark moved; user's source mark was dropped as a duplicate.
      expect(result.repointed.wants).toBe(1);

      // Nothing left on the tombstoned source; the target carries both users' marks.
      expect(await h.deps.db.select().from(wants).where(eq(wants.cigarId, source))).toHaveLength(0);
      const onTarget = await h.deps.db.select().from(wants).where(eq(wants.cigarId, target));
      expect(onTarget.map((w) => w.userId).sort()).toEqual([user.userId, admin.userId].sort());

      // The audit notes both the re-point and the de-dupe.
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.merge"));
      const audit = audits.find(
        (a) => (a.after as { tombstonedSourceId?: string }).tombstonedSourceId === source,
      );
      expect((audit!.after as { repointed: { wants: number } }).repointed.wants).toBe(1);
      expect((audit!.after as { wantsDeduped: number }).wantsDeduped).toBe(1);
    });

    it("re-points favorites and de-dupes when the same user favorited both sides", async () => {
      const source = await seedUnverified("Favorite Merge Source");
      const target = await seedUnverified("Favorite Merge Target");

      // `user` favorited BOTH sides → the source mark is the de-dupe drop (target's
      // survives). `admin` favorited only the source → it re-points with no collision.
      await setFavorite(h.deps, user, { cigarId: source, favorited: true });
      await setFavorite(h.deps, user, { cigarId: target, favorited: true });
      await setFavorite(h.deps, admin, { cigarId: source, favorited: true });

      const result = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });

      // Only admin's mark moved; user's source mark was dropped as a duplicate.
      expect(result.repointed.favorites).toBe(1);

      // Nothing left on the tombstoned source; the target carries both users' marks.
      expect(await h.deps.db.select().from(favorites).where(eq(favorites.cigarId, source))).toHaveLength(0);
      const onTarget = await h.deps.db.select().from(favorites).where(eq(favorites.cigarId, target));
      expect(onTarget.map((f) => f.userId).sort()).toEqual([user.userId, admin.userId].sort());

      // The audit notes both the re-point and the de-dupe.
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.merge"));
      const audit = audits.find(
        (a) => (a.after as { tombstonedSourceId?: string }).tombstonedSourceId === source,
      );
      expect((audit!.after as { repointed: { favorites: number } }).repointed.favorites).toBe(1);
      expect((audit!.after as { favoritesDeduped: number }).favoritesDeduped).toBe(1);
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

    it("suppresses number-distinct siblings via the resolver's number-token guard", async () => {
      // High trigram similarity, but "No. 9" vs "T52" are different products by
      // definition — the pair must never surface as a merge candidate.
      const no9 = await seedUnverified("Guarded Liga Privada No. 9 Toro");
      const t52 = await seedUnverified("Guarded Liga Privada T52 Toro");

      const queue = await curationQueue(h.deps, admin);
      const pair = queue.duplicates.find(
        (p) =>
          (p.a.cigarId === no9 && p.b.cigarId === t52) ||
          (p.a.cigarId === t52 && p.b.cigarId === no9),
      );
      expect(pair).toBeUndefined();
    });
  });

  // --- dismissDuplicate -----------------------------------------------------

  describe("dismissDuplicate", () => {
    it("rejects a non-admin principal", async () => {
      const error = await dismissDuplicate(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarAId: crypto.randomUUID(),
        cigarBId: crypto.randomUUID(),
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("rejects a self-pair with a field-pathed validation_error", async () => {
      const id = crypto.randomUUID();
      const error = await dismissDuplicate(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarAId: id,
        cigarBId: id,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
    });

    it("errors cigar_not_found when either side is missing", async () => {
      const real = await seedUnverified("Dismiss Missing Partner");
      const error = await dismissDuplicate(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarAId: real,
        cigarBId: crypto.randomUUID(),
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CigarNotFoundError);
    });

    it("removes the pair from the queue regardless of input order, and audits", async () => {
      const natural = await seedUnverified("Dismissal Queue Candidate Robusto Uno");
      const maduro = await seedUnverified("Dismissal Queue Candidate Robusto Dos");

      // Surfaced before the verdict.
      const before = await curationQueue(h.deps, admin);
      const surfaced = before.duplicates.find(
        (p) =>
          (p.a.cigarId === natural && p.b.cigarId === maduro) ||
          (p.a.cigarId === maduro && p.b.cigarId === natural),
      );
      expect(surfaced).toBeDefined();

      // Dismiss in REVERSED order and with uppercased input — the service
      // normalizes casing and id-ordering, so neither must matter.
      const [lo, hi] = natural < maduro ? [natural, maduro] : [maduro, natural];
      const result = await dismissDuplicate(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarAId: hi.toUpperCase(),
        cigarBId: lo,
      });
      expect(result).toMatchObject({ cigarAId: lo, cigarBId: hi, replayed: false });

      const after = await curationQueue(h.deps, admin);
      const stillThere = after.duplicates.find(
        (p) =>
          (p.a.cigarId === natural && p.b.cigarId === maduro) ||
          (p.a.cigarId === maduro && p.b.cigarId === natural),
      );
      expect(stillThere).toBeUndefined();

      const audits = await h.deps.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "cigar.dismiss_duplicate"));
      const forPair = audits.filter(
        (a) => (a.after as { dismissed?: { cigarAId?: string } }).dismissed?.cigarAId === lo,
      );
      expect(forPair).toHaveLength(1);
    });

    it("replays an identical retry, and a fresh request for the same pair is a no-op", async () => {
      const first = await seedUnverified("Replay Dismissal Candidate Uno");
      const second = await seedUnverified("Replay Dismissal Candidate Dos");
      const input = {
        clientRequestId: newRequestId(),
        cigarAId: first,
        cigarBId: second,
      };
      const initial = await dismissDuplicate(h.deps, admin, input);
      const replayed = await dismissDuplicate(h.deps, admin, input);
      expect(initial.replayed).toBe(false);
      expect(replayed.replayed).toBe(true);

      // A different request id for an already-dismissed pair succeeds without
      // erroring (onConflictDoNothing) — the verdict is naturally idempotent.
      const again = await dismissDuplicate(h.deps, admin, { ...input, clientRequestId: newRequestId() });
      expect(again.replayed).toBe(false);
    });
  });

  // --- setListingMatchStatus (DESIGN-003 §Curation) -------------------------

  describe("setListingMatchStatus", () => {
    async function addMatch(
      cigarId: string | null,
      status: "auto" | "confirmed" | "unmatched" = "auto",
    ): Promise<string> {
      const [m] = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `lm-${newRequestId()}`, cigarId, status })
        .returning({ id: listingMatches.id });
      return m!.id;
    }

    it("rejects a non-admin principal", async () => {
      const cigarId = await seedUnverified("LM Reject");
      const matchId = await addMatch(cigarId);
      const error = await setListingMatchStatus(h.deps, user, {
        clientRequestId: newRequestId(),
        matchId,
        status: "confirmed",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("confirm keeps the cigar and audits listing_match.set_status", async () => {
      const cigarId = await seedUnverified("LM Confirm");
      const matchId = await addMatch(cigarId);
      const result = await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId,
        status: "confirmed",
      });
      expect(result.status).toBe("confirmed");
      expect(result.cigarId).toBe(cigarId);
      const [row] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, matchId));
      expect(row!.status).toBe("confirmed");
      expect(row!.cigarId).toBe(cigarId);
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "listing_match.set_status"));
      const audit = audits.find((a) => (a.after as { id?: string }).id === matchId);
      expect(audit).toBeDefined();
      expect(audit!.actor).toBe("web");
    });

    it("unmatch clears the cigar link and stops the match contributing offers", async () => {
      const cigarId = await seedUnverified("LM Unmatch");
      const matchId = await addMatch(cigarId);
      await h.deps.db
        .insert(offers)
        .values({ vendorId, listingMatchId: matchId, price: "9.99", currency: "USD", inStock: true });
      // Before: the offer reaches the cigar through the auto match.
      expect(await getCigarOffers(h.deps, { cigarId })).toHaveLength(1);

      const result = await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId,
        status: "unmatched",
      });
      expect(result.status).toBe("unmatched");
      expect(result.cigarId).toBeNull();
      const [row] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, matchId));
      expect(row!.status).toBe("unmatched");
      expect(row!.cigarId).toBeNull();
      // The prior cigar id survives in the audit before-snapshot (reversibility).
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "listing_match.set_status"));
      const audit = audits.find(
        (a) => (a.before as { id?: string }).id === matchId && (a.after as { status?: string }).status === "unmatched",
      );
      expect((audit!.before as { cigarId?: string }).cigarId).toBe(cigarId);
      // After: the unmatched link no longer feeds the cigar's offers.
      expect(await getCigarOffers(h.deps, { cigarId })).toHaveLength(0);
    });

    it("refuses to confirm a match with no cigar", async () => {
      const matchId = await addMatch(null, "unmatched");
      const error = await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId,
        status: "confirmed",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
    });

    it("errors validation for a missing match id", async () => {
      const error = await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId: "00000000-0000-0000-0000-000000000000",
        status: "unmatched",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
    });

    it("replays an identical retry", async () => {
      const cigarId = await seedUnverified("LM Replay");
      const matchId = await addMatch(cigarId);
      const input = { clientRequestId: newRequestId(), matchId, status: "confirmed" as const };
      const first = await setListingMatchStatus(h.deps, admin, input);
      const second = await setListingMatchStatus(h.deps, admin, input);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
    });
  });

  // --- excludeCigar / restoreCigar (DESIGN-003 §Curation) -------------------

  describe("excludeCigar / restoreCigar", () => {
    it("rejects a non-admin principal", async () => {
      const cigarId = await seedUnverified("Excl Reject");
      const error = await excludeCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.catalogStatus).toBe("active");
    });

    it("hides the cigar from search but keeps its detail reachable by id, and audits", async () => {
      const brand = `ExclBrand ${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: `${brand} Pollution`, brand });
      // Owner smoke — the excluded cigar must still resolve its detail page.
      await addSmoke(cigarId, user);

      const result = await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId });
      expect(result.catalogStatus).toBe("excluded");
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.catalogStatus).toBe("excluded");

      // Hidden from the picker search…
      const search = await searchCigars(h.deps, user, { query: `${brand} Pollution` });
      expect(search.matches.find((m) => m.cigarId === cigarId)).toBeUndefined();
      // …but still reachable by direct id (the owner's journal keeps working).
      const detail = await getCigar(h.deps, user, { cigarId });
      expect(detail.cigar.cigarId).toBe(cigarId);

      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.exclude"));
      expect(audits.find((a) => (a.after as { id?: string }).id === cigarId)).toBeDefined();
    });

    it("restore returns the cigar to active and its audit reverts the exclude", async () => {
      const cigarId = await seedUnverified("Excl Restore");
      await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId });
      const excludeAudit = (
        await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.exclude"))
      ).find((a) => (a.after as { id?: string }).id === cigarId)!;

      const result = await restoreCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId });
      expect(result.catalogStatus).toBe("active");
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.catalogStatus).toBe("active");

      // The reversibility substrate: the restore audit self-links the exclude it undoes.
      const restoreAudit = (
        await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.restore"))
      ).find((a) => (a.after as { id?: string }).id === cigarId)!;
      expect(restoreAudit.reverts).toBe(excludeAudit.id);
    });

    it("refuses to exclude a merged tombstone", async () => {
      const source = await seedUnverified("Excl Merged Source");
      const target = await seedUnverified("Excl Merged Target");
      await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });
      const error = await excludeCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId: source,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
    });

    it("replays an identical exclude retry", async () => {
      const cigarId = await seedUnverified("Excl Replay");
      const input = { clientRequestId: newRequestId(), cigarId };
      const first = await excludeCigar(h.deps, admin, input);
      const second = await excludeCigar(h.deps, admin, input);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
    });
  });

  // --- setProductPhotoRights (DESIGN-003 §Curation) -------------------------

  describe("setProductPhotoRights", () => {
    it("rejects a non-admin principal", async () => {
      const cigarId = await seedUnverified("Rights Reject");
      await addProductPhoto(cigarId, "rights-reject");
      const error = await setProductPhotoRights(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        rights: "suppressed",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("suppress stops getProductPhoto serving the photo and audits the transition", async () => {
      const cigarId = await seedUnverified("Rights Suppress");
      await addProductPhoto(cigarId, "rights-suppress");
      // Served while pending.
      await expect(getProductPhoto(h.deps, { cigarId })).resolves.toBeDefined();

      const result = await setProductPhotoRights(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        rights: "suppressed",
      });
      expect(result.rights).toBe("suppressed");

      // Now treated as absent → PhotoNotFoundError (the serving route 404s on this).
      await expect(getProductPhoto(h.deps, { cigarId })).rejects.toBeInstanceOf(PhotoNotFoundError);

      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "product_photo.set_rights"));
      const audit = audits.find((a) => (a.after as { cigarId?: string }).cigarId === cigarId);
      expect((audit!.before as { rights?: string }).rights).toBe("pending");
      expect((audit!.after as { rights?: string }).rights).toBe("suppressed");
    });

    it("approve makes a suppressed photo servable again", async () => {
      const cigarId = await seedUnverified("Rights Approve");
      await addProductPhoto(cigarId, "rights-approve");
      await setProductPhotoRights(h.deps, admin, { clientRequestId: newRequestId(), cigarId, rights: "suppressed" });
      await expect(getProductPhoto(h.deps, { cigarId })).rejects.toBeInstanceOf(PhotoNotFoundError);
      await setProductPhotoRights(h.deps, admin, { clientRequestId: newRequestId(), cigarId, rights: "approved" });
      await expect(getProductPhoto(h.deps, { cigarId })).resolves.toBeDefined();
    });

    it("errors photo_not_found when the cigar has no product photo", async () => {
      const cigarId = await seedUnverified("Rights NoPhoto");
      const error = await setProductPhotoRights(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        rights: "approved",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PhotoNotFoundError);
    });

    it("replays an identical retry", async () => {
      const cigarId = await seedUnverified("Rights Replay");
      await addProductPhoto(cigarId, "rights-replay");
      const input = { clientRequestId: newRequestId(), cigarId, rights: "approved" as const };
      const first = await setProductPhotoRights(h.deps, admin, input);
      const second = await setProductPhotoRights(h.deps, admin, input);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
    });
  });
});
