import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import {
  numbersCompatible,
  packagingCompatible,
  strongLinkCompatible,
  variantCompatible,
} from "./cigar-resolution.js";
import { variantRelation } from "./name-heuristics.js";
import type { Principal } from "./index.js";

// Pure guard coverage (no DB): the disqualifiers behind the strong-link filter.
describe("strong-link guard predicates", () => {
  it("numbersCompatible: two-sided distinct numbers are incompatible", () => {
    expect(numbersCompatible("1964 Maduro", "1926 Maduro")).toBe(false);
    expect(numbersCompatible("Liga Privada T52", "Liga Privada No. 9")).toBe(false);
  });

  it("numbersCompatible: a one-sided digit extra is incompatible", () => {
    // The reported bug: the naked name has no digit, so the old "both sides must
    // differ" rule wrongly called it compatible.
    expect(numbersCompatible("Davidoff Signature 2000", "Davidoff Signature")).toBe(false);
    expect(numbersCompatible("Davidoff Signature", "Davidoff Signature 2000")).toBe(false);
  });

  it("numbersCompatible: agreeing (or absent) numbers stay compatible", () => {
    expect(numbersCompatible("Padron 1926 Serie No. 1", "Padron 1926 Serie No. 1")).toBe(true);
    expect(numbersCompatible("Cohiba Robusto", "Cohiba Robustos")).toBe(true);
    // Same number on both sides — the packaging guard, not this one, separates a pack.
    expect(numbersCompatible("Davidoff Signature 2000", "Davidoff Signature 2000 Tubos Pack")).toBe(
      true,
    );
  });

  it("packagingCompatible: an extra packaging token is incompatible either direction", () => {
    expect(
      packagingCompatible("Davidoff Signature 2000", "Davidoff Signature 2000 Tubos Pack"),
    ).toBe(false);
    expect(packagingCompatible("Padron 1964 Tin", "Padron 1964")).toBe(false);
    expect(packagingCompatible("Oliva Serie V Sampler", "Oliva Serie V")).toBe(false);
  });

  it("packagingCompatible: no packaging mismatch stays compatible", () => {
    expect(packagingCompatible("Cohiba Robusto", "Cohiba Robustos")).toBe(true);
    // Both carry the same packaging token — a match, not a variant gap.
    expect(packagingCompatible("Padron 1964 Tin", "Padron 1964 Tin")).toBe(true);
  });

  it("strongLinkCompatible: ANDs both guards", () => {
    expect(strongLinkCompatible("Davidoff Signature 2000", "Davidoff Signature")).toBe(false);
    expect(
      strongLinkCompatible("Davidoff Signature 2000", "Davidoff Signature 2000 Tubos Pack"),
    ).toBe(false);
    expect(strongLinkCompatible("Padron 1926 Serie No. 1", "Padron 1926 Serie No. 1")).toBe(true);
  });

  // TWO GUARDS, NOT THREE. Matching v2 added a wrapper-variant guard and it
  // belongs to the MATCHER, over vendor listings, where a refusal costs a triage
  // row. `strongLinkCompatible` is the JOURNAL's guard, over words a user typed,
  // where a refusal costs a duplicate catalog entry — so the wrapper rule stays
  // out of it and the #192/#208 definition stands.
  it("strongLinkCompatible: the wrapper-variant guard is not one of them", () => {
    expect(strongLinkCompatible("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary")).toBe(true);
    expect(variantCompatible("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary")).toBe(true);
    // The matcher's own three-valued view of the same pair, which is what makes
    // the question answerable there without changing the answer here.
    expect(variantRelation("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary")).toBe("unstated");
    expect(variantRelation("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary Natural")).toBe("different");
  });

  // One wrapper, three vendor spellings, one claim.
  it("variantRelation: normalizes a two-word wrapper onto its single-token key", () => {
    expect(variantRelation("Marca Toro Sun Grown", "Marca Toro sungrown")).toBe("same");
    expect(variantRelation("Marca Toro sun-grown", "Marca Toro Sun Grown")).toBe("same");
    expect(variantRelation("Marca Toro Sun Grown", "Marca Toro Maduro")).toBe("different");
  });
});

