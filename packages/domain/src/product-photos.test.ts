import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, productPhotos, purchases, smokeConsumptions, smokes } from "@cj/db";
import { createMemoryPhotoStorage, type ProcessedPhoto } from "@cj/photos";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import {
  attachProductPhoto,
  getProductPhoto,
  getProductPhotoState,
  type ProcessProductPhoto,
} from "./product-photos.js";
import { cigarsMissingPhotos } from "./curation.js";
import { CigarNotFoundError, PhotoNotFoundError, UnauthorizedError } from "./errors.js";
import type { Principal } from "./index.js";

// The pipeline is injected, so these tests need neither sharp nor real image
// bytes (mirrors the crawler's fakeProcessPhoto). Echoes a tag through the "full"
// bytes so a replaced object is distinguishable if inspected.
function fakeProcessPhoto(tag: string): ProcessProductPhoto {
  return (input: Buffer, contentType: string): Promise<ProcessedPhoto> => {
    void input;
    void contentType;
    return Promise.resolve({
      full: Buffer.from(`full-${tag}`),
      thumb: Buffer.from(`thumb-${tag}`),
      contentType: "image/jpeg",
      width: 600,
      height: 800,
    });
  };
}

describe("product photos", () => {
  let h: DomainHarness;
  let admin: Principal;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    admin = await h.createUser("pp-curator@example.com", "admin");
    user = await h.createUser("pp-member@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function photoRow(cigarId: string) {
    const rows = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId));
    return rows[0];
  }

  describe("attachProductPhoto", () => {
    it("rejects a non-admin and writes nothing", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Attach Reject ${newRequestId()}` });
      const storage = createMemoryPhotoStorage();
      const error = await attachProductPhoto(h.deps, storage, fakeProcessPhoto("x"), user, {
        clientRequestId: newRequestId(),
        cigarId,
        image: Buffer.from("bytes"),
        contentType: "image/jpeg",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
      expect(await photoRow(cigarId)).toBeUndefined();
    });

    it("rejects an unknown cigar", async () => {
      const storage = createMemoryPhotoStorage();
      const error = await attachProductPhoto(h.deps, storage, fakeProcessPhoto("x"), admin, {
        clientRequestId: newRequestId(),
        cigarId: "00000000-0000-0000-0000-000000000000",
        image: Buffer.from("bytes"),
        contentType: "image/jpeg",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CigarNotFoundError);
    });

    // #206. A non-uuid cigarId used to reach the `uuid` column and raise Postgres
    // 22P02 — untyped, so it escaped this not-found path as a 500. The equality is
    // the contract: malformed must be INDISTINGUISHABLE from unknown-but-valid.
    it("attachProductPhoto answers a malformed id exactly as it answers an unknown one", async () => {
      const storage = createMemoryPhotoStorage();
      const attach = (cigarId: string) =>
        attachProductPhoto(h.deps, storage, fakeProcessPhoto("x"), admin, {
          clientRequestId: newRequestId(),
          cigarId,
          image: Buffer.from("bytes"),
          contentType: "image/jpeg",
        }).catch((e: unknown) => e);
      const malformed = await attach("not-a-uuid");
      const unknown = await attach(newRequestId());
      expect(malformed).toBeInstanceOf(CigarNotFoundError);
      expect(unknown).toBeInstanceOf(CigarNotFoundError);
      expect((malformed as CigarNotFoundError).toPayload()).toEqual(
        (unknown as CigarNotFoundError).toPayload(),
      );
    });

    it("attaches an approved photo, stores both objects under product/<id>/, and audits", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Attach OK ${newRequestId()}` });
      const storage = createMemoryPhotoStorage();
      const result = await attachProductPhoto(h.deps, storage, fakeProcessPhoto("one"), admin, {
        clientRequestId: newRequestId(),
        cigarId,
        image: Buffer.from("raw"),
        contentType: "image/png",
      });
      expect(result).toMatchObject({ cigarId, rights: "approved", replaced: false, replayed: false });

      const row = await photoRow(cigarId);
      expect(row).toBeDefined();
      expect(row!.rights).toBe("approved");
      expect(row!.sourceUrl).toBeNull();
      expect(row!.vendorId).toBeNull();
      // The object uuid is independent of the row's PK (as in the crawler); assert
      // the key SHAPE, and that full/thumb share one uuid.
      expect(row!.objectKey).toMatch(new RegExp(`^product/${cigarId}/[0-9a-f-]{36}\\.jpg$`));
      expect(row!.thumbKey).toBe(row!.objectKey.replace(/\.jpg$/, ".thumb.jpg"));
      // Both objects are actually in the bucket.
      await expect(storage.get(row!.objectKey)).resolves.toBeDefined();
      await expect(storage.get(row!.thumbKey)).resolves.toBeDefined();

      const audits = (
        await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "product_photo.attach"))
      ).filter((a) => (a.after as { cigarId?: string })?.cigarId === cigarId);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.before).toBeNull();
      expect(audits[0]!.actor).toBe("web");
    });

    it("replaces an existing photo: one row survives, old objects are dropped, audit carries the before", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Attach Replace ${newRequestId()}` });
      const storage = createMemoryPhotoStorage();
      await attachProductPhoto(h.deps, storage, fakeProcessPhoto("old"), admin, {
        clientRequestId: newRequestId(),
        cigarId,
        image: Buffer.from("old"),
        contentType: "image/jpeg",
      });
      const first = await photoRow(cigarId);

      const result = await attachProductPhoto(h.deps, storage, fakeProcessPhoto("new"), admin, {
        clientRequestId: newRequestId(),
        cigarId,
        image: Buffer.from("new"),
        contentType: "image/jpeg",
      });
      expect(result.replaced).toBe(true);

      // Exactly one row, and it is the new one.
      const rows = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).not.toBe(first!.id);
      // New objects present, old objects best-effort deleted.
      await expect(storage.get(rows[0]!.objectKey)).resolves.toBeDefined();
      await expect(storage.get(first!.objectKey)).rejects.toBeDefined();
      await expect(storage.get(first!.thumbKey)).rejects.toBeDefined();

      const audits = (
        await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "product_photo.attach"))
      ).filter((a) => (a.after as { cigarId?: string })?.cigarId === cigarId);
      const replaceAudit = audits.find((a) => a.before != null);
      expect(replaceAudit).toBeDefined();
      expect((replaceAudit!.before as { id: string }).id).toBe(first!.id);
    });

    it("replaces a suppressed photo (a takedown does not block re-upload)", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Attach Suppressed ${newRequestId()}` });
      await h.deps.db.insert(productPhotos).values({
        cigarId,
        objectKey: `product/${cigarId}/seed.jpg`,
        thumbKey: `product/${cigarId}/seed.thumb.jpg`,
        contentType: "image/jpeg",
        width: 600,
        height: 800,
        bytes: 10,
        rights: "suppressed",
      });
      const storage = createMemoryPhotoStorage();
      const result = await attachProductPhoto(h.deps, storage, fakeProcessPhoto("fresh"), admin, {
        clientRequestId: newRequestId(),
        cigarId,
        image: Buffer.from("fresh"),
        contentType: "image/jpeg",
      });
      expect(result).toMatchObject({ replaced: true, rights: "approved" });
      const rows = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.rights).toBe("approved");
    });

    it("is idempotent: a replay with the same request id and image returns replayed without a second object pair", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Attach Replay ${newRequestId()}` });
      const storage = createMemoryPhotoStorage();
      const clientRequestId = newRequestId();
      const image = Buffer.from("stable-bytes");
      const first = await attachProductPhoto(h.deps, storage, fakeProcessPhoto("r"), admin, {
        clientRequestId,
        cigarId,
        image,
        contentType: "image/jpeg",
      });
      expect(first.replayed).toBe(false);
      const row = await photoRow(cigarId);

      const second = await attachProductPhoto(h.deps, storage, fakeProcessPhoto("r"), admin, {
        clientRequestId,
        cigarId,
        image,
        contentType: "image/jpeg",
      });
      expect(second.replayed).toBe(true);
      // Still exactly one row, unchanged.
      const rows = await h.deps.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(row!.id);
    });
  });

  describe("getProductPhotoState", () => {
    it("is null with no row, echoes the rights with one, and is admin-only", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `State ${newRequestId()}` });
      expect(await getProductPhotoState(h.deps, admin, { cigarId })).toBeNull();

      const storage = createMemoryPhotoStorage();
      await attachProductPhoto(h.deps, storage, fakeProcessPhoto("s"), admin, {
        clientRequestId: newRequestId(),
        cigarId,
        image: Buffer.from("s"),
        contentType: "image/jpeg",
      });
      expect(await getProductPhotoState(h.deps, admin, { cigarId })).toEqual({ rights: "approved" });

      await expect(getProductPhotoState(h.deps, user, { cigarId })).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("getProductPhotoState answers a malformed id exactly as it answers an unknown one", async () => {
      // This read reports state rather than identity, so null — no row — is the
      // answer both cases share, and the control renders its Add state for each.
      const malformed = await getProductPhotoState(h.deps, admin, { cigarId: "not-a-uuid" });
      const unknown = await getProductPhotoState(h.deps, admin, { cigarId: newRequestId() });
      expect(malformed).toEqual(unknown);
      expect(malformed).toBeNull();
    });
  });

  describe("getProductPhoto", () => {
    it("answers a malformed id exactly as it answers an unknown one", async () => {
      const malformed = await getProductPhoto(h.deps, { cigarId: "not-a-uuid" }).catch(
        (e: unknown) => e,
      );
      const unknown = await getProductPhoto(h.deps, { cigarId: newRequestId() }).catch(
        (e: unknown) => e,
      );
      expect(malformed).toBeInstanceOf(PhotoNotFoundError);
      expect(unknown).toBeInstanceOf(PhotoNotFoundError);
      expect((malformed as PhotoNotFoundError).toPayload()).toEqual(
        (unknown as PhotoNotFoundError).toPayload(),
      );
    });
  });

  describe("cigarsMissingPhotos", () => {
    it("lists held photoless cigars, excludes photographed ones, includes suppressed-only, and is admin-only", async () => {
      // Held, no photo → listed.
      const held = await h.seedCigar({ canonicalName: `Missing Held ${newRequestId()}`, brand: "Padron" });
      await h.deps.db.insert(purchases).values({ userId: admin.userId, cigarId: held, quantity: 2 });

      // Held, has an approved photo → excluded.
      const shot = await h.seedCigar({ canonicalName: `Missing Shot ${newRequestId()}` });
      await h.deps.db.insert(purchases).values({ userId: admin.userId, cigarId: shot, quantity: 1 });
      await h.deps.db.insert(productPhotos).values({
        cigarId: shot,
        objectKey: `product/${shot}/a.jpg`,
        thumbKey: `product/${shot}/a.thumb.jpg`,
        contentType: "image/jpeg",
        width: 600,
        height: 800,
        bytes: 10,
        rights: "approved",
      });

      // Held, only a suppressed photo → still counts as missing.
      const sup = await h.seedCigar({ canonicalName: `Missing Suppressed ${newRequestId()}` });
      await h.deps.db.insert(purchases).values({ userId: admin.userId, cigarId: sup, quantity: 1 });
      await h.deps.db.insert(productPhotos).values({
        cigarId: sup,
        objectKey: `product/${sup}/b.jpg`,
        thumbKey: `product/${sup}/b.thumb.jpg`,
        contentType: "image/jpeg",
        width: 600,
        height: 800,
        bytes: 10,
        rights: "suppressed",
      });

      // Not held by admin (only the other user) → excluded from admin's worklist.
      const other = await h.seedCigar({ canonicalName: `Missing Other ${newRequestId()}` });
      await h.deps.db.insert(purchases).values({ userId: user.userId, cigarId: other, quantity: 1 });

      const result = await cigarsMissingPhotos(h.deps, admin);
      const ids = new Set(result.map((r) => r.cigarId));
      expect(ids.has(held)).toBe(true);
      expect(ids.has(sup)).toBe(true);
      expect(ids.has(shot)).toBe(false);
      expect(ids.has(other)).toBe(false);
      const heldRow = result.find((r) => r.cigarId === held);
      expect(heldRow).toMatchObject({ brand: "Padron", remaining: 2 });

      await expect(cigarsMissingPhotos(h.deps, user)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("nets consumption into remaining", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Missing Remaining ${newRequestId()}` });
      await h.deps.db.insert(purchases).values({ userId: admin.userId, cigarId, quantity: 3 });
      const [smoke] = await h.deps.db
        .insert(smokes)
        .values({ userId: admin.userId, cigarId, provenanceSource: "manual" })
        .returning({ id: smokes.id });
      await h.deps.db.insert(smokeConsumptions).values({ smokeId: smoke!.id });

      const result = await cigarsMissingPhotos(h.deps, admin);
      const row = result.find((r) => r.cigarId === cigarId);
      expect(row?.remaining).toBe(2);
    });
  });
});
