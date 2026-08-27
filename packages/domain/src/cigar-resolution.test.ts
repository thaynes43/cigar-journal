import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import type { Principal } from "./index.js";

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
});