// Regression suite for the strong-match number-token guard (cigar-resolution).
// pg_trgm similarity is blind to product numbers, so number-distinct names score
// above the strong-link threshold on shared letters alone. Production linked
// "1964 Maduro" reviews onto "Padron 1926 Maduro" and "Liga Privada T52" onto
// "...No. 9" this way (data since hand-fixed). Each case below is trigram-strong
// (asserted) yet must NOT strong-link — a new unverified cigar is created instead.
describe("resolveCigar number-token guard", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("resolve@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function similarity(a: string, b: string): Promise<number> {
    const r = await h.deps.db.execute(sql`SELECT similarity(${a}, ${b}) AS s`);
    return Number((r.rows[0] as { s: number | string }).s);
  }

  // Seeds `existing`, saves a described smoke named `query`, and asserts the save
  // created a fresh cigar rather than linking to `existing` — after first proving
  // the pair is trigram-strong (so the guard, not a weak score, is what prevents
  // the link).
  async function expectNoStrongLink(existing: string, query: string): Promise<void> {
    expect(await similarity(query, existing)).toBeGreaterThanOrEqual(0.6);
    const existingId = await h.seedCigar({ canonicalName: existing });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: query } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.smoke.cigar.cigarId).not.toBe(existingId);
    expect(result.smoke.cigar.canonicalName).toBe(query);
    expect(result.cigarCreated).toBe(true);
  }

  it("does not link 1964 Maduro onto 1926 Maduro", async () => {
    await expectNoStrongLink("1926 Maduro", "1964 Maduro");
  });

  it("does not link 1964 Natural onto 1926 Natural", async () => {
    await expectNoStrongLink("1926 Natural", "1964 Natural");
  });

  it("does not link Liga Privada T52 onto Liga Privada No. 9", async () => {
    await expectNoStrongLink("Drew Estate Liga Privada No. 9", "Drew Estate Liga Privada T52");
  });

  it("still strong-links when the model numbers agree", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Padron 1926 Serie No. 1" });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Padron 1926 Serie No. 1" } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.smoke.cigar.cigarId).toBe(existingId);
    expect(result.cigarCreated).toBe(false);
  });

  it("does not link Davidoff Signature 2000 onto the naked Davidoff Signature (one-sided digit)", async () => {
    await expectNoStrongLink("Davidoff Signature", "Davidoff Signature 2000");
  });

  it("does not link a naked stick onto its Tubos Pack (packaging variant)", async () => {
    // Tubos-only case: the packaging variant is the sole seeded row, yet the
    // naked-stick save must still create rather than silently link to a pack.
    // A distinct product name (the one-sided test above already created a
    // "…Signature 2000" row in this shared DB — reusing it would exact-link).
    await expectNoStrongLink("Montecristo Epic 2010 Tubos Pack", "Montecristo Epic 2010");
  });

  // THE SCOPE PIN FOR THE WRAPPER GUARD. Wave 2 briefly folded `variantCompatible`
  // into `strongLinkCompatible`, which silently re-decided this call: a user
  // saying "Padrón 1964 Anniversary Maduro" over a catalog row named without the
  // wrapper would have stopped linking and MINTED A SECOND ROW for the cigar they
  // have already smoked. That is the duplicate this whole wave exists to prevent,
  // arriving through the journal instead of the crawler. The guard is a matcher
  // rule; this path keeps the #192/#208 behaviour it had on main.
  it("still strong-links a described wrapper variant onto a row that names none", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Herrera Esteli Norteno Robusto" });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Herrera Esteli Norteno Robusto Maduro" } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.smoke.cigar.cigarId).toBe(existingId);
    expect(result.cigarCreated).toBe(false);
  });
});
