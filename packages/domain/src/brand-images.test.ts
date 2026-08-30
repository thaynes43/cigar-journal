import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, brandImages, type NewBrandImageRow } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import {
  brandImageQueue,
  chooseBrandImageCandidate,
  getBrandImage,
  loadBrandCovers,
  setBrandImageRights,
} from "./brand-images.js";
import { PhotoNotFoundError, UnauthorizedError, ValidationError } from "./errors.js";
import type { Principal } from "./index.js";

// Brand imagery (ADR-007 third binding, issue #127). The bytes and every
// Wikimedia request belong to the crawl pod; these services only read, gate, and
// record decisions.

describe("brand images", () => {
  let h: DomainHarness;
  let admin: Principal;
  let user: Principal;
  const tag = newRequestId().slice(0, 8);

  beforeAll(async () => {
    h = await createHarness();
    admin = await h.createUser(`bi-curator-${tag}@example.com`, "admin");
    user = await h.createUser(`bi-member-${tag}@example.com`);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // A servable row carries its credit — the 0019 CHECK refuses anything less.
  async function seedRow(slug: string, values: Partial<NewBrandImageRow> = {}): Promise<void> {
    await h.deps.db.insert(brandImages).values({
      brandSlug: slug,
      brandName: slug,
      status: "resolved",
      rights: "approved",
      wikidataQid: "Q9100010",
      sourceUrl: `https://commons.wikimedia.org/wiki/File:${slug}.jpg`,
      licenseCode: "cc-by-sa-4.0",
      licenseName: "CC BY-SA 4.0",
      artist: "Ana Example",
      creditLine: "Ana Example · CC BY-SA 4.0",
      objectKey: `brand/${slug}/1.jpg`,
      thumbKey: `brand/${slug}/1.thumb.jpg`,
      contentType: "image/jpeg",
      ...values,
    });
  }

  describe("getBrandImage", () => {
    it("serves an approved row's storage coordinates", async () => {
      const slug = `serve-${tag}`;
      await seedRow(slug);
      await expect(getBrandImage(h.deps, { slug })).resolves.toEqual({
        objectKey: `brand/${slug}/1.jpg`,
        thumbKey: `brand/${slug}/1.thumb.jpg`,
        contentType: "image/jpeg",
      });
    });

    it("404s for an absent, suppressed, unapproved, or bytes-less row alike", async () => {
      const suppressed = `suppressed-${tag}`;
      await seedRow(suppressed, { rights: "suppressed" });
      const pending = `pending-${tag}`;
      await seedRow(pending, { rights: "pending" });
      const bytesless = `bytesless-${tag}`;
      await h.deps.db.insert(brandImages).values({
        brandSlug: bytesless,
        brandName: bytesless,
        status: "resolved",
        rights: "approved",
      });

      for (const slug of [`absent-${tag}`, suppressed, pending, bytesless]) {
        await expect(getBrandImage(h.deps, { slug })).rejects.toBeInstanceOf(PhotoNotFoundError);
      }
    });
  });

  describe("loadBrandCovers", () => {
    it("returns one cover per approved slug and skips everything else in one query", async () => {
      const ok = `cover-ok-${tag}`;
      const gone = `cover-suppressed-${tag}`;
      await seedRow(ok);
      await seedRow(gone, { rights: "suppressed" });

      const covers = await loadBrandCovers(h.deps, [ok, gone, `cover-absent-${tag}`]);
      expect([...covers.keys()]).toEqual([ok]);
      expect(covers.get(ok)?.creditLine).toBe("Ana Example · CC BY-SA 4.0");
      expect(covers.get(ok)?.sourceUrl).toContain("commons.wikimedia.org");
      expect(await loadBrandCovers(h.deps, [])).toEqual(new Map());
    });
  });

  describe("setBrandImageRights", () => {
    it("rejects a non-admin and changes nothing", async () => {
      const slug = `rights-guard-${tag}`;
      await seedRow(slug);
      const error = await setBrandImageRights(h.deps, user, {
        clientRequestId: newRequestId(),
        brandSlug: slug,
        rights: "suppressed",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
      const rows = await h.deps.db.select().from(brandImages).where(eq(brandImages.brandSlug, slug));
      expect(rows[0]?.rights).toBe("approved");
    });

    it("suppresses, audits in-transaction, and replays idempotently", async () => {
      const slug = `rights-${tag}`;
      await seedRow(slug);
      const clientRequestId = newRequestId();

      const first = await setBrandImageRights(h.deps, admin, {
        clientRequestId,
        brandSlug: slug,
        rights: "suppressed",
      });
      expect(first).toEqual({ brandSlug: slug, rights: "suppressed", replayed: false });
      await expect(getBrandImage(h.deps, { slug })).rejects.toBeInstanceOf(PhotoNotFoundError);

      const audits = await h.deps.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "brand_image.set_rights"));
      const entry = audits.find((a) => (a.before as { brandSlug?: string })?.brandSlug === slug);
      expect(entry).toBeDefined();
      expect((entry!.before as { rights: string }).rights).toBe("approved");
      expect((entry!.after as { rights: string }).rights).toBe("suppressed");

      const replay = await setBrandImageRights(h.deps, admin, {
        clientRequestId,
        brandSlug: slug,
        rights: "suppressed",
      });
      expect(replay.replayed).toBe(true);
      expect(audits.length).toBe(
        (await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "brand_image.set_rights"))).length,
      );
    });

    it("404s on an unknown brand", async () => {
      const error = await setBrandImageRights(h.deps, admin, {
        clientRequestId: newRequestId(),
        brandSlug: `nothing-${tag}`,
        rights: "approved",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PhotoNotFoundError);
    });
  });

  describe("chooseBrandImageCandidate", () => {
    async function seedAmbiguous(slug: string): Promise<void> {
      await h.deps.db.insert(brandImages).values({
        brandSlug: slug,
        brandName: slug,
        status: "ambiguous",
        candidates: [
          { qid: "Q9100030", label: "Partagas", description: "Cuban cigar brand", imageFile: "A.jpg", score: 5, reasons: [] },
          { qid: "Q9100031", label: "Partagas", description: "Dominican cigar brand", imageFile: "B.jpg", score: 4, reasons: [] },
        ],
      });
    }

    it("rejects a non-admin", async () => {
      const slug = `choose-guard-${tag}`;
      await seedAmbiguous(slug);
      const error = await chooseBrandImageCandidate(h.deps, user, {
        clientRequestId: newRequestId(),
        brandSlug: slug,
        qid: "Q9100030",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("records the pick with no bytes — the web never fetches Wikimedia", async () => {
      const slug = `choose-${tag}`;
      await seedAmbiguous(slug);
      const clientRequestId = newRequestId();

      const result = await chooseBrandImageCandidate(h.deps, admin, {
        clientRequestId,
        brandSlug: slug,
        qid: "Q9100031",
      });
      expect(result).toEqual({ brandSlug: slug, qid: "Q9100031", replayed: false });

      const rows = await h.deps.db.select().from(brandImages).where(eq(brandImages.brandSlug, slug));
      const saved = rows[0]!;
      expect(saved.status).toBe("resolved");
      expect(saved.wikidataQid).toBe("Q9100031");
      expect(saved.commonsFile).toBe("B.jpg");
      // The crawl pod downloads the bytes on its next run; nothing is stored here.
      expect(saved.objectKey).toBeNull();
      expect(saved.thumbKey).toBeNull();

      const replay = await chooseBrandImageCandidate(h.deps, admin, {
        clientRequestId,
        brandSlug: slug,
        qid: "Q9100031",
      });
      expect(replay.replayed).toBe(true);

      const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "brand_image.choose"));
      expect(audits.filter((a) => (a.before as { brandSlug?: string })?.brandSlug === slug)).toHaveLength(1);
    });

    it("refuses a qid that was never recorded as a candidate, and a non-ambiguous row", async () => {
      const slug = `choose-invalid-${tag}`;
      await seedAmbiguous(slug);
      const bad = await chooseBrandImageCandidate(h.deps, admin, {
        clientRequestId: newRequestId(),
        brandSlug: slug,
        qid: "Q1",
      }).catch((e: unknown) => e);
      expect(bad).toBeInstanceOf(ValidationError);

      const resolved = `choose-resolved-${tag}`;
      await seedRow(resolved);
      const wrongState = await chooseBrandImageCandidate(h.deps, admin, {
        clientRequestId: newRequestId(),
        brandSlug: resolved,
        qid: "Q9100010",
      }).catch((e: unknown) => e);
      expect(wrongState).toBeInstanceOf(ValidationError);
    });
  });

  describe("brandImageQueue", () => {
    it("splits ambiguous from resolved and is curator-only", async () => {
      const slug = `queue-${tag}`;
      await seedRow(slug);
      await expect(brandImageQueue(h.deps, user)).rejects.toBeInstanceOf(UnauthorizedError);

      const queue = await brandImageQueue(h.deps, admin);
      expect(queue.resolved.some((r) => r.brandSlug === slug && r.hasImage)).toBe(true);
      expect(queue.ambiguous.every((r) => r.status === "ambiguous")).toBe(true);
    });
  });
});
