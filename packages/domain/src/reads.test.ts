import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import {
  getSmoke,
  queryMySmokes,
  searchCigars,
  getCigar,
  getCigarOffers,
  getCigarOfferHistory,
  getCigarPricing,
  getCigarPriceHistory,
  browseCigars,
} from "./reads.js";
import type { Principal } from "./index.js";
import { CigarNotFoundError, SmokeNotFoundError, ValidationError } from "./errors.js";

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

  it("getSmoke answers a malformed id exactly as it answers an unknown one", async () => {
    // A non-uuid string used to reach the `uuid` column and raise Postgres 22P02 —
    // untyped, so it escaped this error path and surfaced as a 500 wherever the id
    // is not validated a layer up (the MCP `get_smoke` tool). The two cases are
    // indistinguishable to a caller and must stay so.
    const malformed = await getSmoke(h.deps, userA, { smokeId: "not-a-uuid" }).catch(
      (e: unknown) => e,
    );
    const unknown = await getSmoke(h.deps, userA, { smokeId: newRequestId() }).catch(
      (e: unknown) => e,
    );
    expect(malformed).toBeInstanceOf(SmokeNotFoundError);
    expect(unknown).toBeInstanceOf(SmokeNotFoundError);
    expect((malformed as SmokeNotFoundError).toPayload()).toEqual(
      (unknown as SmokeNotFoundError).toPayload(),
    );
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

  it("queryMySmokes carries the assessed strength verbatim for the journal-card meter", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Strength Source", brand: "Meter" });
    const assessed = await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      assessment: { strength: "medium-full" },
      journal: { narrative: "Assessed for strength." },
    });
    const unassessed = await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      journal: { narrative: "No strength stated." },
    });

    const listed = await queryMySmokes(h.deps, userA, { cigarId });
    const assessedRow = listed.smokes.find((s) => s.smokeId === assessed.smoke.smokeId)!;
    const unassessedRow = listed.smokes.find((s) => s.smokeId === unassessed.smoke.smokeId)!;
    expect(assessedRow.strength).toBe("medium-full");
    expect(unassessedRow.strength).toBeNull();
  });

  it("queryMySmokes keyset-paginates the journal via nextCursor without dups or gaps", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Keyset Ledger", brand: "Pagination" });

    // Five timestamped smokes plus one never-timestamped (legacy) tail row, so
    // the walk crosses the smokedAt-NULLS-LAST boundary.
    const times = [
      "2026-01-05T09:00:00Z",
      "2026-02-05T09:00:00Z",
      "2026-03-05T09:00:00Z",
      "2026-04-05T09:00:00Z",
      "2026-05-05T09:00:00Z",
    ];
    for (const value of times) {
      await saveSmoke(h.deps, userA, {
        clientRequestId: newRequestId(),
        cigar: { cigarId },
        smokedAt: { value, source: "user", precision: "minute" },
        journal: { narrative: `Seeded ${value}.` },
      });
    }
    await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      provenance: { source: "legacy-import" },
      originalMarkdown: "## Review 1 - Toro - undated\n\nNo date on this one.",
    });

    // Six < the default limit, so one page is the reference order to reproduce.
    const full = await queryMySmokes(h.deps, userA, { cigarId });
    expect(full.totalMatches).toBe(6);
    expect(full.nextCursor).toBeNull();
    expect(full.smokes[0]!.smokedAt.value).toContain("2026-05-05"); // newest first
    expect(full.smokes[5]!.smokedAt.value).toBeNull(); // the legacy tail last
    const expected = full.smokes.map((s) => s.smokeId);

    // Walk in pages of two; the cursor must reproduce the reference order exactly.
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await queryMySmokes(h.deps, userA, { cigarId, limit: 2, cursor });
      expect(page.totalMatches).toBe(6); // the total ignores the cursor
      walked.push(...page.smokes.map((s) => s.smokeId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull(); // the last page carries no next cursor
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(6); // no duplicates across pages

    // A malformed cursor degrades to the first page rather than erroring.
    const degraded = await queryMySmokes(h.deps, userA, { cigarId, limit: 2, cursor: "not-base64" });
    expect(degraded.smokes.map((s) => s.smokeId)).toEqual(expected.slice(0, 2));
  });

  it("browseCigars lists catalog rows alphabetically, catalog-only, with a total count", async () => {
    await h.seedCigar({ canonicalName: "Zzz Browse Omega", brand: "Zed" });
    await h.seedCigar({
      canonicalName: "Aaa Browse Alpha",
      brand: "Ayy",
      vitolaName: "Robusto",
      type: "NC",
    });

    const result = await browseCigars(h.deps);
    const names = result.cigars.map((c) => c.canonicalName);
    expect(names.indexOf("Aaa Browse Alpha")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("Aaa Browse Alpha")).toBeLessThan(names.indexOf("Zzz Browse Omega"));

    // Under the cap in this suite: the page is the whole catalog.
    expect(result.totalCount).toBe(result.cigars.length);

    // Catalog-only fields — no per-caller personal counts leak in.
    const alpha = result.cigars.find((c) => c.canonicalName === "Aaa Browse Alpha")!;
    expect(alpha.vitola.name).toBe("Robusto");
    expect(alpha).not.toHaveProperty("userSmokeCount");
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

    // Match provenance: the hit is attributed to original_markdown and carries a
    // plain-text excerpt around the term, so the client sees WHY it matched
    // without a follow-up get_smoke.
    const hit = byText.smokes.find((s) => s.smokeId === imported.smoke.smokeId)!;
    expect(hit.matchedIn).toEqual(["originalMarkdown"]);
    expect(hit.matchSnippet).toBeTruthy();
    expect(hit.matchSnippet!.toLowerCase()).toContain("burn");
    // Plain text — the ts_headline sentinels never leak into the excerpt.
    expect(hit.matchSnippet).not.toMatch(/[⟪⟫]/);
    expect(hit.matchSnippet!.length).toBeLessThanOrEqual(160);
  });

  it("attributes a text hit to journal fields and omits provenance on non-text queries", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: "Oliva Serie V Melanio",
      brand: "Oliva",
    });
    const saved = await saveSmoke(h.deps, userA, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["espresso"],
      progression: [
        { stage: "finish", descriptors: ["cocoa"], verbatim: "A gorgeous leathery finish." },
      ],
      assessment: { impression: "Leathery depth throughout." },
      journal: { title: "Melanio night", narrative: "Rich and leathery from first light." },
    });

    // "leathery" appears in narrative, impression, and progression verbatim.
    const byText = await queryMySmokes(h.deps, userA, { text: "leathery" });
    const hit = byText.smokes.find((s) => s.smokeId === saved.smoke.smokeId)!;
    expect(hit.matchedIn).toContain("narrative");
    expect(hit.matchedIn).toContain("impression");
    expect(hit.matchedIn).toContain("progression");
    expect(hit.matchedIn).not.toContain("title"); // title has no "leathery"
    expect(hit.matchSnippet!.toLowerCase()).toContain("leather");

    // A non-text query (descriptor filter) is byte-for-byte unchanged — no
    // matchedIn / matchSnippet keys at all.
    const byDescriptor = await queryMySmokes(h.deps, userA, { descriptor: "espresso" });
    const plain = byDescriptor.smokes.find((s) => s.smokeId === saved.smoke.smokeId)!;
    expect(plain).not.toHaveProperty("matchedIn");
    expect(plain).not.toHaveProperty("matchSnippet");
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

  it("searchCigars does NOT single_match a lone, non-exact fuzzy candidate", async () => {
    // A brand token shared with a different product scores high on trigram
    // similarity. A lone such candidate must ask (multiple_matches), never
    // auto-proceed (single_match) — otherwise the smoke is silently mislinked.
    await h.seedCigar({
      canonicalName: "Vanguard Reserve Hemingway Short Story",
      brand: "Vanguard Reserve",
    });
    const result = await searchCigars(h.deps, userA, { query: "Vanguard Reserve OpusX" });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0]!.canonicalName).toBe("Vanguard Reserve Hemingway Short Story");
    expect(result.guidance).toBe("multiple_matches");
    expect(result.guidance).not.toBe("single_match");
  });

  it("queryMySmokes rejects a malformed date filter as validation_error, not unavailable", async () => {
    const error = await queryMySmokes(h.deps, userA, { smokedAfter: "not-a-date" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.some((f) => f.path === "smokedAfter")).toBe(true);
  });

  // #206. Every read below is reachable with an id the caller chose, and each one
  // used to carry that raw string into a `uuid` column. The assertion is always
  // the same shape — malformed must be INDISTINGUISHABLE from unknown-but-valid —
  // because that equality, not the specific value, is the contract being pinned.
  it("getCigar answers a malformed id exactly as it answers an unknown one", async () => {
    const malformed = await getCigar(h.deps, userA, { cigarId: "not-a-uuid" }).catch(
      (e: unknown) => e,
    );
    const unknown = await getCigar(h.deps, userA, { cigarId: newRequestId() }).catch(
      (e: unknown) => e,
    );
    expect(malformed).toBeInstanceOf(CigarNotFoundError);
    expect(unknown).toBeInstanceOf(CigarNotFoundError);
    expect((malformed as CigarNotFoundError).toPayload()).toEqual(
      (unknown as CigarNotFoundError).toPayload(),
    );
  });

  it("queryMySmokes narrows a malformed cigarId filter to nothing, as an unknown one does", async () => {
    // A filter is not an identity: naming no cigar returns an empty page rather
    // than a not-found, so the guard must narrow instead of throw.
    const malformed = await queryMySmokes(h.deps, userA, { cigarId: "not-a-uuid" });
    const unknown = await queryMySmokes(h.deps, userA, { cigarId: newRequestId() });
    expect(malformed.smokes).toEqual([]);
    expect(malformed).toEqual(unknown);
  });

  it("the catalog price reads answer a malformed cigarId exactly as an unknown one", async () => {
    // getCigarOffers and getCigarPricing are guarded through latestSeries; the two
    // history reads run their own SQL and carry their own guards. All four answer
    // with emptiness rather than an error, so emptiness is what must match.
    const bad = "not-a-uuid";
    const unknown = newRequestId();
    expect(await getCigarOffers(h.deps, { cigarId: bad })).toEqual(
      await getCigarOffers(h.deps, { cigarId: unknown }),
    );
    expect(await getCigarOfferHistory(h.deps, { cigarId: bad })).toEqual(
      await getCigarOfferHistory(h.deps, { cigarId: unknown }),
    );
    expect(await getCigarPricing(h.deps, bad)).toEqual(await getCigarPricing(h.deps, unknown));
    expect(await getCigarPriceHistory(h.deps, { cigarId: bad })).toEqual(
      await getCigarPriceHistory(h.deps, { cigarId: unknown }),
    );
    // Pin the values too, so a future change that made BOTH paths throw could not
    // satisfy the equalities above while breaking the contract.
    expect(await getCigarOffers(h.deps, { cigarId: bad })).toEqual([]);
    expect(await getCigarPricing(h.deps, bad)).toBeNull();
    expect(await getCigarPriceHistory(h.deps, { cigarId: bad })).toEqual([]);
    expect(await getCigarOfferHistory(h.deps, { cigarId: bad })).toEqual({
      firstSeenAt: null,
      lastSeenAt: null,
      minPricePerStick: null,
      maxPricePerStick: null,
      observationCount: 0,
    });
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
