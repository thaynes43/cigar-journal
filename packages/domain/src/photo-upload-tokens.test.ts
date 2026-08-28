import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, photoUploadTokens } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { mintPhotoUploadToken, consumePhotoUploadToken } from "./photo-upload-tokens.js";
import { SmokeNotFoundError, UploadTokenInvalidError } from "./errors.js";
import type { Principal } from "./index.js";

describe("photo upload tokens", () => {
  let h: DomainHarness;
  let user: Principal;
  let other: Principal;
  let smokeId: string;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("token-owner@example.com");
    other = await h.createUser("token-intruder@example.com");
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
    expect(audits[0]!.actor).toBe("mcp");
  });

  it("consume returns the binding and stamps used_at", async () => {
    const minted = await mintPhotoUploadToken(h.deps, user, {
      smokeId,
      kind: "construction",
      caption: "cap detail",
    });
    const consumed = await consumePhotoUploadToken(h.deps, { token: minted.token });
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
});
