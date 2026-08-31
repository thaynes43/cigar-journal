import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  cigars,
  cigarMerges,
  smokes,
  smokeConsumptions,
  purchases,
  listingMatches,
  offers,
  productPhotos,
  enrichmentRequests,
  vendors,
  enrichmentAttempts,
  wants,
  auditLog,
  favorites,
} from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import {
  mergeCigars,
  unmergeCigars,
  recentMerges,
  MERGE_LEDGER_TABLES,
  verifyCigar,
  dismissDuplicate,
  curationQueue,
  setListingMatchStatus,
  excludeCigar,
  restoreCigar,
  setProductPhotoRights,
  setCigarFacts,
  curationWorklist,
  renameCigar,
  agentRuns,
  agentRunRows,
  undoCurationAction,
} from "./curation.js";
import { enrichmentCoverageForCigar, recordEnrichmentAttempt } from "./enrichment-coverage.js";
import { getProductPhoto } from "./product-photos.js";
import { getMyInventory } from "./inventory.js";
import { getCigar, searchCigars, getCigarOffers } from "./reads.js";
import { setWant } from "./wants.js";
import { setFavorite } from "./favorites.js";
import type { Principal, UnmergeCigarsResult, WorklistCigar, WorklistMatch } from "./index.js";
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

  async function addPurchase(cigarId: string, owner = user, quantity?: number): Promise<string> {
    const [row] = await h.deps.db
      .insert(purchases)
      .values({ userId: owner.userId, cigarId, ...(quantity != null ? { quantity } : {}) })
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

    // The per-vendor attempt ledger (migration 0023) hangs off request_id, NOT
    // cigar_id — which is exactly why the shape was chosen. A merge re-points
    // enrichment_requests.cigar_id and the evidence follows the ask with no extra
    // table to move, no extra ledger row to record, and nothing for unmerge to
    // orphan. The survivor then classifies against the merged history.
    it("carries the enrichment attempt ledger through a merge and an unmerge untouched", async () => {
      const source = await seedUnverified("Ledger Merge Source");
      const target = await seedUnverified("Ledger Merge Target");
      const enrichmentId = await addEnrichment(source);

      const [vendor] = await h.deps.db
        .insert(vendors)
        .values({ name: `Ledger Merge Vendor ${newRequestId().slice(0, 8)}`, focus: "NC", crawlEnabled: true })
        .returning({ id: vendors.id });
      await recordEnrichmentAttempt(h.deps.db, {
        requestId: enrichmentId,
        vendorId: vendor!.id,
        outcome: "miss",
        at: new Date("2026-08-30T12:00:00.000Z"),
      });

      const merge = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });

      const [request] = await h.deps.db
        .select()
        .from(enrichmentRequests)
        .where(eq(enrichmentRequests.id, enrichmentId));
      expect(request!.cigarId).toBe(target);
      // The ledger row never moved and never had to.
      const afterMerge = await h.deps.db
        .select()
        .from(enrichmentAttempts)
        .where(eq(enrichmentAttempts.requestId, enrichmentId));
      expect(afterMerge).toHaveLength(1);
      expect(afterMerge[0]!.attempts).toBe(1);
      // The survivor's coverage sees the merged history — that look really happened
      // against this ask, whichever cigar row now owns it.
      const coverage = await enrichmentCoverageForCigar(h.deps.db, target, "NC");
      expect(coverage.tried.map((v) => v.vendorId)).toContain(vendor!.id);

      await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId: merge.mergeId });
      const [restored] = await h.deps.db
        .select()
        .from(enrichmentRequests)
        .where(eq(enrichmentRequests.id, enrichmentId));
      expect(restored!.cigarId).toBe(source);
      const afterUnmerge = await h.deps.db
        .select()
        .from(enrichmentAttempts)
        .where(eq(enrichmentAttempts.requestId, enrichmentId));
      expect(afterUnmerge).toHaveLength(1);
      expect(afterUnmerge[0]!.vendorId).toBe(vendor!.id);
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

    // --- the cigar_merges ledger (migration 0020, #45) ---------------------

    it("writes a ledger naming every re-pointed row and the pre-merge source state", async () => {
      const source = await seedUnverified("Ledger Source Rows");
      const target = await seedUnverified("Ledger Target Rows");

      const smokeId = await addSmoke(source);
      const purchaseId = await addPurchase(source);
      await addOffer(source, `sku-ledger-${newRequestId().slice(0, 8)}`);
      const enrichmentId = await addEnrichment(source);
      await addProductPhoto(source, `ledger-${newRequestId().slice(0, 6)}`);
      const [adHoc] = await h.deps.db
        .insert(offers)
        .values({ cigarId: source, sourceName: "Chat Shop", price: "9.00", currency: "USD" })
        .returning({ id: offers.id });
      await setWant(h.deps, user, { cigarId: source, wanted: true });
      await setFavorite(h.deps, user, { cigarId: source, favorited: true });

      const result = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });

      const [ledgerRow] = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.id, result.mergeId));
      expect(ledgerRow!.sourceCigarId).toBe(source);
      expect(ledgerRow!.targetCigarId).toBe(target);
      const moves = ledgerRow!.moves;
      expect(moves.version).toBe(1);
      expect(moves.sourceBefore).toEqual({ catalogStatus: "active", mergedInto: null });
      expect(moves.moved.smokes).toEqual([smokeId]);
      expect(moves.moved.purchases).toEqual([purchaseId]);
      expect(moves.moved.enrichmentRequests).toEqual([enrichmentId]);
      expect(moves.moved.offers).toEqual([adHoc!.id]);
      expect(moves.moved.listingMatches).toHaveLength(1);
      expect(moves.moved.productPhotos).toHaveLength(1);
      expect(moves.moved.wants).toHaveLength(1);
      expect(moves.moved.favorites).toHaveLength(1);

      // The ledger names exactly the rows that ended up on the target.
      const onTarget = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.cigarId, target));
      expect(moves.moved.listingMatches).toEqual(onTarget.map((m) => m.id));

      // And it is tied to this merge's audit row.
      const [mergeAudit] = await h.deps.db.select().from(auditLog).where(eq(auditLog.id, ledgerRow!.auditId));
      expect(mergeAudit!.action).toBe("cigar.merge");
      expect((mergeAudit!.after as { tombstonedSourceId?: string }).tombstonedSourceId).toBe(source);
    });

    it("records the de-duped want/favorite payloads whole, not just their ids", async () => {
      const source = await seedUnverified("Ledger Dedupe Source");
      const target = await seedUnverified("Ledger Dedupe Target");

      // `user` marked BOTH sides → the source marks are the de-dupe drops.
      await setWant(h.deps, user, { cigarId: source, wanted: true, note: "the dropped want" });
      await setWant(h.deps, user, { cigarId: target, wanted: true });
      await setFavorite(h.deps, user, { cigarId: source, favorited: true });
      await setFavorite(h.deps, user, { cigarId: target, favorited: true });
      // `admin` marked only the source → these move.
      await setWant(h.deps, admin, { cigarId: source, wanted: true });

      const [droppedWantBefore] = await h.deps.db
        .select()
        .from(wants)
        .where(and(eq(wants.cigarId, source), eq(wants.userId, user.userId)));

      const result = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });

      const [ledgerRow] = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.id, result.mergeId));
      const moves = ledgerRow!.moves;
      expect(moves.dropped.wants).toHaveLength(1);
      expect(moves.dropped.wants[0]).toEqual({
        id: droppedWantBefore!.id,
        userId: user.userId,
        note: "the dropped want",
        createdAt: droppedWantBefore!.createdAt.toISOString(),
      });
      expect(moves.dropped.favorites).toHaveLength(1);
      // The mark that survived the de-dupe is in `moved`, not `dropped`.
      expect(moves.moved.wants).toHaveLength(1);
    });

    it("writes exactly one ledger row and one audit for a replayed merge", async () => {
      const source = await seedUnverified("Ledger Replay Source");
      const target = await seedUnverified("Ledger Replay Target");
      await addSmoke(source);
      const input = { clientRequestId: newRequestId(), sourceCigarId: source, targetCigarId: target };
      const first = await mergeCigars(h.deps, admin, input);
      const second = await mergeCigars(h.deps, admin, input);
      expect(second.replayed).toBe(true);
      expect(second.mergeId).toBe(first.mergeId);
      const ledgers = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.sourceCigarId, source));
      expect(ledgers).toHaveLength(1);
    });

    it("rejects a source that is already a tombstone", async () => {
      const source = await seedUnverified("Chain Guard A");
      const middle = await seedUnverified("Chain Guard B");
      const other = await seedUnverified("Chain Guard C");
      await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: middle,
      });
      const error = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: other,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields.some((f) => f.path === "sourceCigarId")).toBe(true);
    });

    it("rejects a target that is already a tombstone", async () => {
      const tombstone = await seedUnverified("Tombstone Target A");
      const survivor = await seedUnverified("Tombstone Target B");
      const fresh = await seedUnverified("Tombstone Target C");
      await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: tombstone,
        targetCigarId: survivor,
      });
      const error = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: fresh,
        targetCigarId: tombstone,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields.some((f) => f.path === "targetCigarId")).toBe(true);
    });

    it("rejects an EXCLUDED target, so lots cannot be re-pointed onto a hidden row", async () => {
      // The exclude guard's twin (#169). Merging a held source into an excluded
      // target would move the purchase lots onto a row no catalog read returns —
      // the same invisibility, reached by a different door. The console cannot pose
      // this call (its duplicate-pair query requires both sides active) but the
      // tRPC route takes arbitrary ids.
      const source = await seedUnverified("Excluded Target Source");
      const hidden = await seedUnverified("Excluded Target Hidden");
      await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId: hidden });

      const error = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: hidden,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      const field = (error as ValidationError).fields[0]!;
      expect(field.path).toBe("targetCigarId");
      expect(field.message).toBe("Merge into an active cigar instead.");
      // Nothing moved.
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, source));
      expect(row!.catalogStatus).toBe("active");
    });

    it("moves every lot of a held source to the survivor, and the tombstone strands none", async () => {
      // Merge is the sanctioned way past the exclude guard, so it must actually
      // relocate the inventory rather than leave it on a row about to be hidden.
      const source = await seedUnverified("Held Merge Source");
      const target = await seedUnverified("Held Merge Target");
      const lotA = await addPurchase(source, user, 10);
      const lotB = await addPurchase(source, user, 13);

      await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });

      const lots = await h.deps.db.select().from(purchases).where(eq(purchases.cigarId, target));
      expect(lots.map((l) => l.id).sort()).toEqual([lotA, lotB].sort());
      const stranded = await h.deps.db.select().from(purchases).where(eq(purchases.cigarId, source));
      expect(stranded).toHaveLength(0);

      // …and the survivor now carries the holding, so it is itself un-excludable.
      const error = await excludeCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId: target,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("23 sticks");
    });
  });


  // --- unmergeCigars (#45) --------------------------------------------------

  describe("unmergeCigars", () => {
    // Merge `source` into `target` and hand back the ledger id — the handle every
    // unmerge test takes.
    async function merge(source: string, target: string): Promise<string> {
      const result = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });
      return result.mergeId;
    }

    async function mergeAuditFor(sourceId: string): Promise<string> {
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.merge"));
      return audits.find((a) => (a.after as { tombstonedSourceId?: string }).tombstonedSourceId === sourceId)!.id;
    }

    it("rejects a non-admin principal", async () => {
      const error = await unmergeCigars(h.deps, user, {
        clientRequestId: newRequestId(),
        mergeId: "00000000-0000-0000-0000-000000000000",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("rejects an unknown mergeId", async () => {
      const error = await unmergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        mergeId: "00000000-0000-0000-0000-000000000000",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields.some((f) => f.path === "mergeId")).toBe(true);
    });

    it("restores every ledger row, un-tombstones the source, and audits cigar.unmerge", async () => {
      const source = await seedUnverified("Unmerge Full Source");
      const target = await seedUnverified("Unmerge Full Target");

      const smokeId = await addSmoke(source);
      const purchaseId = await addPurchase(source);
      const enrichmentId = await addEnrichment(source);
      await addProductPhoto(source, `unmerge-${newRequestId().slice(0, 6)}`);
      const [match] = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `unmerge-${newRequestId()}`, cigarId: source, status: "auto" })
        .returning({ id: listingMatches.id });
      const [adHoc] = await h.deps.db
        .insert(offers)
        .values({ cigarId: source, sourceName: "Chat Shop", price: "11.00", currency: "USD" })
        .returning({ id: offers.id });
      await setWant(h.deps, user, { cigarId: source, wanted: true });
      await setFavorite(h.deps, user, { cigarId: source, favorited: true });

      // The survivor's OWN rows — these must not move.
      const targetSmoke = await addSmoke(target);
      const targetPurchase = await addPurchase(target);

      const mergeId = await merge(source, target);
      const mergeAuditId = await mergeAuditFor(source);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.replayed).toBe(false);
      expect(result.restored).toEqual({
        smokes: 1,
        purchases: 1,
        listingMatches: 1,
        offers: 1,
        productPhotos: 1,
        enrichmentRequests: 1,
        wants: 1,
        favorites: 1,
      });
      expect(result.skipped).toEqual([]);
      expect(result.restoredSourceStatus).toBe("active");

      const [smoke] = await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId));
      expect(smoke!.cigarId).toBe(source);
      const [purchase] = await h.deps.db.select().from(purchases).where(eq(purchases.id, purchaseId));
      expect(purchase!.cigarId).toBe(source);
      const [matchRow] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, match!.id));
      expect(matchRow!.cigarId).toBe(source);
      const [offerRow] = await h.deps.db.select().from(offers).where(eq(offers.id, adHoc!.id));
      expect(offerRow!.cigarId).toBe(source);
      const [enrichment] = await h.deps.db
        .select()
        .from(enrichmentRequests)
        .where(eq(enrichmentRequests.id, enrichmentId));
      expect(enrichment!.cigarId).toBe(source);
      expect(await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, source))).toHaveLength(1);
      expect(await h.deps.db.select().from(wants).where(eq(wants.cigarId, source))).toHaveLength(1);
      expect(await h.deps.db.select().from(favorites).where(eq(favorites.cigarId, source))).toHaveLength(1);

      // The survivor keeps its own rows and nothing else.
      const [ownSmoke] = await h.deps.db.select().from(smokes).where(eq(smokes.id, targetSmoke));
      expect(ownSmoke!.cigarId).toBe(target);
      const [ownPurchase] = await h.deps.db.select().from(purchases).where(eq(purchases.id, targetPurchase));
      expect(ownPurchase!.cigarId).toBe(target);
      expect(await h.deps.db.select().from(smokes).where(eq(smokes.cigarId, target))).toHaveLength(1);

      // Source is a live catalog row again.
      const [sourceRow] = await h.deps.db.select().from(cigars).where(eq(cigars.id, source));
      expect(sourceRow!.catalogStatus).toBe("active");
      expect(sourceRow!.mergedInto).toBeNull();

      // The audit reverts the merge, so a later Undo of that merge sees it done.
      const [undo] = await h.deps.db.select().from(auditLog).where(eq(auditLog.id, result.undoAuditId));
      expect(undo!.action).toBe("cigar.unmerge");
      expect(undo!.actor).toBe("web");
      expect(undo!.reverts).toBe(mergeAuditId);
      expect((undo!.after as { mergeId: string }).mergeId).toBe(mergeId);

      // The ledger is claimed exactly once and points at the undo audit.
      const [ledgerRow] = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.id, mergeId));
      expect(ledgerRow!.undoneAt).not.toBeNull();
      expect(ledgerRow!.undoAuditId).toBe(result.undoAuditId);
    });

    it("returns the source to its pre-merge status, not a hardcoded active", async () => {
      const source = await h.seedCigar({ canonicalName: "Unmerge Excluded Source", catalogStatus: "excluded" });
      const target = await seedUnverified("Unmerge Excluded Target");
      const mergeId = await merge(source, target);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restoredSourceStatus).toBe("excluded");
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, source));
      expect(row!.catalogStatus).toBe("excluded");
    });

    it("restores no lots onto a source that was excluded before the merge", async () => {
      // The other half of #169, asserted rather than guarded twice. Unmerge puts the
      // source back at its PRE-merge lifecycle, so an excluded source would get its
      // lots back on a hidden row — except that excludeCigar now refuses a cigar
      // with any lot, so a source excluded through the service has none to move and
      // `ledger.moved.purchases` is empty in exactly this case. Guarding unmerge as
      // well would duplicate the invariant and break the LIFO inverse.
      //
      // NOT airtight, and knowingly so: recordPurchase resolves by id without
      // consulting catalog_status, so a lot recorded against an already-excluded
      // cigar would ride the ledger. That is the same hole the exclude guard's race
      // note names, and closing it belongs to record_purchase, not here.
      const source = await seedUnverified("Unmerge Excluded Held Source");
      const target = await seedUnverified("Unmerge Excluded Held Target");
      await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId: source });
      const mergeId = await merge(source, target);

      const [ledger] = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.id, mergeId));
      expect((ledger!.moves as { moved: { purchases?: string[] } }).moved.purchases ?? []).toEqual([]);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.purchases).toBe(0);
      expect(result.restoredSourceStatus).toBe("excluded");
      const backOnHidden = await h.deps.db.select().from(purchases).where(eq(purchases.cigarId, source));
      expect(backOnHidden).toHaveLength(0);
    });

    it("leaves rows created on the survivor after the merge exactly where they are", async () => {
      const source = await seedUnverified("Unmerge Post Source");
      const target = await seedUnverified("Unmerge Post Target");
      const movedSmoke = await addSmoke(source);
      const mergeId = await merge(source, target);

      // Everything below lands on the survivor AFTER the merge — none of it is in
      // the ledger, so none of it may move.
      const laterSmoke = await addSmoke(target);
      const laterPurchase = await addPurchase(target);
      await setWant(h.deps, admin, { cigarId: target, wanted: true });
      const [laterMatch] = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `post-${newRequestId()}`, cigarId: target, status: "auto" })
        .returning({ id: listingMatches.id });

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.smokes).toBe(1);
      expect(result.restored.purchases).toBe(0);
      expect(result.restored.wants).toBe(0);
      expect(result.restored.listingMatches).toBe(0);

      const [moved] = await h.deps.db.select().from(smokes).where(eq(smokes.id, movedSmoke));
      expect(moved!.cigarId).toBe(source);
      const [kept] = await h.deps.db.select().from(smokes).where(eq(smokes.id, laterSmoke));
      expect(kept!.cigarId).toBe(target);
      const [keptPurchase] = await h.deps.db.select().from(purchases).where(eq(purchases.id, laterPurchase));
      expect(keptPurchase!.cigarId).toBe(target);
      const [keptMatch] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, laterMatch!.id));
      expect(keptMatch!.cigarId).toBe(target);
      expect(await h.deps.db.select().from(wants).where(eq(wants.cigarId, target))).toHaveLength(1);
    });

    it("refuses while the survivor is itself merged, and succeeds LIFO", async () => {
      const a = await seedUnverified("LIFO Chain A");
      const b = await seedUnverified("LIFO Chain B");
      const c = await seedUnverified("LIFO Chain C");
      const smokeId = await addSmoke(a);
      const abMerge = await merge(a, b);
      const bcMerge = await merge(b, c);

      const blocked = await unmergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        mergeId: abMerge,
      }).catch((e: unknown) => e);
      expect(blocked).toBeInstanceOf(ValidationError);
      // The blocked attempt must not have consumed the ledger.
      const [stillLive] = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.id, abMerge));
      expect(stillLive!.undoneAt).toBeNull();

      // Undo the later merge first, then the earlier one goes through.
      await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId: bcMerge });
      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId: abMerge });
      expect(result.restored.smokes).toBe(1);
      const [smoke] = await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId));
      expect(smoke!.cigarId).toBe(a);
      for (const id of [a, b, c]) {
        const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, id));
        expect(row!.catalogStatus).toBe("active");
      }
    });

    it("is a no-op for a merge-time photo loser — both photos stay put", async () => {
      const source = await seedUnverified("Photo Loser Source");
      const target = await seedUnverified("Photo Loser Target");
      await addProductPhoto(source, `loser-src-${newRequestId().slice(0, 6)}`);
      await addProductPhoto(target, `loser-tgt-${newRequestId().slice(0, 6)}`);
      const mergeId = await merge(source, target);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.productPhotos).toBe(0);
      expect(result.skipped.filter((s) => s.entity === "productPhotos")).toEqual([]);

      const srcPhotos = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, source));
      expect(srcPhotos).toHaveLength(1);
      expect(srcPhotos[0]!.objectKey).toContain("loser-src");
      const tgtPhotos = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, target));
      expect(tgtPhotos).toHaveLength(1);
      expect(tgtPhotos[0]!.objectKey).toContain("loser-tgt");
    });

    it("skips the photo move-back as source_occupied when the tombstone gained one", async () => {
      const source = await seedUnverified("Photo Occupied Source");
      const target = await seedUnverified("Photo Occupied Target");
      await addProductPhoto(source, `occ-moved-${newRequestId().slice(0, 6)}`);
      const mergeId = await merge(source, target);
      // A curator attached a photo to the tombstone after the merge — the slot is
      // taken (product_photos is UNIQUE(cigar_id)).
      await addProductPhoto(source, `occ-new-${newRequestId().slice(0, 6)}`);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.productPhotos).toBe(0);
      expect(result.skipped.filter((s) => s.entity === "productPhotos")).toEqual([
        { entity: "productPhotos", rowId: expect.any(String), reason: "source_occupied" },
      ]);
      // Both rows survive, no unique violation, and the unmerge completed.
      const srcPhotos = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, source));
      expect(srcPhotos).toHaveLength(1);
      expect(srcPhotos[0]!.objectKey).toContain("occ-new");
      const tgtPhotos = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, target));
      expect(tgtPhotos[0]!.objectKey).toContain("occ-moved");
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, source));
      expect(row!.catalogStatus).toBe("active");
    });

    it("re-creates a de-duped want with its original id and note", async () => {
      const source = await seedUnverified("Dedupe Restore Source");
      const target = await seedUnverified("Dedupe Restore Target");
      await setWant(h.deps, user, { cigarId: source, wanted: true, note: "restore me" });
      await setWant(h.deps, user, { cigarId: target, wanted: true });
      await setFavorite(h.deps, user, { cigarId: source, favorited: true });
      await setFavorite(h.deps, user, { cigarId: target, favorited: true });
      const [before] = await h.deps.db
        .select()
        .from(wants)
        .where(and(eq(wants.cigarId, source), eq(wants.userId, user.userId)));
      const droppedId = before!.id;

      const mergeId = await merge(source, target);
      expect(await h.deps.db.select().from(wants).where(eq(wants.id, droppedId))).toHaveLength(0);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.wants).toBe(1);
      expect(result.restored.favorites).toBe(1);
      const [restored] = await h.deps.db.select().from(wants).where(eq(wants.id, droppedId));
      expect(restored!.cigarId).toBe(source);
      expect(restored!.userId).toBe(user.userId);
      expect(restored!.note).toBe("restore me");
      // The survivor keeps its own mark.
      expect(await h.deps.db.select().from(wants).where(eq(wants.cigarId, target))).toHaveLength(1);
    });

    it("skips a de-duped mark as conflict when the user re-marked the tombstone", async () => {
      const source = await seedUnverified("Dedupe Conflict Source");
      const target = await seedUnverified("Dedupe Conflict Target");
      await setWant(h.deps, user, { cigarId: source, wanted: true, note: "old" });
      await setWant(h.deps, user, { cigarId: target, wanted: true });
      const mergeId = await merge(source, target);
      // The user wants the tombstone again after the merge — the newer mark wins.
      await setWant(h.deps, user, { cigarId: source, wanted: true, note: "new" });

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.wants).toBe(0);
      expect(result.skipped.filter((s) => s.entity === "wants")).toEqual([
        { entity: "wants", rowId: expect.any(String), reason: "conflict" },
      ]);
      const onSource = await h.deps.db.select().from(wants).where(eq(wants.cigarId, source));
      expect(onSource).toHaveLength(1);
      expect(onSource[0]!.note).toBe("new");
    });

    it("skips a row that moved on since the merge, and still completes", async () => {
      const source = await seedUnverified("Moved On Source");
      const target = await seedUnverified("Moved On Target");
      const smokeId = await addSmoke(source);
      const [match] = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `movedon-${newRequestId()}`, cigarId: source, status: "auto" })
        .returning({ id: listingMatches.id });
      const mergeId = await merge(source, target);

      // A curator unmatched the listing after the merge — its cigar_id is null now.
      await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId: match!.id,
        status: "unmatched",
      });

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.listingMatches).toBe(0);
      expect(result.restored.smokes).toBe(1);
      expect(result.skipped).toEqual([{ entity: "listingMatches", rowId: match!.id, reason: "moved_on" }]);
      const [matchRow] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, match!.id));
      expect(matchRow!.cigarId).toBeNull();
      const [smoke] = await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId));
      expect(smoke!.cigarId).toBe(source);
    });

    it("leaves a lot the survivor's later smoke consumed, so the humidor count stays honest", async () => {
      // The one skip a USER feels: getMyInventory builds holdings from purchases and
      // counts consumption by smokes.cigar_id, so returning a lot whose consumptions
      // stay on the survivor would resurrect smoked sticks AND drop the survivor out
      // of the humidor. Own user, so the totals are this scenario's alone.
      const owner = await h.createUser(`humidor-${newRequestId()}@example.com`);
      const source = await seedUnverified("Cross Lot Source");
      const target = await seedUnverified("Cross Lot Target");
      const purchaseId = await addPurchase(source, owner, 10);
      const mergeId = await merge(source, target);

      // Three smokes recorded on the survivor after the merge, each drawing from the
      // lot the ledger would otherwise send back to the source.
      const laterSmokes: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const smokeId = await addSmoke(target, owner);
        await h.deps.db.insert(smokeConsumptions).values({ smokeId, purchaseId });
        laterSmokes.push(smokeId);
      }
      const before = await getMyInventory(h.deps, owner);
      expect(before.totalSticksRemaining).toBe(7);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.purchases).toBe(0);
      expect(result.crossCigarLots).toBe(1);
      expect(result.skipped).toContainEqual({
        entity: "purchases",
        rowId: purchaseId,
        reason: "consumed_elsewhere",
      });

      // The lot stayed with the survivor, and the humidor reads exactly as it did.
      const [lot] = await h.deps.db.select().from(purchases).where(eq(purchases.id, purchaseId));
      expect(lot!.cigarId).toBe(target);
      const after = await getMyInventory(h.deps, owner);
      expect(after.totalSticksRemaining).toBe(7);
      expect(after.holdings.map((holding) => holding.cigar.cigarId)).toEqual([target]);
      expect(after.holdings[0]!.consumedCount).toBe(3);
      // The consumption rows are untouched — the lot moved around them, never they.
      const consumptions = await h.deps.db
        .select()
        .from(smokeConsumptions)
        .where(eq(smokeConsumptions.purchaseId, purchaseId));
      expect(consumptions).toHaveLength(3);
      const [smoke] = await h.deps.db.select().from(smokes).where(eq(smokes.id, laterSmokes[0]!));
      expect(smoke!.cigarId).toBe(target);
    });

    it("returns a lot both cigars smoked from, to the cigar that was bought", async () => {
      // A lot consumed by BOTH a returning smoke and a survivor smoke has no exact
      // inverse: splitting a user's purchase row is an owner decision, not the
      // unmerge's. Either placement strands one side's consumptions, so the lot
      // goes back to the cigar the user actually bought — the only cigar
      // assertLotOwned will let them draw from next. The residual error here is
      // the survivor's one consumption (9 rather than 8).
      const owner = await h.createUser(`humidor-${newRequestId()}@example.com`);
      const source = await seedUnverified("Shared Lot Source");
      const target = await seedUnverified("Shared Lot Target");
      const purchaseId = await addPurchase(source, owner, 10);
      const earlySmoke = await addSmoke(source, owner);
      await h.deps.db.insert(smokeConsumptions).values({ smokeId: earlySmoke, purchaseId });
      const mergeId = await merge(source, target);
      const laterSmoke = await addSmoke(target, owner);
      await h.deps.db.insert(smokeConsumptions).values({ smokeId: laterSmoke, purchaseId });

      const before = await getMyInventory(h.deps, owner);
      expect(before.totalSticksRemaining).toBe(8);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.purchases).toBe(1);
      expect(result.crossCigarLots).toBe(0);
      expect(result.skipped).toEqual([]);
      const [smoke] = await h.deps.db.select().from(smokes).where(eq(smokes.id, earlySmoke));
      expect(smoke!.cigarId).toBe(source);
      const [lot] = await h.deps.db.select().from(purchases).where(eq(purchases.id, purchaseId));
      expect(lot!.cigarId).toBe(source);

      const after = await getMyInventory(h.deps, owner);
      expect(after.holdings.map((holding) => holding.cigar.cigarId)).toEqual([source]);
      expect(after.totalSticksRemaining).toBe(9);
    });

    it("does not strand a mostly-source lot on the survivor over one later smoke", async () => {
      // The ordinary shape: the user logged the cigar for a while before the
      // curator merged it, then recorded one more stick from the same box on the
      // survivor. Holding the lot back would eat FIVE returning consumptions to
      // save one, and would leave the box on a cigar the curator has since
      // declared different — so the user could never attribute the next stick.
      const owner = await h.createUser(`humidor-${newRequestId()}@example.com`);
      const source = await seedUnverified("Mostly Source Lot");
      const target = await seedUnverified("Mostly Source Survivor");
      const purchaseId = await addPurchase(source, owner, 25);
      for (let i = 0; i < 5; i += 1) {
        const smokeId = await addSmoke(source, owner);
        await h.deps.db.insert(smokeConsumptions).values({ smokeId, purchaseId });
      }
      const mergeId = await merge(source, target);
      const laterSmoke = await addSmoke(target, owner);
      await h.deps.db.insert(smokeConsumptions).values({ smokeId: laterSmoke, purchaseId });

      const before = await getMyInventory(h.deps, owner);
      expect(before.totalSticksRemaining).toBe(19);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.purchases).toBe(1);
      expect(result.crossCigarLots).toBe(0);

      const [lot] = await h.deps.db.select().from(purchases).where(eq(purchases.id, purchaseId));
      expect(lot!.cigarId).toBe(source);
      const after = await getMyInventory(h.deps, owner);
      // 20, not the 24 a hold-back would report: the five returning consumptions
      // meet their lot again, and only the survivor's one is stranded.
      expect(after.totalSticksRemaining).toBe(20);
      expect(after.holdings.map((holding) => holding.cigar.cigarId)).toEqual([source]);
      expect(after.holdings[0]!.consumedCount).toBe(5);
    });

    it("returns a lot only the source's own returning smokes consumed", async () => {
      // The mirror case: every consumption belongs to a smoke coming back, so the
      // lot is not cross-cigar and the restore is exact.
      const owner = await h.createUser(`humidor-${newRequestId()}@example.com`);
      const source = await seedUnverified("Own Lot Source");
      const target = await seedUnverified("Own Lot Target");
      const purchaseId = await addPurchase(source, owner, 5);
      const smokeId = await addSmoke(source, owner);
      await h.deps.db.insert(smokeConsumptions).values({ smokeId, purchaseId });
      const mergeId = await merge(source, target);

      const result = await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });
      expect(result.restored.purchases).toBe(1);
      expect(result.crossCigarLots).toBe(0);
      expect(result.skipped).toEqual([]);
      const inventory = await getMyInventory(h.deps, owner);
      expect(inventory.totalSticksRemaining).toBe(4);
      expect(inventory.holdings.map((holding) => holding.cigar.cigarId)).toEqual([source]);
    });

    it("replays an identical retry and refuses a second, distinct request", async () => {
      const source = await seedUnverified("Unmerge Replay Source");
      const target = await seedUnverified("Unmerge Replay Target");
      await addSmoke(source);
      const mergeId = await merge(source, target);

      const input = { clientRequestId: newRequestId(), mergeId };
      const first = await unmergeCigars(h.deps, admin, input);
      const second = await unmergeCigars(h.deps, admin, input);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.undoAuditId).toBe(first.undoAuditId);

      // A different request id hits the ledger's single-use claim instead.
      const again = await unmergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        mergeId,
      }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ValidationError);

      // Exactly one cigar.unmerge audit, and the ledger stamped once.
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.unmerge"));
      expect(audits.filter((a) => (a.after as { mergeId?: string }).mergeId === mergeId)).toHaveLength(1);
      const [ledgerRow] = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.id, mergeId));
      expect(ledgerRow!.undoAuditId).toBe(first.undoAuditId);
    });

    it("serializes two concurrent unmerges of the same merge", async () => {
      // The claim is a conditional `UPDATE … SET undone_at WHERE undone_at IS NULL`
      // inside the transaction, so the loser blocks on the ledger row until the
      // winner commits and then matches zero rows. Two distinct clientRequestIds,
      // so idempotency cannot be what separates them — this races the claim itself,
      // on two pool connections.
      const source = await seedUnverified("Unmerge Race Source");
      const target = await seedUnverified("Unmerge Race Target");
      const smokeId = await addSmoke(source);
      const mergeId = await merge(source, target);

      const settled = await Promise.allSettled([
        unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId }),
        unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId }),
      ]);
      const won = settled.filter((r) => r.status === "fulfilled");
      const lost = settled.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const reason = (lost[0] as PromiseRejectedResult).reason as ValidationError;
      expect(reason).toBeInstanceOf(ValidationError);
      expect(reason.fields).toEqual([{ path: "mergeId", message: "This merge was already unmerged." }]);
      expect((won[0] as PromiseFulfilledResult<UnmergeCigarsResult>).value.replayed).toBe(false);

      // One restore, not two: one audit, one stamped ledger, the smoke moved once.
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.unmerge"));
      expect(audits.filter((a) => (a.after as { mergeId?: string }).mergeId === mergeId)).toHaveLength(1);
      const [ledger] = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.id, mergeId));
      expect(ledger!.undoneAt).not.toBeNull();
      const [smoke] = await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId));
      expect(smoke!.cigarId).toBe(source);
    });

    it("returns the pair to the duplicate queue", async () => {
      const plain = await seedUnverified("Unmerge Requeue Padron Anniversario Especial");
      const accented = await seedUnverified("Unmerge Requeue Padrón Anniversario Especial");
      const mergeId = await merge(accented, plain);

      const merged = await curationQueue(h.deps, admin);
      expect(
        merged.duplicates.find(
          (p) =>
            (p.a.cigarId === plain && p.b.cigarId === accented) ||
            (p.a.cigarId === accented && p.b.cigarId === plain),
        ),
      ).toBeUndefined();

      await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId });

      const after = await curationQueue(h.deps, admin);
      expect(
        after.duplicates.find(
          (p) =>
            (p.a.cigarId === plain && p.b.cigarId === accented) ||
            (p.a.cigarId === accented && p.b.cigarId === plain),
        ),
      ).toBeDefined();
    });

    // The drift guard: every table with a foreign key to `cigars` is either a
    // ledger slot or a documented exclusion. A new referencing table fails here
    // rather than silently escaping the merge/unmerge bookkeeping.
    it("covers every cigar-referencing table or documents why not", async () => {
      const result = await h.deps.db.execute(sql`
        SELECT DISTINCT c.conrelid::regclass::text AS table_name
        FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confrelid = 'cigars'::regclass
      `);
      const referencing = (result.rows as unknown as { table_name: string }[]).map((r) => r.table_name);
      const excluded = [
        "cigars", // the merged_into self-FK — the tombstone pointer, restored explicitly
        "duplicate_dismissals", // cascade-only; the pair verdict survives on the tombstone
        "photo_upload_tokens", // short-lived and single-use; a merge outlives them
        "cigar_merges", // the ledger itself
      ];
      const covered = MERGE_LEDGER_TABLES.map((t) => t.table as string);
      expect([...referencing].sort()).toEqual([...covered, ...excluded].sort());
    });
  });


  // --- recentMerges (the console's merge history) ---------------------------

  describe("recentMerges", () => {
    it("rejects a non-admin principal", async () => {
      const error = await recentMerges(h.deps, user).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("lists newest first with moved counts, undone state and a reversible flag", async () => {
      const source = await seedUnverified("Recent Merge Source");
      const target = await seedUnverified("Recent Merge Target");
      await addSmoke(source);
      await addSmoke(source);
      await setWant(h.deps, user, { cigarId: source, wanted: true });
      await setWant(h.deps, user, { cigarId: target, wanted: true }); // de-duped away
      const merged = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });

      const { merges } = await recentMerges(h.deps, admin);
      expect(merges[0]!.mergeId).toBe(merged.mergeId); // newest first
      const row = merges.find((m) => m.mergeId === merged.mergeId)!;
      expect(row.source).toEqual({ cigarId: source, canonicalName: "Recent Merge Source" });
      expect(row.target).toEqual({ cigarId: target, canonicalName: "Recent Merge Target" });
      expect(row.moved).toEqual([
        { entity: "smokes", count: 2 },
        // The de-duped mark counts too: an unmerge re-creates it.
        { entity: "wants", count: 1 },
      ]);
      expect(row.undone).toBe(false);
      expect(row.undoneAt).toBeNull();
      expect(row.reversible).toBe(true);
      expect(row.blockedByLaterMerge).toBe(false);

      await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId: merged.mergeId });
      const after = await recentMerges(h.deps, admin);
      const undone = after.merges.find((m) => m.mergeId === merged.mergeId)!;
      expect(undone.undone).toBe(true);
      expect(undone.undoneAt).not.toBeNull();
      expect(undone.reversible).toBe(false);
    });

    it("marks a merge blocked when the survivor was itself later merged", async () => {
      const a = await seedUnverified("Recent Chain A");
      const b = await seedUnverified("Recent Chain B");
      const c = await seedUnverified("Recent Chain C");
      const ab = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: a,
        targetCigarId: b,
      });
      const bc = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: b,
        targetCigarId: c,
      });

      const { merges } = await recentMerges(h.deps, admin);
      const earlier = merges.find((m) => m.mergeId === ab.mergeId)!;
      expect(earlier.blockedByLaterMerge).toBe(true);
      expect(earlier.reversible).toBe(false);
      const later = merges.find((m) => m.mergeId === bc.mergeId)!;
      expect(later.blockedByLaterMerge).toBe(false);
      expect(later.reversible).toBe(true);
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

    it("stamps decided_by='curator' for a web verdict (default attribution)", async () => {
      const cigarId = await seedUnverified("LM Curator Stamp");
      const matchId = await addMatch(cigarId); // crawler-created row
      await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId,
        status: "unmatched",
      });
      const [row] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, matchId));
      expect(row!.decidedBy).toBe("curator");
      // The provenance also rides the audit after-snapshot.
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "listing_match.set_status"));
      const audit = audits.find((a) => (a.after as { id?: string }).id === matchId);
      expect((audit!.after as { decidedBy?: string }).decidedBy).toBe("curator");
    });

    it("stamps decided_by='agent' when the agent surface passes actor='agent'", async () => {
      const cigarId = await seedUnverified("LM Agent Stamp");
      const matchId = await addMatch(cigarId);
      await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId,
        status: "confirmed",
        attribution: { actor: "agent", runId: "wo-cigar-curate-20260829", confidence: 0.9 },
      });
      const [row] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, matchId));
      expect(row!.decidedBy).toBe("agent");
    });

    // Migration 0023 / ADR-011. The service-token threat row claims a leak is
    // attributable because there is one client per consumer — which is only true
    // if the write says which client made it. Two credentials of the SAME admin
    // subject, running the SAME tool with the SAME agent attribution, must leave
    // separable history; otherwise a leaked curation token walking the triage
    // queue is indistinguishable afterwards from the daily lane doing its job.
    it("records the calling credential's client, so two tokens of one subject are separable", async () => {
      const lane: Principal = { ...admin, clientId: "svc-curation-lane" };
      const leaked: Principal = { ...admin, clientId: "svc-dev-env-pod" };
      const runId = `attribution-${newRequestId()}`;

      const byLane = await addMatch(await seedUnverified("LM Lane"));
      await setListingMatchStatus(h.deps, lane, {
        clientRequestId: newRequestId(),
        matchId: byLane,
        status: "unmatched",
        attribution: { actor: "agent", runId, confidence: 0.9 },
      });
      const byLeaked = await addMatch(await seedUnverified("LM Leaked"));
      await setListingMatchStatus(h.deps, leaked, {
        clientRequestId: newRequestId(),
        matchId: byLeaked,
        status: "unmatched",
        attribution: { actor: "agent", runId, confidence: 0.9 },
      });

      const rows = await h.deps.db.select().from(auditLog).where(eq(auditLog.runId, runId));
      const clientOf = (matchId: string): string | null =>
        rows.find((r) => (r.after as { id?: string }).id === matchId)!.clientId;
      expect(clientOf(byLane)).toBe("svc-curation-lane");
      expect(clientOf(byLeaked)).toBe("svc-dev-env-pod");

      // The console has no OAuth client, so its rows stay null — the column
      // separates credentials, it does not invent one for session-driven work.
      const console = await addMatch(await seedUnverified("LM Console"));
      const correlationId = newRequestId();
      await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId: console,
        status: "unmatched",
        correlationId,
      });
      const [web] = await h.deps.db.select().from(auditLog).where(eq(auditLog.correlationId, correlationId));
      expect(web!.clientId).toBeNull();
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

    // --- held inventory is never excludable (#169) --------------------------
    // The regression these pin actually happened: the curate agent's first run
    // excluded three samplers the owner held and 23 sticks left the humidor.

    it("refuses a cigar with a purchase lot, names the counts, and writes nothing", async () => {
      const cigarId = await seedUnverified("Excl Held Sampler");
      await addPurchase(cigarId, user, 10);
      await addPurchase(cigarId, user, 13);

      const error = await excludeCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      const fields = (error as ValidationError).fields;
      expect(fields[0]!.path).toBe("cigarId");
      // The counts are the actionable part — a curator who only sees "held" has to
      // go to psql to find out what they are holding.
      expect(fields[0]!.message).toContain("2 purchase lots");
      expect(fields[0]!.message).toContain("23 sticks");

      // The whole transaction rolled back: still active, and no exclude audit.
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.catalogStatus).toBe("active");
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.exclude"));
      expect(audits.find((a) => (a.after as { id?: string }).id === cigarId)).toBeUndefined();
    });

    it("refuses when the only lot belongs to ANOTHER user", async () => {
      // The rule the issue turns on. A `principal.userId` filter would pass this
      // and hide someone else's humidor — the curator is not the only owner.
      const other = await h.createUser(`holder-${newRequestId().slice(0, 8)}@example.com`);
      const cigarId = await seedUnverified("Excl Held By Other");
      await addPurchase(cigarId, other, 5);

      const error = await excludeCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("1 purchase lot");
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.catalogStatus).toBe("active");
    });

    it("still refuses when the lot is fully consumed", async () => {
      // Pins "any purchases row", not "remaining > 0": `remaining` is derived and
      // floors at zero, so a stock test would make excludability flicker as the
      // owner smokes — and a spent lot is still a journal entry's provenance.
      const cigarId = await seedUnverified("Excl Held Consumed");
      const purchaseId = await addPurchase(cigarId, user, 1);
      const smokeId = await addSmoke(cigarId, user);
      await h.deps.db.insert(smokeConsumptions).values({ smokeId, purchaseId });

      const inventory = await getMyInventory(h.deps, user);
      const holding = inventory.holdings.find((x) => x.cigar.cigarId === cigarId)!;
      expect(holding.remaining).toBe(0);

      const error = await excludeCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.catalogStatus).toBe("active");
    });

    it("leaves the unheld happy path alone, cascade included", async () => {
      // The guard must not cost the #126 behaviour: a cigar nobody bought still
      // excludes AND still unmatches its 'auto' listing links in the same tx.
      const cigarId = await h.seedCigar({ canonicalName: `Excl Unheld ${newRequestId().slice(0, 8)}` });
      const [match] = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `unheld-${newRequestId()}`, cigarId, status: "auto" })
        .returning({ id: listingMatches.id });

      const result = await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId });
      expect(result.catalogStatus).toBe("excluded");
      const [link] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, match!.id));
      expect(link!.status).toBe("unmatched");
      expect(link!.cigarId).toBeNull();
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

  // --- setCigarFacts (DESIGN-003 wave 4a) -----------------------------------

  describe("setCigarFacts", () => {
    it("rejects a non-admin principal", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Facts Reject" });
      const error = await setCigarFacts(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "X" },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("OVERWRITES a wrong value on a verified cigar and audits before→after (unlike update_cigar)", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: "Overwrite Me",
        brand: "Wrong",
        type: "NC",
        verification: "verified",
      });
      const runId = newRequestId();
      const result = await setCigarFacts(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "Padron", line: "1926", type: "CC" },
        attribution: { actor: "agent", runId, confidence: 0.87 },
      });
      expect([...result.changedFields].sort()).toEqual(["brand", "line", "type"]);
      expect(result.verification).toBe("verified");

      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.brand).toBe("Padron");
      expect(row!.line).toBe("1926");
      expect(row!.type).toBe("CC");

      const [audit] = await h.deps.db.select().from(auditLog).where(eq(auditLog.runId, runId));
      expect(audit!.action).toBe("cigar.set_facts");
      expect(audit!.actor).toBe("agent");
      expect(audit!.confidence).toBeCloseTo(0.87, 5);
      expect((audit!.before as Record<string, unknown>).brand).toBe("Wrong");
      expect((audit!.after as Record<string, unknown>).brand).toBe("Padron");
    });

    it("leaves omitted fields untouched, clears with null, and reports unchanged no-ops", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: "Selective Facts",
        brand: "Keep",
        line: "DropMe",
        manufacturer: "Same",
        verification: "unverified",
      });
      const result = await setCigarFacts(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        // brand omitted (untouched); line null (clear); manufacturer identical (no-op); type set.
        fields: { line: null, manufacturer: "Same", type: "NC" },
      });
      expect([...result.changedFields].sort()).toEqual(["line", "type"]);
      expect(result.unchanged).toEqual(["manufacturer"]);

      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.brand).toBe("Keep");
      expect(row!.line).toBeNull();
      expect(row!.manufacturer).toBe("Same");
      expect(row!.type).toBe("NC");
    });

    it("defaults actor to web with null run fields when no attribution is passed (web-console parity)", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Web Facts", brand: "Old" });
      const correlationId = newRequestId();
      await setCigarFacts(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "New" },
        correlationId,
      });
      const rows = await h.deps.db.select().from(auditLog).where(eq(auditLog.correlationId, correlationId));
      const audit = rows.find((r) => r.action === "cigar.set_facts");
      expect(audit!.actor).toBe("web");
      expect(audit!.runId).toBeNull();
      expect(audit!.confidence).toBeNull();
    });

    it("writes nothing when every supplied field already matches", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "No-op Facts", brand: "Same", type: "CC" });
      const result = await setCigarFacts(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "Same", type: "CC" },
      });
      expect(result.changedFields).toEqual([]);
      expect([...result.unchanged].sort()).toEqual(["brand", "type"]);
    });

    it("throws CigarNotFoundError for an unknown cigar", async () => {
      const error = await setCigarFacts(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId: newRequestId(),
        fields: { brand: "X" },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CigarNotFoundError);
    });

    it("replays an identical retry", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Facts Replay", brand: "A" });
      const input = { clientRequestId: newRequestId(), cigarId, fields: { brand: "B" } };
      const first = await setCigarFacts(h.deps, admin, input);
      const second = await setCigarFacts(h.deps, admin, input);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
    });
  });

  // --- curationWorklist (the paged drain queue) -----------------------------

  describe("curationWorklist", () => {
    // Drain a cigar-shaped kind to exhaustion — robust to the accumulated catalog
    // (other tests seed rows at 2020/2026 dates), so assertions never assume a
    // page-1 position.
    async function drainCigars(
      kind: "unverified" | "unbranded" | "untyped" | "missing_photos",
    ): Promise<WorklistCigar[]> {
      const out: WorklistCigar[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 500; i++) {
        const page = await curationWorklist(h.deps, admin, { kind, limit: 200, cursor });
        out.push(...(page.cigars ?? []));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return out;
    }

    it("rejects a non-admin principal", async () => {
      const error = await curationWorklist(h.deps, user, { kind: "unverified" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("unverified surfaces active unverified cigars with their facts and excludes excluded rows", async () => {
      const active = await seedUnverified("Worklist Active Entry");
      const excluded = await seedUnverified("Worklist Excluded Entry");
      await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId: excluded });

      const all = await drainCigars("unverified");
      const byId = new Map(all.map((c) => [c.cigarId, c]));
      expect(byId.has(active)).toBe(true);
      expect(byId.has(excluded)).toBe(false);
      const row = byId.get(active)!;
      expect(row.canonicalName).toBe("Worklist Active Entry");
      expect(row.verification).toBe("unverified");
    });

    it("reports heldLots so the agent can anticipate the exclude refusal", async () => {
      // Without this the agent cannot tell a held row from a pile of gift cards and
      // learns only by refusal, once per row, on every run (#169).
      const held = await seedUnverified("Worklist Held Entry");
      const unheld = await seedUnverified("Worklist Unheld Entry");
      await addPurchase(held, user, 4);
      await addPurchase(held, admin, 1); // another user's lot counts too

      const byId = new Map((await drainCigars("unverified")).map((c) => [c.cigarId, c]));
      expect(byId.get(held)!.heldLots).toBe(2);
      expect(byId.get(unheld)!.heldLots).toBe(0);
    });

    it("pages by keyset with no overlap and in createdAt order", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z").getTime();
      const mine: string[] = [];
      for (let i = 0; i < 3; i++) {
        const [row] = await h.deps.db
          .insert(cigars)
          .values({
            canonicalName: `WL Page ${i} ${newRequestId().slice(0, 6)}`,
            verification: "unverified",
            createdAt: new Date(t0 + i * 1000),
          })
          .returning({ id: cigars.id });
        mine.push(row!.id);
      }
      // Walk the whole backlog in pages of two.
      const collected: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 500; i++) {
        const page = await curationWorklist(h.deps, admin, { kind: "unverified", limit: 2, cursor });
        expect(page.cigars!.length).toBeLessThanOrEqual(2);
        collected.push(...page.cigars!.map((c) => c.cigarId));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      // No id repeated across pages.
      expect(new Set(collected).size).toBe(collected.length);
      // Our three are present and in the order we created them.
      const pos = mine.map((id) => collected.indexOf(id));
      for (const p of pos) expect(p).toBeGreaterThanOrEqual(0);
      expect(pos[0]!).toBeLessThan(pos[1]!);
      expect(pos[1]!).toBeLessThan(pos[2]!);
    });

    it("unbranded / untyped / missing_photos filter to the right rows", async () => {
      const unbranded = await h.seedCigar({ canonicalName: "WL No Brand", type: "NC" }); // brand null
      const untyped = await h.seedCigar({ canonicalName: "WL No Type", brand: "Brandy" }); // type null
      const withPhoto = await h.seedCigar({ canonicalName: "WL Has Photo", brand: "B", type: "NC" });
      await addProductPhoto(withPhoto, "wl-has-photo");
      const noPhoto = await h.seedCigar({ canonicalName: "WL No Photo", brand: "B", type: "NC" });

      const ub = await drainCigars("unbranded");
      expect(ub.some((c) => c.cigarId === unbranded)).toBe(true);
      expect(ub.every((c) => c.brand === null)).toBe(true);

      const ut = await drainCigars("untyped");
      expect(ut.some((c) => c.cigarId === untyped)).toBe(true);
      expect(ut.every((c) => c.type === null)).toBe(true);

      const mp = await drainCigars("missing_photos");
      const mpIds = new Set(mp.map((c) => c.cigarId));
      expect(mpIds.has(noPhoto)).toBe(true);
      expect(mpIds.has(withPhoto)).toBe(false);
    });

    it("match_triage surfaces auto matches with the listing url and matched cigar facts", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "WL Match Cigar", brand: "MatchBrand", type: "NC" });
      const [match] = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `wl-${newRequestId().slice(0, 8)}`, cigarId, status: "auto" })
        .returning({ id: listingMatches.id });
      await h.deps.db.insert(offers).values({ vendorId, listingMatchId: match!.id, listingUrl: "https://shop.example/wl" });

      let found: WorklistMatch | undefined;
      let cursor: string | null = null;
      for (let i = 0; i < 500 && !found; i++) {
        const page = await curationWorklist(h.deps, admin, { kind: "match_triage", limit: 200, cursor });
        found = page.matches!.find((m) => m.matchId === match!.id);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(found).toBeTruthy();
      expect(found!.listingUrl).toBe("https://shop.example/wl");
      expect(found!.cigar?.cigarId).toBe(cigarId);
      expect(found!.cigar?.brand).toBe("MatchBrand");
    });

    it("duplicates returns near-duplicate pairs (reachable by paging)", async () => {
      await h.seedCigar({ canonicalName: "Zzyzx Dup Alpha Robusto" });
      await h.seedCigar({ canonicalName: "Zzyzx Dup Alpha Robustoo" });

      let found = false;
      let cursor: string | null = null;
      for (let i = 0; i < 500 && !found; i++) {
        const page = await curationWorklist(h.deps, admin, { kind: "duplicates", limit: 200, cursor });
        found = page.duplicates!.some(
          (p) => p.a.canonicalName.startsWith("Zzyzx Dup Alpha") && p.b.canonicalName.startsWith("Zzyzx Dup Alpha"),
        );
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(found).toBe(true);
    });
  });

  // --- excludeCigar → match_triage cascade (DESIGN-003 wave 4b, #126) --------

  describe("excludeCigar → triage cascade", () => {
    async function addAutoMatch(cigarId: string): Promise<string> {
      const [m] = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `casc-${newRequestId()}`, cigarId, status: "auto" })
        .returning({ id: listingMatches.id });
      return m!.id;
    }

    it("unmatches the cigar's auto listings in-transaction and records them on the exclude audit", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Cascade ${newRequestId().slice(0, 8)}` });
      const matchId = await addAutoMatch(cigarId);

      await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId });

      const [match] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, matchId));
      expect(match!.status).toBe("unmatched");
      expect(match!.cigarId).toBeNull();

      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.exclude"));
      const audit = audits.find((a) => (a.after as { id?: string }).id === cigarId)!;
      expect((audit.after as { cascadeUnmatched?: string[] }).cascadeUnmatched).toEqual([matchId]);
    });

    it("keeps the excluded cigar's auto match out of match_triage", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Triage Gone ${newRequestId().slice(0, 8)}` });
      const matchId = await addAutoMatch(cigarId);

      // Before exclusion it is a triage candidate.
      const surfaced = async (): Promise<boolean> => {
        let cursor: string | null = null;
        for (let i = 0; i < 500; i++) {
          const page = await curationWorklist(h.deps, admin, { kind: "match_triage", limit: 200, cursor });
          if (page.matches!.some((m) => m.matchId === matchId)) return true;
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        return false;
      };
      expect(await surfaced()).toBe(true);

      await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId });
      expect(await surfaced()).toBe(false);
    });

    it("also filters an auto match still pointing at an already-excluded cigar", async () => {
      // Simulate the prod state: an excluded cigar with a leftover 'auto' match
      // (the crawler could re-propose one after exclusion). The read filter, not the
      // cascade, must keep it out of triage.
      const cigarId = await h.seedCigar({ canonicalName: `Leftover ${newRequestId().slice(0, 8)}` });
      await excludeCigar(h.deps, admin, { clientRequestId: newRequestId(), cigarId });
      const matchId = await addAutoMatch(cigarId); // an 'auto' link re-created post-exclusion

      let cursor: string | null = null;
      let seen = false;
      for (let i = 0; i < 500; i++) {
        const page = await curationWorklist(h.deps, admin, { kind: "match_triage", limit: 200, cursor });
        if (page.matches!.some((m) => m.matchId === matchId)) seen = true;
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toBe(false);
    });
  });

  // --- renameCigar (#45; DESIGN-003 wave 4b) --------------------------------

  describe("renameCigar", () => {
    it("rejects a non-admin principal", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Rename Reject" });
      const error = await renameCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        canonicalName: "Nope",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("sets the canonical name (trimmed) and audits before→after", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Padron 1926 No 9 Maldura" });
      const result = await renameCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        canonicalName: "  Padrón 1926 No. 9 Maduro  ",
      });
      expect(result.changed).toBe(true);
      expect(result.canonicalName).toBe("Padrón 1926 No. 9 Maduro");
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.canonicalName).toBe("Padrón 1926 No. 9 Maduro");
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.rename"));
      const audit = audits.find((a) => (a.after as { id?: string }).id === cigarId)!;
      expect((audit.before as { canonicalName?: string }).canonicalName).toBe("Padron 1926 No 9 Maldura");
      expect((audit.after as { canonicalName?: string }).canonicalName).toBe("Padrón 1926 No. 9 Maduro");
    });

    it("is a no-op (no audit) when the name already matches", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Already Right" });
      const result = await renameCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        canonicalName: "Already Right",
      });
      expect(result.changed).toBe(false);
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.rename"));
      expect(audits.find((a) => (a.after as { id?: string }).id === cigarId)).toBeUndefined();
    });

    it("rejects an empty name", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Keeps Name" });
      const error = await renameCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        canonicalName: "   ",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
    });

    it("replays an identical retry", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Rename Replay A" });
      const input = { clientRequestId: newRequestId(), cigarId, canonicalName: "Rename Replay B" };
      const first = await renameCigar(h.deps, admin, input);
      const second = await renameCigar(h.deps, admin, input);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
    });
  });

  // --- Recent agent runs + Undo (DESIGN-003 wave 4b, #126) ------------------

  describe("agent runs + undo", () => {
    const RUN = "wo-cigar-test-run";

    it("groups agent audit rows by run_id, newest first, with per-action counts", async () => {
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const a = await h.seedCigar({ canonicalName: `Run A ${newRequestId().slice(0, 6)}`, verification: "unverified" });
      const b = await h.seedCigar({ canonicalName: `Run B ${newRequestId().slice(0, 6)}`, brand: "Old" });
      await verifyCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId: a,
        attribution: { actor: "agent", runId, confidence: 0.9 },
      });
      await setCigarFacts(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId: b,
        fields: { brand: "New" },
        attribution: { actor: "agent", runId, confidence: 0.8 },
      });

      const { runs } = await agentRuns(h.deps, admin);
      const run = runs.find((r) => r.runId === runId)!;
      expect(run).toBeDefined();
      expect(run.total).toBe(2);
      const byAction = new Map(run.actions.map((x) => [x.action, x.count]));
      expect(byAction.get("cigar.verify")).toBe(1);
      expect(byAction.get("cigar.set_facts")).toBe(1);
    });

    it("run rows carry the target name, confidence, summary, and reversible flag", async () => {
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: "Rows Target", brand: "Before" });
      await setCigarFacts(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "After" },
        attribution: { actor: "agent", runId, confidence: 0.75 },
      });
      const { rows } = await agentRunRows(h.deps, admin, { runId });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.action).toBe("cigar.set_facts");
      expect(row.targetName).toBe("Rows Target");
      expect(row.confidence).toBeCloseTo(0.75, 5);
      expect(row.summary).toContain("brand: Before → After");
      expect(row.reversible).toBe(true);
      expect(row.reverted).toBe(false);
    });

    // The id of a run's audit row for a given action (a run may have several rows).
    async function agentAudit(runId: string, action: string): Promise<string> {
      const rows = await h.deps.db.select().from(auditLog).where(eq(auditLog.runId, runId));
      return rows.find((r) => r.action === action)!.id;
    }

    it("undo of an exclude restores the cigar and links reverts", async () => {
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: "Undo Exclude" });
      await excludeCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        attribution: { actor: "agent", runId, confidence: 1 },
      });
      const auditId = await agentAudit(runId, "cigar.exclude");

      const result = await undoCurationAction(h.deps, admin, { clientRequestId: newRequestId(), auditId });
      expect(result.action).toBe("cigar.exclude");
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.catalogStatus).toBe("active");
      const [undo] = await h.deps.db.select().from(auditLog).where(eq(auditLog.id, result.undoAuditId));
      expect(undo!.action).toBe("cigar.restore");
      expect(undo!.reverts).toBe(auditId);
      expect(undo!.actor).toBe("web");

      // The row now shows reverted (state, not a button) and refuses a second undo.
      const { rows } = await agentRunRows(h.deps, admin, { runId });
      expect(rows[0]!.reverted).toBe(true);
      expect(rows[0]!.reversible).toBe(false);
      const again = await undoCurationAction(h.deps, admin, {
        clientRequestId: newRequestId(),
        auditId,
      }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ValidationError);
    });

    it("undo of a verify flips back to unverified", async () => {
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: "Undo Verify", verification: "unverified" });
      await verifyCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        attribution: { actor: "agent", runId, confidence: 1 },
      });
      const auditId = await agentAudit(runId, "cigar.verify");
      const result = await undoCurationAction(h.deps, admin, { clientRequestId: newRequestId(), auditId });
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.verification).toBe("unverified");
      const [undo] = await h.deps.db.select().from(auditLog).where(eq(auditLog.id, result.undoAuditId));
      expect(undo!.action).toBe("cigar.unverify");
      expect(undo!.reverts).toBe(auditId);
    });

    it("undo of a listing_match verdict restores the prior status and cigar link", async () => {
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: "Undo Match" });
      const [m] = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `undo-${newRequestId()}`, cigarId, status: "auto" })
        .returning({ id: listingMatches.id });
      await setListingMatchStatus(h.deps, admin, {
        clientRequestId: newRequestId(),
        matchId: m!.id,
        status: "unmatched",
        attribution: { actor: "agent", runId, confidence: 1 },
      });
      const auditId = await agentAudit(runId, "listing_match.set_status");
      await undoCurationAction(h.deps, admin, { clientRequestId: newRequestId(), auditId });
      const [row] = await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, m!.id));
      expect(row!.status).toBe("auto");
      expect(row!.cigarId).toBe(cigarId);
    });

    it("undo of a photo-rights change restores the prior rights", async () => {
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: "Undo Rights" });
      await addProductPhoto(cigarId, `pr-${newRequestId().slice(0, 6)}`);
      await setProductPhotoRights(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        rights: "suppressed",
        attribution: { actor: "agent", runId, confidence: 1 },
      });
      const auditId = await agentAudit(runId, "product_photo.set_rights");
      await undoCurationAction(h.deps, admin, { clientRequestId: newRequestId(), auditId });
      const [photo] = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId));
      expect(photo!.rights).toBe("pending");
    });

    it("undo of set_facts writes the before-values back", async () => {
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: "Undo Facts", brand: "Original", type: null });
      await setCigarFacts(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "Changed", type: "CC" },
        attribution: { actor: "agent", runId, confidence: 1 },
      });
      const auditId = await agentAudit(runId, "cigar.set_facts");
      await undoCurationAction(h.deps, admin, { clientRequestId: newRequestId(), auditId });
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.brand).toBe("Original");
      expect(row!.type).toBeNull();
    });

    it("undo of an agent rename writes the prior canonical name back", async () => {
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: "Undo Rename Before" });
      await renameCigar(h.deps, admin, {
        clientRequestId: newRequestId(),
        cigarId,
        canonicalName: "Undo Rename After",
        attribution: { actor: "agent", runId, confidence: 1 },
      });

      const listed = await agentRunRows(h.deps, admin, { runId });
      expect(listed.rows[0]!.action).toBe("cigar.rename");
      expect(listed.rows[0]!.targetName).toBe("Undo Rename After");
      expect(listed.rows[0]!.summary).toBe("Undo Rename Before → Undo Rename After");
      expect(listed.rows[0]!.reversible).toBe(true);

      const auditId = await agentAudit(runId, "cigar.rename");
      const result = await undoCurationAction(h.deps, admin, { clientRequestId: newRequestId(), auditId });
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.canonicalName).toBe("Undo Rename Before");
      const [undo] = await h.deps.db.select().from(auditLog).where(eq(auditLog.id, result.undoAuditId));
      expect(undo!.action).toBe("cigar.rename");
      expect(undo!.actor).toBe("web");
      expect(undo!.reverts).toBe(auditId);
      expect((undo!.before as { canonicalName?: string }).canonicalName).toBe("Undo Rename After");
      expect((undo!.after as { canonicalName?: string }).canonicalName).toBe("Undo Rename Before");

      const after = await agentRunRows(h.deps, admin, { runId });
      const original = after.rows.find((r) => r.auditId === auditId)!;
      expect(original.reverted).toBe(true);
      expect(original.reversible).toBe(false);
      const again = await undoCurationAction(h.deps, admin, {
        clientRequestId: newRequestId(),
        auditId,
      }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ValidationError);
    });

    it("refuses to undo a rename the cigar has moved past, and keeps the newer name", async () => {
      // canonicalName is identity and nothing versions it: writing an older audit's
      // prior name back would discard a NEWER rename silently. The daily agent
      // renaming the same cigar twice is the live shape.
      const runId = `${RUN}-${newRequestId().slice(0, 8)}`;
      const cigarId = await h.seedCigar({ canonicalName: "Q2 Original" });
      for (const canonicalName of ["Q2 First Fix", "Q2 Second Fix"]) {
        await renameCigar(h.deps, admin, {
          clientRequestId: newRequestId(),
          cigarId,
          canonicalName,
          attribution: { actor: "agent", runId, confidence: 1 },
        });
      }

      const { rows } = await agentRunRows(h.deps, admin, { runId });
      const stale = rows.find((r) => r.summary === "Q2 Original → Q2 First Fix")!;
      const current = rows.find((r) => r.summary === "Q2 First Fix → Q2 Second Fix")!;
      // The console offers Undo only on the rename that is still the cigar's name.
      expect(stale.reversible).toBe(false);
      expect(current.reversible).toBe(true);

      const error = await undoCurationAction(h.deps, admin, {
        clientRequestId: newRequestId(),
        auditId: stale.auditId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields).toEqual([
        { path: "auditId", message: "This rename is no longer the cigar's current name." },
      ]);
      const [untouched] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(untouched!.canonicalName).toBe("Q2 Second Fix");

      // The latest rename still undoes — one step back, not all the way to raw.
      await undoCurationAction(h.deps, admin, {
        clientRequestId: newRequestId(),
        auditId: current.auditId,
      });
      const [row] = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId));
      expect(row!.canonicalName).toBe("Q2 First Fix");
    });

    it("undo of a merge with a live ledger performs the full unmerge", async () => {
      const source = await h.seedCigar({ canonicalName: `Merge Undo Src ${newRequestId().slice(0, 6)}` });
      const target = await h.seedCigar({ canonicalName: `Merge Undo Tgt ${newRequestId().slice(0, 6)}` });
      const [smoke] = await h.deps.db
        .insert(smokes)
        .values({ userId: user.userId, cigarId: source, provenanceSource: "manual" })
        .returning({ id: smokes.id });
      const merged = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.merge"));
      const mergeAudit = audits.find((a) => (a.after as { tombstonedSourceId?: string }).tombstonedSourceId === source)!;

      const result = await undoCurationAction(h.deps, admin, {
        clientRequestId: newRequestId(),
        auditId: mergeAudit.id,
      });
      expect(result.action).toBe("cigar.merge");
      const [undo] = await h.deps.db.select().from(auditLog).where(eq(auditLog.id, result.undoAuditId));
      expect(undo!.action).toBe("cigar.unmerge");
      expect(undo!.reverts).toBe(mergeAudit.id);

      const [row] = await h.deps.db.select().from(smokes).where(eq(smokes.id, smoke!.id));
      expect(row!.cigarId).toBe(source);
      const [sourceRow] = await h.deps.db.select().from(cigars).where(eq(cigars.id, source));
      expect(sourceRow!.catalogStatus).toBe("active");
      const [ledgerRow] = await h.deps.db.select().from(cigarMerges).where(eq(cigarMerges.id, merged.mergeId));
      expect(ledgerRow!.undoAuditId).toBe(result.undoAuditId);

      // A second undo is refused by the `reverts` guard the unmerge audit installed.
      const again = await undoCurationAction(h.deps, admin, {
        clientRequestId: newRequestId(),
        auditId: mergeAudit.id,
      }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ValidationError);
    });

    it("reports a merge undone by the console's Unmerge as already undone", async () => {
      const source = await h.seedCigar({ canonicalName: `Standalone Src ${newRequestId().slice(0, 6)}` });
      const target = await h.seedCigar({ canonicalName: `Standalone Tgt ${newRequestId().slice(0, 6)}` });
      const merged = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });
      // Reversed through the "Recent merges" section, not the Undo button — the
      // `cigar.unmerge` audit reverts-links the merge either way, so Undo sees it.
      await unmergeCigars(h.deps, admin, { clientRequestId: newRequestId(), mergeId: merged.mergeId });
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.merge"));
      const mergeAudit = audits.find((a) => (a.after as { tombstonedSourceId?: string }).tombstonedSourceId === source)!;

      const error = await undoCurationAction(h.deps, admin, {
        clientRequestId: newRequestId(),
        auditId: mergeAudit.id,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("already undone");
    });

    it("refuses to undo a merge with no ledger (audited before migration 0020)", async () => {
      const source = await h.seedCigar({ canonicalName: `Legacy Merge Src ${newRequestId().slice(0, 6)}` });
      const target = await h.seedCigar({ canonicalName: `Legacy Merge Tgt ${newRequestId().slice(0, 6)}` });
      const merged = await mergeCigars(h.deps, admin, {
        clientRequestId: newRequestId(),
        sourceCigarId: source,
        targetCigarId: target,
      });
      // Stand in for a merge audited before the ledger existed: the audit row
      // survives, the bookkeeping does not.
      await h.deps.db.delete(cigarMerges).where(eq(cigarMerges.id, merged.mergeId));
      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "cigar.merge"));
      const mergeAudit = audits.find((a) => (a.after as { tombstonedSourceId?: string }).tombstonedSourceId === source)!;

      const error = await undoCurationAction(h.deps, admin, {
        clientRequestId: newRequestId(),
        auditId: mergeAudit.id,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      const [sourceRow] = await h.deps.db.select().from(cigars).where(eq(cigars.id, source));
      expect(sourceRow!.catalogStatus).toBe("merged");
    });

    it("rejects a non-admin principal", async () => {
      const error = await undoCurationAction(h.deps, user, {
        clientRequestId: newRequestId(),
        auditId: "00000000-0000-0000-0000-000000000000",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });
  });
});
