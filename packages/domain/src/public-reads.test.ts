import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { users, smokePhotos } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { getPublicSmoke, queryPublicSmokes, publicJournalExists } from "./public-reads.js";
import { getPublicSmokePhoto } from "./smoke-photos.js";
import { getSmoke } from "./reads.js";
import { SmokeNotFoundError, PhotoNotFoundError } from "./errors.js";
import type { Principal } from "./index.js";

// Anonymous reads for public journals (issue #96). House authz standard: both
// visibility states, cross-user access, anonymous-vs-authed parity, guessed-URL
// 404 parity (a private id and a fake id are indistinguishable), and that the
// personal-inventory + private fields never cross into the public surface.
describe("public journal reads (issue #96)", () => {
  let h: DomainHarness;
  let publicUser: Principal;
  let privateUser: Principal;
  let cigarId: string;
  let publicSmokeId: string;
  let olderPublicSmokeId: string;
  let privateSmokeId: string;

  const makePublic = () =>
    h.pg.db.update(users).set({ journalVisibility: "public" }).where(eq(users.id, publicUser.userId));

  beforeAll(async () => {
    h = await createHarness();
    publicUser = await h.createUser("public-owner@example.com");
    privateUser = await h.createUser("private-owner@example.com");
    cigarId = await h.seedCigar({ canonicalName: "Padrón 1926 No. 9", brand: "Padrón", type: "NC" });

    // The public journal's newer smoke carries every content class — including
    // strength/body/impression, which ARE public journal content — PLUS the
    // context that must be stripped (location/occasion). Only pairing is carried.
    h.setNow(new Date("2026-06-10T12:00:00Z"));
    const newer = await saveSmoke(h.deps, publicUser, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      smokedAt: { value: "2026-06-10T12:00:00Z", source: "user", precision: "minute" },
      overallDescriptors: ["cocoa", "leather"],
      progression: [
        { stage: "opening", approximatePosition: 0.1, descriptors: ["cocoa"], verbatim: "Deep cocoa." },
      ],
      construction: { draw: "good", burn: "excellent", smokeOutput: "high", notes: "Solid ash." },
      assessment: { strength: "full", body: "medium-full", rating: 95, liked: true, impression: "Layered and long." },
      context: { location: "PRIVATE-LOCATION", pairing: ["espresso"], occasion: "PRIVATE-OCCASION" },
      journal: { title: "A benchmark", narrative: "Rich and layered." },
    });
    publicSmokeId = newer.smoke.smokeId;

    h.setNow(new Date("2026-05-01T12:00:00Z"));
    const older = await saveSmoke(h.deps, publicUser, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      smokedAt: { value: "2026-05-01T12:00:00Z", source: "user", precision: "minute" },
      overallDescriptors: ["hay"],
      journal: { narrative: "An earlier session." },
    });
    olderPublicSmokeId = older.smoke.smokeId;

    const priv = await saveSmoke(h.deps, privateUser, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["earth"],
      journal: { narrative: "Private note." },
    });
    privateSmokeId = priv.smoke.smokeId;
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("hides everything while no journal is public (index 404s, smoke 404s)", async () => {
    expect(await publicJournalExists(h.deps)).toBe(false);
    expect((await queryPublicSmokes(h.deps)).smokes).toEqual([]);
    const err = await getPublicSmoke(h.deps, { smokeId: publicSmokeId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmokeNotFoundError);
  });

  it("exposes the journal once its owner flips to public", async () => {
    await makePublic();
    expect(await publicJournalExists(h.deps)).toBe(true);
    const view = await getPublicSmoke(h.deps, { smokeId: publicSmokeId });
    expect(view.cigar.canonicalName).toBe("Padrón 1926 No. 9");
    expect(view.journal.title).toBe("A benchmark");
    expect(view.assessment.rating).toBe(95);
    // Strength, body, and impression are public journal content.
    expect(view.assessment.strength).toBe("full");
    expect(view.assessment.body).toBe("medium-full");
    expect(view.assessment.impression).toBe("Layered and long.");
    expect(view.pairing).toEqual(["espresso"]);
    expect(view.progression).toHaveLength(1);
  });

  it("strips the personal-inventory and remaining private context from the public view", async () => {
    const view = await getPublicSmoke(h.deps, { smokeId: publicSmokeId });
    // Shape guarantees these have no home on PublicSmokeView; the serialized blob
    // is the belt-and-braces check that no withheld value rode along. Location and
    // occasion stay private (only pairing is carried).
    const blob = JSON.stringify(view);
    for (const secret of ["PRIVATE-LOCATION", "PRIVATE-OCCASION"]) {
      expect(blob).not.toContain(secret);
    }
    expect(view).not.toHaveProperty("consumption");
    expect(view).not.toHaveProperty("provenance");
    expect(view.cigar).not.toHaveProperty("cigarId");
  });

  it("lists only public journals' smokes, newest first, and paginates by keyset", async () => {
    const firstPage = await queryPublicSmokes(h.deps, { limit: 1 });
    expect(firstPage.smokes.map((s) => s.smokeId)).toEqual([publicSmokeId]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await queryPublicSmokes(h.deps, { limit: 1, cursor: firstPage.nextCursor });
    expect(secondPage.smokes.map((s) => s.smokeId)).toEqual([olderPublicSmokeId]);

    // The private journal's smoke never appears across the whole listing.
    const all = await queryPublicSmokes(h.deps, { limit: 25 });
    expect(all.smokes.map((s) => s.smokeId)).not.toContain(privateSmokeId);
    expect(all.nextCursor).toBeNull();
  });

  it("derives the public summary from the narrative, never the impression", async () => {
    const all = await queryPublicSmokes(h.deps, { limit: 25 });
    const newer = all.smokes.find((s) => s.smokeId === publicSmokeId);
    expect(newer?.summary).toBe("Rich and layered.");
    expect(newer?.summary).not.toBe("Layered and long.");
  });

  it("gives a private smoke and a nonexistent id the SAME 404 (no existence leak)", async () => {
    const privateErr = await getPublicSmoke(h.deps, { smokeId: privateSmokeId }).catch((e: unknown) => e);
    const fakeErr = await getPublicSmoke(h.deps, { smokeId: newRequestId() }).catch((e: unknown) => e);
    expect(privateErr).toBeInstanceOf(SmokeNotFoundError);
    expect(fakeErr).toBeInstanceOf(SmokeNotFoundError);
    // Identical class, message, and serialized payload → the adapters render one
    // and the same 404 body for both.
    expect((privateErr as SmokeNotFoundError).message).toBe((fakeErr as SmokeNotFoundError).message);
    expect((privateErr as SmokeNotFoundError).toPayload()).toEqual(
      (fakeErr as SmokeNotFoundError).toPayload(),
    );
  });

  it("keeps the owner's private read owner-only (cross-user still 404s)", async () => {
    // The public exposure of publicUser's journal does not widen getSmoke: another
    // user still cannot read it through the owner path.
    const err = await getSmoke(h.deps, privateUser, { smokeId: publicSmokeId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmokeNotFoundError);
  });

  it("serves a public journal's photo and withholds a private journal's photo", async () => {
    const publicPhoto = await insertPhoto(publicUser.userId, publicSmokeId);
    const privatePhoto = await insertPhoto(privateUser.userId, privateSmokeId);

    const coords = await getPublicSmokePhoto(h.deps, { photoId: publicPhoto });
    expect(coords.objectKey).toContain(publicSmokeId);

    const err = await getPublicSmokePhoto(h.deps, { photoId: privatePhoto }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoNotFoundError);
    const missing = await getPublicSmokePhoto(h.deps, { photoId: newRequestId() }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PhotoNotFoundError);
  });

  async function insertPhoto(userId: string, smokeId: string): Promise<string> {
    const inserted = await h.pg.db
      .insert(smokePhotos)
      .values({
        smokeId,
        userId,
        kind: "other",
        objectKey: `smoke/${smokeId}/p.jpg`,
        thumbKey: `smoke/${smokeId}/p.thumb.jpg`,
        contentType: "image/jpeg",
        width: 100,
        height: 100,
        bytes: 1000,
      })
      .returning({ id: smokePhotos.id });
    return inserted[0]!.id;
  }
});
