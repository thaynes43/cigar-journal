import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { getSmoke, queryMySmokes, searchCigars, getCigar } from "./reads.js";
import type { Principal } from "./index.js";
import { SmokeNotFoundError } from "./errors.js";

describe("read services", () => {
  let h: DomainHarness;
  let userA: Principal;
  let userB: Principal;

  beforeAll(async () => {
    h = await createHarness();
    userA = await h.createUser("reader-a@example.com");
    userB = await h.createUser("reader-b@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("getSmoke returns the full aggregate to its owner and hides it from others", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: "Trinidad Fundadores",
      brand: "Trinidad",
      type: "CC",
    });
    const saved = await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["honey", "hay"],
      progression: [
        {
          stage: "opening",
          approximatePosition: 0.1,
          descriptors: ["honey"],
          verbatim: "Sweet start.",
        },
      ],
      assessment: { rating: 88, liked: true, impression: "Elegant." },
      journal: { title: "Fundadores", narrative: "A classic light Cuban." },
    });

    const view = await getSmoke(h.deps, userA, { smokeId: saved.smoke.smokeId });
    expect(view.cigar.canonicalName).toBe("Trinidad Fundadores");
    expect(view.progression[0]!.approximatePosition).toBe(0.1);
    expect(view.assessment.rating).toBe(88);

    const error = await getSmoke(h.deps, userB, { smokeId: saved.smoke.smokeId }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SmokeNotFoundError);
  });

  it("queryMySmokes filters by descriptor and full-text, newest first, scoped to the caller", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: "Liga Privada No. 9",
      brand: "Drew Estate",
    });

    h.setNow(new Date("2026-06-01T12:00:00Z"));
    await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cocoa", "pepper"],
      journal: { narrative: "Rich and oily, sweeter than I remember." },
    });

    h.setNow(new Date("2026-07-15T12:00:00Z"));
    const recent = await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["espresso"],
      progression: [
        { stage: "middle", descriptors: ["bready"], verbatim: "A bready middle third." },
      ],
      journal: { narrative: "Drier today, more toast." },
    });

    // Another user's smoke on the same cigar must never appear.
    await saveSmoke(h.deps, userB, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cocoa"],
      journal: { narrative: "Not yours." },
    });

    const byDescriptorOverall = await queryMySmokes(h.deps, userA, { descriptor: "cocoa" });
    expect(byDescriptorOverall.totalMatches).toBe(1);

    // Descriptor also matches progression-level tags.
    const byProgressionDescriptor = await queryMySmokes(h.deps, userA, { descriptor: "bready" });
    expect(byProgressionDescriptor.smokes.map((s) => s.smokeId)).toEqual([recent.smoke.smokeId]);

    const byText = await queryMySmokes(h.deps, userA, { text: "sweeter" });
    expect(byText.totalMatches).toBe(1);

    const all = await queryMySmokes(h.deps, userA, { cigarId });
    expect(all.totalMatches).toBe(2); // userB's excluded
    expect(all.smokes[0]!.smokeId).toBe(recent.smoke.smokeId); // newest first
  });

  it("full-text finds an imported smoke whose prose lives only in original_markdown", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: "Padron 1964 Anniversary",
      brand: "Padron",
    });
    // Imported shape: narrative/impression null; content is in original_markdown.
    const imported = await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      provenance: { source: "legacy-import", client: "nc-reviews/padron/1964.md#1" },
      originalMarkdown:
        "## Review 1 - Torpedo\n\nBurn started off beautifully and stayed razor sharp.",
    });

    const byText = await queryMySmokes(h.deps, userA, { text: "burn" });
    expect(byText.smokes.map((s) => s.smokeId)).toContain(imported.smoke.smokeId);
  });

  it("searchCigars gives single/multiple/brand/no-match guidance via trigram", async () => {
    await h.seedCigar({ canonicalName: "Ashton VSG Sorcerer", brand: "Ashton" });
    await h.seedCigar({ canonicalName: "Atabey Divinos", brand: "Atabey" });
    await h.seedCigar({ canonicalName: "Atabey Ritos", brand: "Atabey" });

    // Exact (case-insensitive) canonical hit → single_match, even mixed-case.
    const single = await searchCigars(h.deps, userA, { query: "ashton vsg sorcerer" });
    expect(single.guidance).toBe("single_match");
    expect(single.matches[0]!.canonicalName).toBe("Ashton VSG Sorcerer");

    // A bare brand → brand_match, returning that brand's cigars to disambiguate.
    const brand = await searchCigars(h.deps, userA, { query: "Atabey" });
    expect(brand.guidance).toBe("brand_match");
    expect(brand.matches.length).toBe(2);
    expect(brand.matches.every((m) => m.brand === "Atabey")).toBe(true);

    const none = await searchCigars(h.deps, userA, { query: "zzzzz nonexistent brand" });
    expect(none.guidance).toBe("no_match");
  });

  it("searchCigars returns single_match with trailing fuzzy hits on an exact top match", async () => {
    // An exact canonical hit plus a near-name that also trigram-matches.
    await h.seedCigar({ canonicalName: "Montecristo No. 2", brand: "Montecristo" });
    await h.seedCigar({ canonicalName: "Montecristo No. 4", brand: "Montecristo" });

    const result = await searchCigars(h.deps, userA, { query: "Montecristo No. 2" });
    expect(result.guidance).toBe("single_match");
    expect(result.matches[0]!.canonicalName).toBe("Montecristo No. 2");
    // The other fuzzy hit is still listed, not dropped.
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
  });

  it("getCigar computes a personal profile over multiple smokes", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: "Fuente Fuente OpusX",
      brand: "Arturo Fuente",
      type: "NC",
    });

    const ratings = [84, 90, 88];
    const dates = ["2026-01-10T12:00:00Z", "2026-03-20T12:00:00Z", "2026-05-30T12:00:00Z"];
    for (let i = 0; i < 3; i++) {
      await saveSmoke(h.deps, userA, {
        clientRequestId: newRequestId(),
        cigar: { cigarId },
        smokedAt: { value: dates[i]!, source: "user", precision: "day" },
        overallDescriptors: i === 0 ? ["spice", "cedar"] : ["spice", "cream"],
        assessment: { rating: ratings[i]!, strength: "full" },
      });
    }

    const result = await getCigar(h.deps, userA, { cigarId });
    expect(result.cigar.canonicalName).toBe("Fuente Fuente OpusX");
    const profile = result.personalProfile!;
    expect(profile.smokeCount).toBe(3);
    expect(profile.recurringDescriptors).toContain("spice"); // in all 3
    expect(profile.rating).toEqual({ average: 87, min: 84, max: 90 });
    expect(profile.lastSmokedAt).toBe("2026-05-30");
    expect(profile.typicalStrength).toBe("full");

    // A user who never smoked it gets a null profile.
    const forB = await getCigar(h.deps, userB, { cigarId });
    expect(forB.personalProfile).toBeNull();
  });
});
