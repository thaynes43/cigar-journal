import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { favorites, auditLog } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { setFavorite, isFavorited } from "./favorites.js";
import { getCigar, searchCigars } from "./reads.js";
import { getBrand, browseCatalog, brandSlug } from "./catalog-browse.js";
import { saveSmoke } from "./save-smoke.js";
import { CigarNotFoundError } from "./errors.js";
import type { Principal } from "./index.js";

describe("favorites", () => {
  let h: DomainHarness;
  let user: Principal;
  let other: Principal;
  const tag = newRequestId().slice(0, 8);

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("favorites@example.com");
    other = await h.createUser("favorites-other@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function favoriteRows(userId: string, cigarId: string) {
    return h.deps.db
      .select()
      .from(favorites)
      .where(and(eq(favorites.userId, userId), eq(favorites.cigarId, cigarId)));
  }

  it("sets a favorite mark, then reads it back through getCigar (idempotent set)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Fav Set Toro ${tag}`, brand: "FS" });

    const first = await setFavorite(h.deps, user, { cigarId, favorited: true });
    expect(first).toMatchObject({ cigarId, favorited: true, changed: true });
    expect(await favoriteRows(user.userId, cigarId)).toHaveLength(1);

    // Idempotent re-set: still one row, and `changed` is false (no-op).
    const again = await setFavorite(h.deps, user, { cigarId, favorited: true });
    expect(again.favorited).toBe(true);
    expect(again.changed).toBe(false);
    expect(await favoriteRows(user.userId, cigarId)).toHaveLength(1);

    const got = await getCigar(h.deps, user, { cigarId });
    expect(got.favorited).toBe(true);
    expect(got.favoriteNote).toBeNull();
  });

  it("clears a favorite mark idempotently — clearing an absent one is a safe no-op", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Fav Clear Robusto ${tag}`, brand: "FC" });
    await setFavorite(h.deps, user, { cigarId, favorited: true });

    const cleared = await setFavorite(h.deps, user, { cigarId, favorited: false });
    expect(cleared).toMatchObject({ cigarId, favorited: false, note: null, changed: true });
    expect(await favoriteRows(user.userId, cigarId)).toHaveLength(0);

    // Clearing again: no row, no error, changed:false.
    const noop = await setFavorite(h.deps, user, { cigarId, favorited: false });
    expect(noop.favorited).toBe(false);
    expect(noop.changed).toBe(false);

    expect((await getCigar(h.deps, user, { cigarId })).favorited).toBe(false);
  });

  it("stores an optional note on set and surfaces it via getCigar; a bare re-set keeps it", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Fav Note Corona ${tag}`, brand: "FN" });

    const set = await setFavorite(h.deps, user, {
      cigarId,
      favorited: true,
      note: "  the one I keep coming back to  ",
    });
    expect(set.note).toBe("the one I keep coming back to"); // trimmed
    expect((await getCigar(h.deps, user, { cigarId })).favoriteNote).toBe(
      "the one I keep coming back to",
    );

    // A re-set with no note keeps the existing "why" (never silently wiped).
    const reset = await setFavorite(h.deps, user, { cigarId, favorited: true });
    expect(reset.note).toBe("the one I keep coming back to");

    // A re-set with a new note updates it.
    const updated = await setFavorite(h.deps, user, {
      cigarId,
      favorited: true,
      note: "still my desert-island stick",
    });
    expect(updated.changed).toBe(true);
    expect((await getCigar(h.deps, user, { cigarId })).favoriteNote).toBe(
      "still my desert-island stick",
    );

    // Clearing drops the note; a fresh set starts noteless.
    await setFavorite(h.deps, user, { cigarId, favorited: false });
    const afterClear = await setFavorite(h.deps, user, { cigarId, favorited: true });
    expect(afterClear.note).toBeNull();
  });

  it("writes an audit row on a real change and none on a no-op, attributing the actor", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Fav Audit Lancero ${tag}`, brand: "FA" });

    await setFavorite(h.deps, user, { cigarId, favorited: true, provenance: { source: "manual" } });
    await setFavorite(h.deps, user, { cigarId, favorited: true }); // no-op, no audit
    await setFavorite(h.deps, user, {
      cigarId,
      favorited: false,
      provenance: { source: "llm-conversation" },
    });

    const audits = (await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId)))
      .filter((a) => (a.after as { cigarId?: string }).cigarId === cigarId);
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(["favorite.clear", "favorite.set"]); // exactly two — the no-op wrote nothing

    const set = audits.find((a) => a.action === "favorite.set")!;
    expect(set.actor).toBe("web"); // manual → web
    expect(set.smokeId).toBeNull();
    const clear = audits.find((a) => a.action === "favorite.clear")!;
    expect(clear.actor).toBe("mcp"); // llm-conversation → mcp
  });

  it("throws CigarNotFoundError for an unknown cigar id", async () => {
    const error = await setFavorite(h.deps, user, {
      cigarId: "00000000-0000-0000-0000-000000000000",
      favorited: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CigarNotFoundError);
  });

  // #206. A caller-chosen id used to reach the `cigars.id` uuid column raw; the
  // contract being pinned is that malformed is INDISTINGUISHABLE from
  // unknown-but-valid, not the particular value that proves it.
  it("setFavorite answers a malformed id exactly as it answers an unknown one", async () => {
    const malformed = await setFavorite(h.deps, user, {
      cigarId: "not-a-uuid",
      favorited: true,
    }).catch((e: unknown) => e);
    const unknown = await setFavorite(h.deps, user, {
      cigarId: newRequestId(),
      favorited: true,
    }).catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(CigarNotFoundError);
    expect(unknown).toBeInstanceOf(CigarNotFoundError);
    expect((malformed as CigarNotFoundError).toPayload()).toEqual(
      (unknown as CigarNotFoundError).toPayload(),
    );
  });

  it("scopes favorite marks to the caller — one user's mark never leaks into another's reads", async () => {
    const brand = `FavIsolation ${tag}`;
    const cigarId = await h.seedCigar({ canonicalName: `${brand} Belicoso`, brand, line: "L" });
    await setFavorite(h.deps, user, { cigarId, favorited: true, note: "private note" });

    // getCigar: the other user sees no favorite, no note.
    const asOther = await getCigar(h.deps, other, { cigarId });
    expect(asOther.favorited).toBe(false);
    expect(asOther.favoriteNote).toBeNull();
    expect(await isFavorited(h.deps.db, other.userId, cigarId)).toBe(false);
    expect(await isFavorited(h.deps.db, user.userId, cigarId)).toBe(true);

    // browseCatalog tile overlay: owner true, other false.
    const ownerTile = (await browseCatalog(h.deps, user, { q: brand })).cigars.find(
      (c) => c.cigarId === cigarId,
    )!;
    expect(ownerTile.favorited).toBe(true);
    const otherTile = (await browseCatalog(h.deps, other, { q: brand })).cigars.find(
      (c) => c.cigarId === cigarId,
    )!;
    expect(otherTile.favorited).toBe(false);

    // getBrand tile overlay: same isolation.
    const ownerBrand = await getBrand(h.deps, user, { slug: brandSlug(brand) });
    const ownerLineTile = ownerBrand.lines.find((l) => l.line === "L")!.cigars[0]!;
    expect(ownerLineTile.favorited).toBe(true);
    const otherBrand = await getBrand(h.deps, other, { slug: brandSlug(brand) });
    const otherLineTile = otherBrand.lines.find((l) => l.line === "L")!.cigars[0]!;
    expect(otherLineTile.favorited).toBe(false);
  });

  it("is independent of want and survives smoking — never auto-set or auto-cleared", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Fav Survives Toro ${tag}`, brand: "FSV" });
    await setFavorite(h.deps, user, { cigarId, favorited: true });

    // Smoking the cigar does not touch the favorite (nor is `liked` inferred into it).
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      assessment: { liked: true },
    });
    expect((await getCigar(h.deps, user, { cigarId })).favorited).toBe(true);

    // A cigar with a liked smoke but no favorite mark stays unfavorited — favorite
    // is never inferred from the per-smoke `liked` field.
    const likedOnly = await h.seedCigar({ canonicalName: `Liked Not Fav ${tag}`, brand: "LNF" });
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: likedOnly },
      overallDescriptors: ["marker"],
      assessment: { liked: true },
    });
    expect((await getCigar(h.deps, user, { cigarId: likedOnly })).favorited).toBe(false);
  });

  it("search_cigars is unaffected by favorite marks (overlay lives on tiles and get_cigar)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Fav Searchable Sublime ${tag}`, brand: "FSR" });
    await setFavorite(h.deps, user, { cigarId, favorited: true });
    const res = await searchCigars(h.deps, user, { query: `Fav Searchable Sublime ${tag}` });
    expect(res.matches[0]!.cigarId).toBe(cigarId);
    expect(res.matches[0]).not.toHaveProperty("favorited");
  });
});
