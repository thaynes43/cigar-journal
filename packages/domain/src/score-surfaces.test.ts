import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { blends, brands, lines } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { brandSlug } from "./catalog-browse.js";
import { saveSmoke } from "./save-smoke.js";
import { recordReviewObservation } from "./review-observations.js";
import { getLeafSurfaceScores, getSurfaceScore, getSurfaceScores } from "./score-aggregates.js";
import type { Principal } from "./deps.js";

// The RENDERED surfaces (DESIGN-006) against a real Postgres. What separates
// these from score-aggregates.test.ts is not the arithmetic — it is the three
// things a surface adds: whole numbers, the viewer's journal population, and the
// leaf's own-observations-else-its-blend's resolution with the scope carried on
// the answer.
//
// Every expected number is computed here in the comments rather than read back
// out of the implementation, and the fixture is built so that the wrong rule
// gives a visibly different answer: the means round rather than land whole, and
// one journal is deliberately three times as prolific as the other.
describe("score surfaces (DESIGN-006)", () => {
  let h: DomainHarness;
  // The prolific author, journal PUBLIC. Three ratings of C1, one voice.
  let author: Principal;
  // A second public journal, one rating of C1.
  let second: Principal;
  // A PRIVATE journal, one rating of C1 — outside the community population and
  // inside their own.
  let hidden: Principal;
  // A signed-in reader who has rated nothing. Their population is the community's.
  let bystander: Principal;
  const tag = newRequestId().slice(0, 8);

  //   brand B
  //   └── line L
  //       ├── blend BL       leaves: C1, C2, C4
  //       │   critics: 90, 81 on C1  +  70 stated on the blend
  //       │   journal: author 70/90/80 on C1, second 91 on C1, hidden 20 on C1
  //       │                 (C4 carries one public rating of 60 and no reviews)
  //       └── blend EMPTY    leaf: C3, nothing observed at all
  const ids = {
    brand: "",
    line: "",
    blend: "",
    emptyBlend: "",
    c1: "",
    c2: "",
    c3: "",
    c4: "",
  };

  const seedBrand = async (name: string): Promise<string> =>
    (
      await h.deps.db
        .insert(brands)
        .values({ name: `${name} ${tag}`, slug: brandSlug(`${name} ${tag}`) })
        .returning({ id: brands.id })
    )[0]!.id;

  const seedLine = async (brandId: string, name: string): Promise<string> =>
    (
      await h.deps.db
        .insert(lines)
        .values({ brandId, name, slug: brandSlug(`${name} ${tag}`) })
        .returning({ id: lines.id })
    )[0]!.id;

  const seedBlend = async (lineId: string, name: string): Promise<string> =>
    (
      await h.deps.db
        .insert(blends)
        .values({ lineId, name, slug: brandSlug(`${name} ${tag}`) })
        .returning({ id: blends.id })
    )[0]!.id;

  let observationSeq = 0;
  async function critic(target: { cigarId?: string; blendId?: string }, score: number) {
    observationSeq += 1;
    await recordReviewObservation(h.deps.db, {
      source: `surface-${tag}`,
      url: `https://critic.example/s/${tag}-${observationSeq}`,
      nativeScale: "0-100",
      nativeScore: score,
      ...target,
      seenAt: new Date("2026-09-03T09:00:00.000Z"),
    });
  }

  const rate = (who: Principal, cigarId: string, rating: number) =>
    saveSmoke(h.deps, who, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      assessment: { rating, impression: "Logged." },
    });

  const publish = (who: Principal) =>
    h.deps.db.execute(
      sql`UPDATE users SET journal_visibility = 'public' WHERE id = ${who.userId}`,
    );

  beforeAll(async () => {
    h = await createHarness();
    author = await h.createUser(`surf-author-${tag}@example.com`);
    second = await h.createUser(`surf-second-${tag}@example.com`);
    hidden = await h.createUser(`surf-hidden-${tag}@example.com`);
    bystander = await h.createUser(`surf-bystander-${tag}@example.com`);
    // `users.journal_visibility` defaults to 'private' (migration 0001), so the
    // two community voices publish exactly as a real contributor would; `hidden`
    // is left alone, which is what makes it the privacy case.
    await publish(author);
    await publish(second);

    ids.brand = await seedBrand("Surfaces");
    ids.line = await seedLine(ids.brand, "Surface Line");
    ids.blend = await seedBlend(ids.line, "Surface Blend");
    ids.emptyBlend = await seedBlend(ids.line, "Empty Blend");

    const leaf = (name: string, blendId: string) =>
      h.seedCigar({
        canonicalName: `${name} ${tag}`,
        brandId: ids.brand,
        lineId: ids.line,
        blendId,
        type: "NC",
      });
    ids.c1 = await leaf("C1", ids.blend);
    ids.c2 = await leaf("C2", ids.blend);
    ids.c3 = await leaf("C3", ids.emptyBlend);
    ids.c4 = await leaf("C4", ids.blend);

    await critic({ cigarId: ids.c1 }, 90);
    await critic({ cigarId: ids.c1 }, 81);
    await critic({ blendId: ids.blend }, 70);

    await rate(author, ids.c1, 70);
    await rate(author, ids.c1, 90);
    await rate(author, ids.c1, 80);
    await rate(second, ids.c1, 91);
    await rate(hidden, ids.c1, 20);
    await rate(second, ids.c4, 60);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // ---- Rule 1: two aggregates, labelled, counted, whole ---------------------

  describe("both aggregates round to a whole number on the 0-100 axis", () => {
    it("rounds the exact mean once, rather than a two-decimal value twice", async () => {
      // C1's own observations are 90 and 81 → 171 / 2 = 85.5, which rounds away
      // from zero to 86. The analytical read reports 85.5; a surface reports 86.
      const leaf = await getLeafSurfaceScores(h.deps.db, ids.c1, null);
      expect(leaf.critics).toEqual({ score: 86, count: 2, scope: "cigar" });
      expect(Number.isInteger(leaf.critics!.score)).toBe(true);

      // The blend's are 90, 81 and the 70 stated on the blend → 241 / 3 = 80.33,
      // which rounds DOWN to 80. Rounding is real rounding, not truncation, and
      // not a second pass over an already-rounded 80.33.
      const blend = await getSurfaceScore(h.deps.db, "blend", ids.blend, null);
      expect(blend.critics).toEqual({ score: 80, count: 3, scope: "blend" });
    });

    it("rounds the journal population the same way", async () => {
      // The author's voice is (70 + 90 + 80) / 3 = 80; the second journal's is 91.
      // The level averages the two VOICES: 171 / 2 = 85.5 → 86, over 2 journals.
      const leaf = await getLeafSurfaceScores(h.deps.db, ids.c1, null);
      expect(leaf.journal).toEqual({ score: 86, count: 2, scope: "cigar" });
    });
  });

  describe("an empty population is absent, never zero", () => {
    it("answers null on both sides where nothing has been observed", async () => {
      // C3's blend has nothing either, so there is no fallback to find.
      expect(await getLeafSurfaceScores(h.deps.db, ids.c3, null)).toEqual({
        critics: null,
        journal: null,
      });
      expect(await getSurfaceScore(h.deps.db, "blend", ids.emptyBlend, null)).toEqual({
        critics: null,
        journal: null,
      });
    });

    it("answers null for an id that names nothing, and for one that is not an id", async () => {
      const unknown = await getLeafSurfaceScores(
        h.deps.db,
        "00000000-0000-0000-0000-000000000000",
        null,
      );
      expect(unknown).toEqual({ critics: null, journal: null });
      // A malformed id degrades to the same answer rather than failing the uuid
      // cast and 500ing the page (#206).
      expect(await getLeafSurfaceScores(h.deps.db, "not-a-uuid", null)).toEqual(unknown);
    });

    it("drops a leaf a curator excluded, and its blend with it when it was the only one", async () => {
      const brandId = await seedBrand("Excluded");
      const lineId = await seedLine(brandId, "Excluded Line");
      const blendId = await seedBlend(lineId, "Excluded Blend");
      const cigarId = await h.seedCigar({
        canonicalName: `Excluded ${tag}`,
        brandId,
        lineId,
        blendId,
        type: "NC",
        catalogStatus: "excluded",
      });
      await critic({ cigarId }, 99);
      await rate(author, cigarId, 99);

      // `cigar_ancestry` gates on catalog_status, so the tombstone resolves to no
      // leaf — and therefore to no blend to fall back to either.
      expect(await getLeafSurfaceScores(h.deps.db, cigarId, null)).toEqual({
        critics: null,
        journal: null,
      });
      expect(await getSurfaceScore(h.deps.db, "blend", blendId, null)).toEqual({
        critics: null,
        journal: null,
      });
    });
  });

  // ---- Rule 1: one voice per journal, and whose journals count -------------

  describe("the journal population is one voice per journal", () => {
    it("counts a three-smoke author once, as the mean of means", async () => {
      // Three ratings from the author (70, 90, 80) and one from the second journal
      // (91). Averaging the four RATINGS gives 331 / 4 = 82.75 → 83, the prolific
      // author outvoting the other three-to-one. Averaging the two VOICES gives
      // 86. The fixture is lopsided so the two answers differ, and this is the
      // assertion that tells them apart.
      const leaf = await getLeafSurfaceScores(h.deps.db, ids.c1, null);
      expect(leaf.journal!.count).toBe(2);
      expect(leaf.journal!.score).toBe(86);
      expect(leaf.journal!.score).not.toBe(83);
    });

    it("counts journals at a roll-up level too", async () => {
      // At the blend, the author's voice is still their mean over everything they
      // rated under it (70, 90, 80 → 80); the second journal now also carries C4's
      // 60, so their voice is (91 + 60) / 2 = 75.5. The blend averages the two
      // voices: 155.5 / 2 = 77.75 → 78, over 2 journals — not 4 or 6 smokes.
      const blend = await getSurfaceScore(h.deps.db, "blend", ids.blend, null);
      expect(blend.journal).toEqual({ score: 78, count: 2, scope: "blend" });
    });
  });

  describe("visibility decides whose journals are in the population", () => {
    it("leaves another user's private journal out", async () => {
      // `hidden` rated C1 a 20. Counting it would drag the blend's number and,
      // worse, disclose that somebody has rated this at all.
      const community = await getLeafSurfaceScores(h.deps.db, ids.c1, null);
      expect(community.journal).toEqual({ score: 86, count: 2, scope: "cigar" });

      // A signed-in reader who has rated nothing sees exactly the community
      // number: `viewer` adds only their OWN journal, and they have none here.
      expect(await getLeafSurfaceScores(h.deps.db, ids.c1, { userId: bystander.userId })).toEqual(
        community,
      );
    });

    it("counts a public journal that is not the viewer's", async () => {
      // The second journal is somebody else's and it is in — being public is the
      // whole qualification. Removing it would take the count to 1.
      const seenBySecond = await getLeafSurfaceScores(h.deps.db, ids.c1, {
        userId: second.userId,
      });
      expect(seenBySecond.journal!.count).toBe(2);
    });

    it("always counts the viewer's own journal, public or not", async () => {
      // For `hidden`, the population is the two public voices PLUS their own:
      // (80 + 91 + 20) / 3 = 63.67 → 64, over 3 journals. Their private rating is
      // theirs to see aggregated; it reaches nobody else's number.
      expect(await getLeafSurfaceScores(h.deps.db, ids.c1, { userId: hidden.userId })).toEqual({
        critics: { score: 86, count: 2, scope: "cigar" },
        journal: { score: 64, count: 3, scope: "cigar" },
      });
    });

    it("keeps the critic aggregate identical for every viewer", async () => {
      // Critics are catalog data. If the pair moved together the journal's privacy
      // rule would be observable from the other half.
      const anonymous = await getLeafSurfaceScores(h.deps.db, ids.c1, null);
      const owner = await getLeafSurfaceScores(h.deps.db, ids.c1, { userId: hidden.userId });
      expect(owner.critics).toEqual(anonymous.critics);
    });
  });

  // ---- Rule 2: the most specific level with data ---------------------------

  describe("a leaf shows its own observations, else its blend's", () => {
    it("prefers the leaf's own and says so", async () => {
      const leaf = await getLeafSurfaceScores(h.deps.db, ids.c1, null);
      expect(leaf.critics!.scope).toBe("cigar");
      expect(leaf.journal!.scope).toBe("cigar");
      // The 70 stated about the BLEND is not attributed to this vitola — the
      // count is 2, not 3 (ADR-013 §1 in the other direction).
      expect(leaf.critics!.count).toBe(2);
    });

    it("falls back to the blend, labelled as the blend's", async () => {
      // C2 has neither reviews nor ratings of its own, so both halves widen to the
      // blend and both say `blend` — which is what licenses the page's caption.
      const leaf = await getLeafSurfaceScores(h.deps.db, ids.c2, null);
      expect(leaf.critics).toEqual({ score: 80, count: 3, scope: "blend" });
      expect(leaf.journal).toEqual({ score: 78, count: 2, scope: "blend" });
      expect(leaf).toEqual(
        // …and it is exactly what the blend surface itself reports, because the
        // fallback widens the population rather than substituting a different one.
        {
          critics: { ...(await getSurfaceScore(h.deps.db, "blend", ids.blend, null)).critics! },
          journal: { ...(await getSurfaceScore(h.deps.db, "blend", ids.blend, null)).journal! },
        },
      );
    });

    it("resolves the two populations independently, so a mixed pair is possible", async () => {
      // C4 has been rated (by `second`, 60) but never reviewed. Resolving the pair
      // together would suppress the blend's critic score just because the leaf
      // "has data" for the other population — so the halves resolve separately.
      const leaf = await getLeafSurfaceScores(h.deps.db, ids.c4, null);
      expect(leaf.critics).toEqual({ score: 80, count: 3, scope: "blend" });
      expect(leaf.journal).toEqual({ score: 60, count: 1, scope: "cigar" });
    });

    it("does not fall back past the blend", async () => {
      // A leaf with no blend has nothing to widen to, even though its line and
      // brand carry plenty. DESIGN-006 rule 2 names exactly one fallback.
      const cigarId = await h.seedCigar({
        canonicalName: `Blendless ${tag}`,
        brandId: ids.brand,
        lineId: ids.line,
        type: "NC",
      });
      expect(await getLeafSurfaceScores(h.deps.db, cigarId, null)).toEqual({
        critics: null,
        journal: null,
      });
      // The line above it is not empty, which is what makes this a real negative.
      expect(
        (await getSurfaceScore(h.deps.db, "line", ids.line, null)).critics,
      ).not.toBeNull();
    });
  });

  // ---- The level-scoped batch read ----------------------------------------

  describe("the batch surface read", () => {
    it("answers every id asked about, scoped to the level asked for", async () => {
      const map = await getSurfaceScores(
        h.deps.db,
        "blend",
        [ids.blend, ids.emptyBlend, "00000000-0000-0000-0000-000000000000"],
        null,
      );
      expect(map.size).toBe(3);
      expect(map.get(ids.blend)!.critics).toEqual({ score: 80, count: 3, scope: "blend" });
      // An id nobody has reviewed and an id that names nothing are the same answer.
      expect(map.get(ids.emptyBlend)).toEqual({ critics: null, journal: null });
      expect(map.get("00000000-0000-0000-0000-000000000000")).toEqual({
        critics: null,
        journal: null,
      });
    });

    it("never widens: a level surface reports only its own level", async () => {
      // Line and brand carry the same rows here (one line, one brand), but each
      // says the level it was asked at — a group card's number is never quietly
      // borrowed from a child or a parent.
      const line = await getSurfaceScore(h.deps.db, "line", ids.line, null);
      const brand = await getSurfaceScore(h.deps.db, "brand", ids.brand, null);
      expect(line.critics!.scope).toBe("line");
      expect(brand.critics!.scope).toBe("brand");
      expect(line.critics!.count).toBe(brand.critics!.count);
    });

    it("carries the viewer's population into the batch as well", async () => {
      const community = await getSurfaceScores(h.deps.db, "blend", [ids.blend], null);
      const asHidden = await getSurfaceScores(h.deps.db, "blend", [ids.blend], {
        userId: hidden.userId,
      });
      expect(community.get(ids.blend)!.journal!.count).toBe(2);
      expect(asHidden.get(ids.blend)!.journal!.count).toBe(3);
      expect(asHidden.get(ids.blend)!.critics).toEqual(community.get(ids.blend)!.critics);
    });
  });
});
