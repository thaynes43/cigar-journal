import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { blendBlenders, blenders, blends, brands, lines } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { brandSlug } from "./catalog-browse.js";
import { saveSmoke } from "./save-smoke.js";
import { recordReviewObservation } from "./review-observations.js";
import { getScoreAggregate, getScoreAggregates } from "./score-aggregates.js";
import type { Principal } from "./deps.js";

// The two-population aggregates (ADR-013 §3) against a real Postgres, over one
// hand-built fixture whose every expected number is computed here in the comments
// rather than read back out of the implementation.
//
// The fixture is deliberately LOPSIDED — one line carries four observations and
// the other carries one — because that is the only shape in which "aggregate the
// observations" and "average the children's averages" give different answers.
// A balanced fixture would pass under both rules and prove nothing.
describe("score aggregates", () => {
  let h: DomainHarness;
  let user: Principal;
  const tag = newRequestId().slice(0, 8);

  // The fixture, by hand:
  //
  //   brand B
  //   ├── line L1
  //   │   ├── blend BL1  leaves: C1 (NC), C2 (NC)
  //   │   │   critic: 90, 80 via C1  +  100 direct on the blend
  //   │   │   journal: 70, 90 on C1  (+ one unrated smoke on C1)
  //   │   └── blend BL2  leaves: C3 (NC), C5 (NC, EXCLUDED)
  //   │       critic: 60 via C3      (+ 10 via the excluded C5)
  //   │       journal: 50 on C3      (+ 20 on the excluded C5)
  //   └── line L2
  //       └── blend BL3  leaves: C4 (CC)
  //           critic: 70 via C4
  //           journal: 100 on C4
  //
  //   blenders: X credits BL1 + BL2 (both NC).  Y credits BL3 (Cuban).
  const ids = {
    brand: "",
    l1: "",
    l2: "",
    bl1: "",
    bl2: "",
    bl3: "",
    c1: "",
    c2: "",
    c3: "",
    c4: "",
    c5: "",
    blenderX: "",
    blenderY: "",
  };

  async function seedBrand(name: string): Promise<string> {
    const rows = await h.deps.db
      .insert(brands)
      .values({ name: `${name} ${tag}`, slug: brandSlug(`${name} ${tag}`) })
      .returning({ id: brands.id });
    return rows[0]!.id;
  }

  async function seedLine(brandId: string, name: string): Promise<string> {
    const rows = await h.deps.db
      .insert(lines)
      .values({ brandId, name, slug: brandSlug(`${name} ${tag}`) })
      .returning({ id: lines.id });
    return rows[0]!.id;
  }

  async function seedBlend(lineId: string, name: string): Promise<string> {
    const rows = await h.deps.db
      .insert(blends)
      .values({ lineId, name, slug: brandSlug(`${name} ${tag}`) })
      .returning({ id: blends.id });
    return rows[0]!.id;
  }

  async function seedBlender(name: string, blendIds: string[]): Promise<string> {
    const rows = await h.deps.db
      .insert(blenders)
      .values({ name: `${name} ${tag}`, slug: brandSlug(`${name} ${tag}`) })
      .returning({ id: blenders.id });
    const blenderId = rows[0]!.id;
    for (const blendId of blendIds) {
      await h.deps.db.insert(blendBlenders).values({ blendId, blenderId });
    }
    return blenderId;
  }

  let observationSeq = 0;
  async function critic(
    target: { cigarId?: string; blendId?: string },
    score: number,
  ): Promise<void> {
    observationSeq += 1;
    await recordReviewObservation(h.deps.db, {
      source: `critic-${tag}`,
      url: `https://critic.example/review/${tag}-${observationSeq}`,
      nativeScale: "0-100",
      nativeScore: score,
      ...target,
      seenAt: new Date("2026-08-31T09:00:00.000Z"),
    });
  }

  async function journal(cigarId: string, rating: number | null): Promise<void> {
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      assessment: rating == null ? { impression: "No number." } : { rating, impression: "Logged." },
    });
  }

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser(`scores-${tag}@example.com`);
    // The default journal population is PUBLIC journals only, and
    // `users.journal_visibility` defaults to 'private' — so the fixture's author
    // has to publish, exactly as a real contributor to a community score would.
    // The private case gets its own describe below.
    await h.deps.db.execute(
      sql`UPDATE users SET journal_visibility = 'public' WHERE id = ${user.userId}`,
    );

    ids.brand = await seedBrand("Aggregate");
    ids.l1 = await seedLine(ids.brand, "Line One");
    ids.l2 = await seedLine(ids.brand, "Line Two");
    ids.bl1 = await seedBlend(ids.l1, "Blend One");
    ids.bl2 = await seedBlend(ids.l1, "Blend Two");
    ids.bl3 = await seedBlend(ids.l2, "Blend Three");

    const leaf = (
      name: string,
      blendId: string,
      lineId: string,
      extra: Record<string, unknown> = {},
    ) =>
      h.seedCigar({
        canonicalName: `${name} ${tag}`,
        brandId: ids.brand,
        lineId,
        blendId,
        type: "NC",
        ...extra,
      });

    ids.c1 = await leaf("C1", ids.bl1, ids.l1);
    ids.c2 = await leaf("C2", ids.bl1, ids.l1);
    ids.c3 = await leaf("C3", ids.bl2, ids.l1);
    ids.c4 = await leaf("C4", ids.bl3, ids.l2, { type: "CC" });
    // An excluded leaf: a curator has said it should not represent the catalogue,
    // so nothing hanging off it may score a blend.
    ids.c5 = await leaf("C5", ids.bl2, ids.l1, { catalogStatus: "excluded" });

    ids.blenderX = await seedBlender("Blender X", [ids.bl1, ids.bl2]);
    ids.blenderY = await seedBlender("Blender Y", [ids.bl3]);

    await critic({ cigarId: ids.c1 }, 90);
    await critic({ cigarId: ids.c1 }, 80);
    await critic({ blendId: ids.bl1 }, 100);
    await critic({ cigarId: ids.c3 }, 60);
    await critic({ cigarId: ids.c4 }, 70);
    await critic({ cigarId: ids.c5 }, 10);

    await journal(ids.c1, 70);
    await journal(ids.c1, 90);
    await journal(ids.c1, null);
    await journal(ids.c3, 50);
    await journal(ids.c4, 100);
    await journal(ids.c5, 20);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  describe("at the blend", () => {
    it("counts leaf-linked and blend-linked observations together", async () => {
      // 90 + 80 (through C1) + 100 (stated on the blend itself) = 270 / 3 = 90.
      const pair = await getScoreAggregate(h.deps.db, "blend", ids.bl1);
      expect(pair.critic).toEqual({ score: 90, count: 3 });
      // 70 + 90 = 160 / 2 = 80. The third smoke on C1 carries no rating and so is
      // not in the population — a journal count is a count of ratings, never of
      // smokes.
      expect(pair.journal).toEqual({ score: 80, count: 2 });
    });

    it("excludes everything hanging off an excluded leaf", async () => {
      // BL2's only active leaf is C3. The excluded C5 carries a 10 and a 20 that
      // would drag both populations noticeably if either counted.
      const pair = await getScoreAggregate(h.deps.db, "blend", ids.bl2);
      expect(pair.critic).toEqual({ score: 60, count: 1 });
      expect(pair.journal).toEqual({ score: 50, count: 1 });
    });

    it("is null, not zero, where nothing has been observed", async () => {
      // C2 exists and has been neither reviewed nor smoked. "No critic has scored
      // this" and "critics scored it zero" are different claims.
      const pair = await getScoreAggregate(h.deps.db, "cigar", ids.c2);
      expect(pair).toEqual({ critic: null, journal: null });
    });
  });

  describe("at the leaf", () => {
    it("does not present a blend-level review as a particular vitola's score", async () => {
      // C1 carries two leaf-linked observations. The 100 was stated about the
      // BLEND, and attributing it to this vitola would invent a specificity the
      // reviewer never claimed — so the cigar-level count is 2, not 3.
      const pair = await getScoreAggregate(h.deps.db, "cigar", ids.c1);
      expect(pair.critic).toEqual({ score: 85, count: 2 });
      expect(pair.journal).toEqual({ score: 80, count: 2 });
    });
  });

  describe("roll-ups recompute over raw observations", () => {
    it("does not average the averages — and the fixture proves the difference", async () => {
      const line1 = await getScoreAggregate(h.deps.db, "line", ids.l1);
      const line2 = await getScoreAggregate(h.deps.db, "line", ids.l2);
      const brand = await getScoreAggregate(h.deps.db, "brand", ids.brand);

      // L1's observations are 90, 80, 100, 60 → 330 / 4 = 82.5.
      expect(line1.critic).toEqual({ score: 82.5, count: 4 });
      // L2's is 70 alone.
      expect(line2.critic).toEqual({ score: 70, count: 1 });
      // The brand's five observations are 90, 80, 100, 60, 70 → 400 / 5 = 80.
      expect(brand.critic).toEqual({ score: 80, count: 5 });

      // Averaging the two line means would give (82.5 + 70) / 2 = 76.25, which
      // over-weights the single-observation line by a factor of four. That the
      // brand reads 80 and not 76.25 IS the "no averages of averages" rule.
      const averageOfAverages = (line1.critic!.score + line2.critic!.score) / 2;
      expect(averageOfAverages).toBe(76.25);
      expect(brand.critic!.score).not.toBe(averageOfAverages);

      // Counts add up the same way: 4 + 1 = 5 observations, not 2 lines.
      expect(brand.critic!.count).toBe(line1.critic!.count + line2.critic!.count);
    });

    it("rolls the journal population up the same spine", async () => {
      // L1's ratings are 70, 90 (C1) and 50 (C3) → 210 / 3 = 70.
      expect((await getScoreAggregate(h.deps.db, "line", ids.l1)).journal).toEqual({
        score: 70,
        count: 3,
      });
      // The brand adds C4's 100 → 310 / 4 = 77.5.
      expect((await getScoreAggregate(h.deps.db, "brand", ids.brand)).journal).toEqual({
        score: 77.5,
        count: 4,
      });
    });

    it("keeps the two populations separate at every level", async () => {
      // Critic 80 over 5, journal 77.5 over 4, at the same brand. If the two ever
      // agreed by construction the pair would be worthless — the divergence is
      // the product (ADR-013's Rotten Tomatoes model).
      const brand = await getScoreAggregate(h.deps.db, "brand", ids.brand);
      expect(brand.critic).toEqual({ score: 80, count: 5 });
      expect(brand.journal).toEqual({ score: 77.5, count: 4 });
    });
  });

  describe("the blender roll-up is NC territory", () => {
    it("aggregates a blender's New World blends", async () => {
      // Blender X is credited on BL1 and BL2, both NC: 90, 80, 100, 60 → 82.5.
      const pair = await getScoreAggregate(h.deps.db, "blender", ids.blenderX);
      expect(pair.critic).toEqual({ score: 82.5, count: 4 });
      // Journal: 70, 90 (BL1) and 50 (BL2) → 210 / 3 = 70.
      expect(pair.journal).toEqual({ score: 70, count: 3 });
    });

    it("excludes a Cuban blend, so a Cuban credit rolls up to nothing", async () => {
      // Blender Y's only blend is BL3, whose leaf is CC. Habanos credits the
      // marca, not a person; a blender number here would be an invented fact.
      const pair = await getScoreAggregate(h.deps.db, "blender", ids.blenderY);
      expect(pair).toEqual({ critic: null, journal: null });
      // The observation itself is not lost — it counts at the marca, which is
      // exactly where ADR-013 says a Cuban roll-up stops.
      expect((await getScoreAggregate(h.deps.db, "blend", ids.bl3)).critic).toEqual({
        score: 70,
        count: 1,
      });
    });

    it("is fail-closed: an untyped or mixed blend contributes nothing", async () => {
      // Two more blenders, each on a blend the gate must refuse for a different
      // reason. `type` is nullable and most production rows are NULL, so a
      // negative test (`!== 'CC'`) would credit a blender on every row nobody has
      // established anything about — the same defect the cigar detail page's
      // positive gate exists to avoid.
      // Under a brand of its own, not the shared fixture's: these extra
      // observations would otherwise change the brand-level totals that the
      // roll-up assertions above pin exactly, making those tests depend on the
      // order this file happens to run in.
      const gateBrand = await seedBrand("Gate");
      const gateLine = await seedLine(gateBrand, "Gate Line");
      const untypedBlend = await seedBlend(gateLine, "Untyped Blend");
      const untypedLeaf = await h.seedCigar({
        canonicalName: `Untyped ${tag}`,
        brandId: gateBrand,
        lineId: gateLine,
        blendId: untypedBlend,
      });
      const mixedBlend = await seedBlend(gateLine, "Mixed Blend");
      const mixedNc = await h.seedCigar({
        canonicalName: `Mixed NC ${tag}`,
        brandId: gateBrand,
        lineId: gateLine,
        blendId: mixedBlend,
        type: "NC",
      });
      await h.seedCigar({
        canonicalName: `Mixed CC ${tag}`,
        brandId: gateBrand,
        lineId: gateLine,
        blendId: mixedBlend,
        type: "CC",
      });

      await critic({ cigarId: untypedLeaf }, 95);
      await critic({ cigarId: mixedNc }, 95);
      await journal(untypedLeaf, 95);
      await journal(mixedNc, 95);

      const untypedBlender = await seedBlender("Blender Untyped", [untypedBlend]);
      const mixedBlender = await seedBlender("Blender Mixed", [mixedBlend]);

      expect(await getScoreAggregate(h.deps.db, "blender", untypedBlender)).toEqual({
        critic: null,
        journal: null,
      });
      expect(await getScoreAggregate(h.deps.db, "blender", mixedBlender)).toEqual({
        critic: null,
        journal: null,
      });

      // Both blends still score at the blend level. The gate withholds the
      // BLENDER claim, not the evidence.
      expect((await getScoreAggregate(h.deps.db, "blend", untypedBlend)).critic).toEqual({
        score: 95,
        count: 1,
      });
      expect((await getScoreAggregate(h.deps.db, "blend", mixedBlend)).critic).toEqual({
        score: 95,
        count: 1,
      });
    });
  });

  // ADR-013 §1, the ruling this whole slice exists to make mechanical: "No
  // surface may present a single smoke's score as the score of a blend, line, or
  // brand." The type system carries half of it — there is no shape here that
  // yields a score without a count — and these assertions carry the rest.
  describe("a single smoke is never a blend's number", () => {
    it("reports its own sample count of one rather than collapsing to the rating", async () => {
      // BL2's journal population is exactly one smoke, rated 50.
      const pair = await getScoreAggregate(h.deps.db, "blend", ids.bl2);
      expect(pair.journal).not.toBeNull();
      // The count is present, and it says one. A caller cannot obtain the 50
      // without also being handed the 1.
      expect(pair.journal!.count).toBe(1);
      expect(Object.keys(pair.journal!).sort()).toEqual(["count", "score"]);
    });

    it("holds at every level above the leaf, not just at the blend", async () => {
      // The same lone smoke, seen from a blend of its own, a line of its own and a
      // brand of its own — the levels where ADR-013 says a bare rating would be a
      // misrepresentation. Every one of them carries count 1.
      const brandId = await seedBrand("Lonely");
      const lineId = await seedLine(brandId, "Lonely Line");
      const blendId = await seedBlend(lineId, "Lonely Blend");
      const cigarId = await h.seedCigar({
        canonicalName: `Lonely ${tag}`,
        brandId,
        lineId,
        blendId,
        type: "NC",
      });
      const blenderId = await seedBlender("Blender Lonely", [blendId]);
      await journal(cigarId, 64);

      for (const [level, id] of [
        ["cigar", cigarId],
        ["blend", blendId],
        ["line", lineId],
        ["brand", brandId],
        ["blender", blenderId],
      ] as const) {
        const pair = await getScoreAggregate(h.deps.db, level, id);
        expect(pair.journal, `${level} must report the lone rating as an aggregate`).toEqual({
          score: 64,
          count: 1,
        });
      }
    });

    it("counts ratings, not smokes, so more logging never inflates the sample", async () => {
      // A second smoke of the same cigar with no rating. If the count tracked
      // smokes it would now read 2 and the mean would be wrong or undefined.
      const before = await getScoreAggregate(h.deps.db, "blend", ids.bl2);
      await journal(ids.c3, null);
      const after = await getScoreAggregate(h.deps.db, "blend", ids.bl2);
      expect(after.journal).toEqual(before.journal);
      expect(after.journal!.count).toBe(1);
    });
  });

  // The journal population is a privacy boundary, not a filter (ADR-013 §3 read
  // against the visibility model migration 0001 already ships). A journal rating
  // is private by default, so a community score that averaged every rating would
  // publish exactly the entries their authors marked private — and at a sample
  // count of one it would print that one private rating verbatim.
  describe("the journal population respects journal visibility", () => {
    it("leaves a private journal out of the community score, and says nothing at all rather than something wrong", async () => {
      const brandId = await seedBrand("Private");
      const lineId = await seedLine(brandId, "Private Line");
      const blendId = await seedBlend(lineId, "Private Blend");
      const cigarId = await h.seedCigar({
        canonicalName: `Private ${tag}`,
        brandId,
        lineId,
        blendId,
        type: "NC",
      });

      const privateUser = await h.createUser(`private-${tag}@example.com`);
      await saveSmoke(h.deps, privateUser, {
        clientRequestId: newRequestId(),
        cigar: { cigarId },
        assessment: { rating: 99, impression: "Kept to myself." },
      });

      // The default population is the safe one: a caller that never thought about
      // visibility does not publish a private rating.
      const community = await getScoreAggregate(h.deps.db, "blend", blendId);
      expect(community.journal).toBeNull();

      // The rating is not lost — its owner can still see it aggregated. A private
      // journal is exactly what its author is entitled to read back.
      const own = await getScoreAggregate(h.deps.db, "blend", blendId, {
        kind: "user",
        userId: privateUser.userId,
      });
      expect(own.journal).toEqual({ score: 99, count: 1 });

      // And it is not visible to somebody else asking for their own.
      const other = await getScoreAggregate(h.deps.db, "blend", blendId, {
        kind: "user",
        userId: user.userId,
      });
      expect(other.journal).toBeNull();
    });

    it("counts only the public half of a mixed population", async () => {
      const brandId = await seedBrand("Mixed Visibility");
      const lineId = await seedLine(brandId, "Mixed Visibility Line");
      const blendId = await seedBlend(lineId, "Mixed Visibility Blend");
      const cigarId = await h.seedCigar({
        canonicalName: `Mixed Visibility ${tag}`,
        brandId,
        lineId,
        blendId,
        type: "NC",
      });

      // 60 from the public fixture author, 100 from someone who did not publish.
      await journal(cigarId, 60);
      const quiet = await h.createUser(`quiet-${tag}@example.com`);
      await saveSmoke(h.deps, quiet, {
        clientRequestId: newRequestId(),
        cigar: { cigarId },
        assessment: { rating: 100, impression: "Also kept to myself." },
      });

      // Averaging both would read 80 over 2. The community score is 60 over 1 —
      // and the count says one, so nobody can mistake it for a consensus.
      expect((await getScoreAggregate(h.deps.db, "blend", blendId)).journal).toEqual({
        score: 60,
        count: 1,
      });
    });

    it("leaves the critic population alone — it has no visibility to respect", async () => {
      // External reviews are published by definition; the journal population
      // switch must not touch them.
      const asUser = await getScoreAggregate(h.deps.db, "brand", ids.brand, {
        kind: "user",
        userId: user.userId,
      });
      const asCommunity = await getScoreAggregate(h.deps.db, "brand", ids.brand);
      expect(asUser.critic).toEqual(asCommunity.critic);
      expect(asUser.critic).toEqual({ score: 80, count: 5 });
    });
  });

  describe("batch reads", () => {
    it("answers for every id asked about, including ones with nothing to say", async () => {
      const unknown = "00000000-0000-0000-0000-000000000000";
      const map = await getScoreAggregates(h.deps.db, "blend", [ids.bl1, ids.bl3, unknown]);
      expect(map.size).toBe(3);
      expect(map.get(ids.bl1)!.critic).toEqual({ score: 90, count: 3 });
      expect(map.get(ids.bl3)!.critic).toEqual({ score: 70, count: 1 });
      // An id with no observations and an id that does not exist are the same
      // answer here: this module reports what the observations say, not whether
      // an entity exists.
      expect(map.get(unknown)).toEqual({ critic: null, journal: null });
    });

    it("agrees with the single read it exists to batch", async () => {
      const map = await getScoreAggregates(h.deps.db, "line", [ids.l1, ids.l2]);
      expect(map.get(ids.l1)).toEqual(await getScoreAggregate(h.deps.db, "line", ids.l1));
      expect(map.get(ids.l2)).toEqual(await getScoreAggregate(h.deps.db, "line", ids.l2));
    });

    it("returns an empty map for an empty id list without touching the database", async () => {
      expect((await getScoreAggregates(h.deps.db, "brand", [])).size).toBe(0);
    });
  });

  it("resolves a leaf with no blend up to the brand it does belong to", async () => {
    // Ancestry is partial by design (ADR-012): unknown stays NULL. A cigar with a
    // brand and no blend still belongs to that brand and must count there —
    // dropping it would silently shrink a brand's sample.
    const brandId = await seedBrand("Partial");
    const cigarId = await h.seedCigar({
      canonicalName: `Partial ${tag}`,
      brandId,
      type: "NC",
    });
    await critic({ cigarId }, 77);

    expect((await getScoreAggregate(h.deps.db, "brand", brandId)).critic).toEqual({
      score: 77,
      count: 1,
    });
    const scope = await h.deps.db.execute(sql`
      SELECT blend_id, line_id FROM cigar_ancestry WHERE cigar_id = ${cigarId}
    `);
    const row = (
      scope.rows as unknown as { blend_id: string | null; line_id: string | null }[]
    )[0]!;
    expect(row.blend_id).toBeNull();
    expect(row.line_id).toBeNull();
  });
});
