import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, photoUploadTokens } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import {
  mintPhotoUploadToken,
  mintProductPhotoUploadToken,
  consumePhotoUploadToken,
  assertPhotoUploadTokenUsable,
} from "./photo-upload-tokens.js";
import { CigarNotFoundError, SmokeNotFoundError, UnauthorizedError, UploadTokenInvalidError } from "./errors.js";
import type { Principal } from "./index.js";

describe("photo upload tokens", () => {
  let h: DomainHarness;
  let user: Principal;
  let other: Principal;
  let admin: Principal;
  let smokeId: string;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("token-owner@example.com");
    other = await h.createUser("token-intruder@example.com");
    admin = await h.createUser("token-curator@example.com", "admin");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    h.setNow(new Date("2026-08-27T12:00:00.000Z"));
    const cigarId = await h.seedCigar({ canonicalName: `Token Cigar ${newRequestId()}` });
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
    });
    smokeId = saved.smoke.smokeId;
  });

  it("mints a token bound to the smoke, stores only its hash, and writes an mcp audit row", async () => {
    const minted = await mintPhotoUploadToken(h.deps, user, {
      smokeId,
      kind: "band",
      caption: "The band",
    });
    expect(typeof minted.token).toBe("string");
    expect(minted.token.length).toBeGreaterThan(20);
    expect(Number.isNaN(Date.parse(minted.expiresAt))).toBe(false);

    // Only the sha256 hash is at rest — never the raw token.
    const rows = await h.deps.db
      .select()
      .from(photoUploadTokens)
      .where(eq(photoUploadTokens.smokeId, smokeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toHaveLength(64);
    expect(rows[0]!.tokenHash).not.toBe(minted.token);
    expect(rows[0]!.usedAt).toBeNull();

    const audits = (
      await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, smokeId))
    ).filter((a) => a.action === "photo_upload_token.mint");
    expect(audits).toHaveLength(1);
    // actor + credential together (#183). The smoke-photo mint is the MCP path, so
    // the day it runs under a service token this column is what separates it.
    expect([audits[0]!.actor, audits[0]!.clientId]).toEqual(["mcp", null]);
  });

  it("consume returns the binding and stamps used_at", async () => {
    const minted = await mintPhotoUploadToken(h.deps, user, {
      smokeId,
      kind: "construction",
      caption: "cap detail",
    });
    const consumed = await consumePhotoUploadToken(h.deps, { token: minted.token });
    expect(consumed.targetKind).toBe("smoke");
    if (consumed.targetKind !== "smoke") throw new Error("expected a smoke token");
    expect(consumed.userId).toBe(user.userId);
    expect(consumed.smokeId).toBe(smokeId);
    expect(consumed.kind).toBe("construction");
    expect(consumed.caption).toBe("cap detail");

    const rows = await h.deps.db
      .select()
      .from(photoUploadTokens)
      .where(eq(photoUploadTokens.smokeId, smokeId));
    expect(rows[0]!.usedAt).not.toBeNull();
  });

  it("mints with kind cigar when the caller named none", async () => {
    // #287. The kind is decided at MINT, not at upload, so the /u link is the one
    // path where a default that is not `cigar` would survive the change.
    const minted = await mintPhotoUploadToken(h.deps, user, { smokeId });
    const consumed = await consumePhotoUploadToken(h.deps, { token: minted.token });
    if (consumed.targetKind !== "smoke") throw new Error("expected a smoke token");
    expect(consumed.kind).toBe("cigar");
    expect(consumed.caption).toBeNull();
  });

  it("is single-use: two concurrent consumes, exactly one wins", async () => {
    const minted = await mintPhotoUploadToken(h.deps, user, { smokeId });
    const results = await Promise.allSettled([
      consumePhotoUploadToken(h.deps, { token: minted.token }),
      consumePhotoUploadToken(h.deps, { token: minted.token }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(UploadTokenInvalidError);

    // A later consume also fails — the token is burned.
    await expect(consumePhotoUploadToken(h.deps, { token: minted.token })).rejects.toBeInstanceOf(
      UploadTokenInvalidError,
    );
  });

  it("rejects an expired token with the same opaque error", async () => {
    const minted = await mintPhotoUploadToken(h.deps, user, { smokeId, ttlSeconds: 60 });
    h.setNow(new Date("2026-08-27T12:02:00.000Z")); // past the 60s TTL
    await expect(consumePhotoUploadToken(h.deps, { token: minted.token })).rejects.toBeInstanceOf(
      UploadTokenInvalidError,
    );
  });

  it("rejects an unknown token with the same opaque error", async () => {
    await expect(
      consumePhotoUploadToken(h.deps, { token: "not-a-real-token" }),
    ).rejects.toBeInstanceOf(UploadTokenInvalidError);
  });

  it("defaults to a 24-hour TTL", async () => {
    // The link is delivered in a chat turn and opened on a phone, often not in
    // the same sitting; the 15 minutes this used to be expired on the user far
    // more often than it stopped anyone. Single use + 256 bits carry the weight.
    const minted = await mintPhotoUploadToken(h.deps, user, { smokeId });
    expect(Date.parse(minted.expiresAt) - h.deps.now().getTime()).toBe(24 * 60 * 60 * 1000);

    // Still live at 23h59m, gone at 24h01m.
    h.setNow(new Date("2026-08-28T11:59:00.000Z"));
    await expect(assertPhotoUploadTokenUsable(h.deps, { token: minted.token })).resolves.toBeUndefined();
    h.setNow(new Date("2026-08-28T12:01:00.000Z"));
    await expect(consumePhotoUploadToken(h.deps, { token: minted.token })).rejects.toBeInstanceOf(
      UploadTokenInvalidError,
    );
  });

  describe("assertPhotoUploadTokenUsable", () => {
    it("passes a live token WITHOUT consuming it, so the consume that follows still works", async () => {
      // The property the upload route depends on: it checks the link is alive
      // before decoding an image, and that check must not spend the link.
      const minted = await mintPhotoUploadToken(h.deps, user, { smokeId });
      await assertPhotoUploadTokenUsable(h.deps, { token: minted.token });
      await assertPhotoUploadTokenUsable(h.deps, { token: minted.token });

      const rows = await h.deps.db
        .select()
        .from(photoUploadTokens)
        .where(eq(photoUploadTokens.smokeId, smokeId));
      expect(rows[0]!.usedAt).toBeNull();

      const consumed = await consumePhotoUploadToken(h.deps, { token: minted.token });
      expect(consumed.targetKind).toBe("smoke");
    });

    it("refuses an unknown, a used, and an expired token with the same opaque error", async () => {
      await expect(
        assertPhotoUploadTokenUsable(h.deps, { token: "not-a-real-token" }),
      ).rejects.toBeInstanceOf(UploadTokenInvalidError);

      const used = await mintPhotoUploadToken(h.deps, user, { smokeId });
      await consumePhotoUploadToken(h.deps, { token: used.token });
      await expect(
        assertPhotoUploadTokenUsable(h.deps, { token: used.token }),
      ).rejects.toBeInstanceOf(UploadTokenInvalidError);

      const expired = await mintPhotoUploadToken(h.deps, user, { smokeId, ttlSeconds: 60 });
      h.setNow(new Date("2026-08-27T12:02:00.000Z"));
      await expect(
        assertPhotoUploadTokenUsable(h.deps, { token: expired.token }),
      ).rejects.toBeInstanceOf(UploadTokenInvalidError);
    });
  });

  it("does not mint for a non-owned smoke, and writes nothing", async () => {
    await expect(mintPhotoUploadToken(h.deps, other, { smokeId })).rejects.toBeInstanceOf(
      SmokeNotFoundError,
    );
    const rows = await h.deps.db
      .select()
      .from(photoUploadTokens)
      .where(eq(photoUploadTokens.smokeId, smokeId));
    expect(rows).toHaveLength(0);
  });

  describe("product-photo tokens", () => {
    it("mints a product token bound to a cigar (admin), then consume yields the product binding", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Product Token ${newRequestId()}` });
      const minted = await mintProductPhotoUploadToken(h.deps, admin, { cigarId });
      expect(typeof minted.token).toBe("string");

      const rows = await h.deps.db
        .select()
        .from(photoUploadTokens)
        .where(eq(photoUploadTokens.cigarId, cigarId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.targetKind).toBe("product");
      expect(rows[0]!.smokeId).toBeNull();
      expect(rows[0]!.tokenHash).toHaveLength(64);

      const consumed = await consumePhotoUploadToken(h.deps, { token: minted.token });
      expect(consumed.targetKind).toBe("product");
      if (consumed.targetKind !== "product") throw new Error("expected a product token");
      expect(consumed.userId).toBe(admin.userId);
      expect(consumed.cigarId).toBe(cigarId);

      const audits = (
        await h.deps.db.select().from(auditLog).where(eq(auditLog.action, "photo_upload_token.mint"))
      ).filter((a) => (a.after as { cigarId?: string })?.cigarId === cigarId);
      expect(audits).toHaveLength(1);
      expect([audits[0]!.actor, audits[0]!.clientId]).toEqual(["web", null]);
    });

    it("is admin-only and rejects an unknown cigar", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Product Token Guard ${newRequestId()}` });
      await expect(mintProductPhotoUploadToken(h.deps, user, { cigarId })).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
      await expect(
        mintProductPhotoUploadToken(h.deps, admin, { cigarId: "00000000-0000-0000-0000-000000000000" }),
      ).rejects.toBeInstanceOf(CigarNotFoundError);
    });

    // #206. Both mints take an id straight from a tool argument or a route param
    // and carried it raw into a `uuid` column, where a non-uuid raised Postgres
    // 22P02 and escaped these not-found paths as a 500. The equality is the
    // contract: malformed must be INDISTINGUISHABLE from unknown-but-valid.
    it("mintProductPhotoUploadToken answers a malformed id exactly as it answers an unknown one", async () => {
      const malformed = await mintProductPhotoUploadToken(h.deps, admin, {
        cigarId: "not-a-uuid",
      }).catch((e: unknown) => e);
      const unknown = await mintProductPhotoUploadToken(h.deps, admin, {
        cigarId: newRequestId(),
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(CigarNotFoundError);
      expect(unknown).toBeInstanceOf(CigarNotFoundError);
      expect((malformed as CigarNotFoundError).toPayload()).toEqual(
        (unknown as CigarNotFoundError).toPayload(),
      );
    });
  });

  // #206, the smoke half of the same guard.
  it("mintPhotoUploadToken answers a malformed id exactly as it answers an unknown one", async () => {
    const malformed = await mintPhotoUploadToken(h.deps, user, { smokeId: "not-a-uuid" }).catch(
      (e: unknown) => e,
    );
    const unknown = await mintPhotoUploadToken(h.deps, user, { smokeId: newRequestId() }).catch(
      (e: unknown) => e,
    );
    expect(malformed).toBeInstanceOf(SmokeNotFoundError);
    expect(unknown).toBeInstanceOf(SmokeNotFoundError);
    expect((malformed as SmokeNotFoundError).toPayload()).toEqual(
      (unknown as SmokeNotFoundError).toPayload(),
    );
  });
});
