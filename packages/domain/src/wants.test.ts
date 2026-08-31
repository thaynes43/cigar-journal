import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { wants, auditLog } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { setWant, isWanted } from "./wants.js";
import { getCigar, searchCigars } from "./reads.js";
import { getBrand, browseCatalog, brandSlug } from "./catalog-browse.js";
import { recordPurchase } from "./record-purchase.js";
import { saveSmoke } from "./save-smoke.js";
import { CigarNotFoundError } from "./errors.js";
import type { Principal } from "./index.js";

describe("wants", () => {
  let h: DomainHarness;
  let user: Principal;
  let other: Principal;
  const tag = newRequestId().slice(0, 8);

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("wants@example.com");
    other = await h.createUser("wants-other@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function wantRows(userId: string, cigarId: string) {
    return h.deps.db
      .select()
      .from(wants)
      .where(and(eq(wants.userId, userId), eq(wants.cigarId, cigarId)));
  }

  it("sets a want mark, then reads it back through getCigar (idempotent set)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Want Set Toro ${tag}`, brand: "WS" });

    const first = await setWant(h.deps, user, { cigarId, wanted: true });
    expect(first).toMatchObject({ cigarId, wanted: true, changed: true });
    expect(await wantRows(user.userId, cigarId)).toHaveLength(1);

    // Idempotent re-set: still one row, and `changed` is false (no-op).
    const again = await setWant(h.deps, user, { cigarId, wanted: true });
    expect(again.wanted).toBe(true);
    expect(again.changed).toBe(false);
    expect(await wantRows(user.userId, cigarId)).toHaveLength(1);

    const got = await getCigar(h.deps, user, { cigarId });
    expect(got.wanted).toBe(true);
    expect(got.wantNote).toBeNull();
  });

  it("clears a want mark idempotently — clearing an absent one is a safe no-op", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Want Clear Robusto ${tag}`, brand: "WC" });
    await setWant(h.deps, user, { cigarId, wanted: true });

    const cleared = await setWant(h.deps, user, { cigarId, wanted: false });
    expect(cleared).toMatchObject({ cigarId, wanted: false, note: null, changed: true });
    expect(await wantRows(user.userId, cigarId)).toHaveLength(0);

    // Clearing again: no row, no error, changed:false.
    const noop = await setWant(h.deps, user, { cigarId, wanted: false });
    expect(noop.wanted).toBe(false);
    expect(noop.changed).toBe(false);

    expect((await getCigar(h.deps, user, { cigarId })).wanted).toBe(false);
  });

  it("stores an optional note on set and surfaces it via getCigar; a bare re-set keeps it", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Want Note Corona ${tag}`, brand: "WN" });

    const set = await setWant(h.deps, user, { cigarId, wanted: true, note: "  gift idea for Dad  " });
    expect(set.note).toBe("gift idea for Dad"); // trimmed
    expect((await getCigar(h.deps, user, { cigarId })).wantNote).toBe("gift idea for Dad");

    // A re-set with no note keeps the existing "why" (never silently wiped).
    const reset = await setWant(h.deps, user, { cigarId, wanted: true });
    expect(reset.note).toBe("gift idea for Dad");

    // A re-set with a new note updates it.
    const updated = await setWant(h.deps, user, { cigarId, wanted: true, note: "found it cheaper" });
    expect(updated.changed).toBe(true);
    expect((await getCigar(h.deps, user, { cigarId })).wantNote).toBe("found it cheaper");

    // Clearing drops the note; a fresh set starts noteless.
    await setWant(h.deps, user, { cigarId, wanted: false });
    const afterClear = await setWant(h.deps, user, { cigarId, wanted: true });
    expect(afterClear.note).toBeNull();
  });

  it("writes an audit row on a real change and none on a no-op, attributing the actor", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Want Audit Lancero ${tag}`, brand: "WA" });

    await setWant(h.deps, user, { cigarId, wanted: true, provenance: { source: "manual" } });
    await setWant(h.deps, user, { cigarId, wanted: true }); // no-op, no audit
    await setWant(h.deps, user, { cigarId, wanted: false, provenance: { source: "llm-conversation" } });

    const audits = (await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId)))
      .filter((a) => (a.after as { cigarId?: string }).cigarId === cigarId);
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(["want.clear", "want.set"]); // exactly two — the no-op wrote nothing

    const set = audits.find((a) => a.action === "want.set")!;
    expect(set.actor).toBe("web"); // manual → web
    expect(set.smokeId).toBeNull();
    const clear = audits.find((a) => a.action === "want.clear")!;
    expect(clear.actor).toBe("mcp"); // llm-conversation → mcp
  });

  it("throws CigarNotFoundError for an unknown cigar id", async () => {
    const error = await setWant(h.deps, user, {
      cigarId: "00000000-0000-0000-0000-000000000000",
      wanted: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CigarNotFoundError);
  });

  // #206. A caller-chosen id used to reach the `cigars.id` uuid column raw; the
  // contract being pinned is that malformed is INDISTINGUISHABLE from
  // unknown-but-valid, not the particular value that proves it.
  it("setWant answers a malformed id exactly as it answers an unknown one", async () => {
    const malformed = await setWant(h.deps, user, { cigarId: "not-a-uuid", wanted: true }).catch(
      (e: unknown) => e,
    );
    const unknown = await setWant(h.deps, user, { cigarId: newRequestId(), wanted: true }).catch(
      (e: unknown) => e,
    );
    expect(malformed).toBeInstanceOf(CigarNotFoundError);
    expect(unknown).toBeInstanceOf(CigarNotFoundError);
    expect((malformed as CigarNotFoundError).toPayload()).toEqual(
      (unknown as CigarNotFoundError).toPayload(),
    );
  });

  it("scopes want marks to the caller — one user's mark never leaks into another's reads", async () => {
    const brand = `Isolation ${tag}`;
    const cigarId = await h.seedCigar({ canonicalName: `${brand} Belicoso`, brand, line: "L" });
    await setWant(h.deps, user, { cigarId, wanted: true, note: "private note" });

    // getCigar: the other user sees no want, no note.
    const asOther = await getCigar(h.deps, other, { cigarId });
    expect(asOther.wanted).toBe(false);
    expect(asOther.wantNote).toBeNull();
    expect(await isWanted(h.deps.db, other.userId, cigarId)).toBe(false);
    expect(await isWanted(h.deps.db, user.userId, cigarId)).toBe(true);

    // browseCatalog tile overlay: owner true, other false.
    const ownerTile = (await browseCatalog(h.deps, user, { q: brand })).cigars.find(
      (c) => c.cigarId === cigarId,
    )!;
    expect(ownerTile.wanted).toBe(true);
    const otherTile = (await browseCatalog(h.deps, other, { q: brand })).cigars.find(
      (c) => c.cigarId === cigarId,
    )!;
    expect(otherTile.wanted).toBe(false);

    // getBrand tile overlay: same isolation.
    const ownerBrand = await getBrand(h.deps, user, { slug: brandSlug(brand) });
    const ownerLineTile = ownerBrand.lines.find((l) => l.line === "L")!.cigars[0]!;
    expect(ownerLineTile.wanted).toBe(true);
    const otherBrand = await getBrand(h.deps, other, { slug: brandSlug(brand) });
    const otherLineTile = otherBrand.lines.find((l) => l.line === "L")!.cigars[0]!;
    expect(otherLineTile.wanted).toBe(false);
  });

  it("survives smoking (never auto-cleared) and record_purchase reports the still-wanted flag", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Want Survives Toro ${tag}`, brand: "WSV" });
    await setWant(h.deps, user, { cigarId, wanted: true });

    // Smoking the cigar does not touch the want.
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
    });
    expect((await getCigar(h.deps, user, { cigarId })).wanted).toBe(true);

    // record_purchase carries wanted:true so the model/web can OFFER the clear;
    // it never clears silently.
    const bought = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 5,
    });
    expect(bought.wanted).toBe(true);
    expect((await getCigar(h.deps, user, { cigarId })).wanted).toBe(true); // still set after purchase

    // A cigar with no want reports wanted:false on purchase.
    const plainId = await h.seedCigar({ canonicalName: `No Want Panatela ${tag}`, brand: "NW" });
    const plain = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: plainId },
      quantity: 2,
    });
    expect(plain.wanted).toBe(false);
  });

  it("search_cigars is unaffected by want marks (overlay lives on tiles and get_cigar)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Searchable Sublime ${tag}`, brand: "SR" });
    await setWant(h.deps, user, { cigarId, wanted: true });
    const res = await searchCigars(h.deps, user, { query: `Searchable Sublime ${tag}` });
    expect(res.matches[0]!.cigarId).toBe(cigarId);
    expect(res.matches[0]).not.toHaveProperty("wanted");
  });
});
