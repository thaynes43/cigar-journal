import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { smokes, smokeProgression, cigars, idempotencyKeys, auditLog } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import type { Principal, SaveSmokeInput } from "./index.js";
import { ValidationError, CigarAmbiguousError, IdempotencyConflictError } from "./errors.js";

describe("saveSmoke", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("save@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("persists a full conversational smoke with described cigar, progression, audit, and idempotency", async () => {
    const input: SaveSmokeInput = {
      clientRequestId: newRequestId(),
      cigar: {
        described: {
          canonicalName: "Plasencia Alma del Fuego Concepcion",
          brand: "Plasencia",
          line: "Alma del Fuego",
          vitola: { name: "Concepcion", lengthInches: 6.0, ringGauge: 52 },
          type: "NC",
        },
      },
      context: { location: "patio", pairing: ["sparkling-water"] },
      overallDescriptors: ["Spice", "Cream", "Citrus", "Earth"],
      progression: [
        { stage: "opening", approximatePosition: 0.05, descriptors: ["Spice"], verbatim: "Spice immediate." },
        {
          stage: "middle",
          approximatePosition: 0.5,
          descriptors: ["Cream", "Citrus"],
          specificDescriptors: ["Tangerine"],
          verbatim: "Bright fruit closer to tangerine.",
        },
      ],
      construction: { draw: "excellent", burn: "good", smokeOutput: "high" },
      assessment: { strength: "medium-full", body: "full", liked: true, impression: "Complex and easy to like." },
      journal: { title: "Concepcion — patio evening", narrative: "Developed from pepper into tangerine cream." },
    };

    const result = await saveSmoke(h.deps, user, input);

    expect(result.replayed).toBe(false);
    expect(result.cigarCreated).toBe(true);
    expect(result.smoke.version).toBe(1);
    expect(result.smoke.cigar.verification).toBe("unverified");

    const smokeRows = await h.deps.db.select().from(smokes).where(eq(smokes.id, result.smoke.smokeId));
    expect(smokeRows).toHaveLength(1);
    const smoke = smokeRows[0]!;
    // Descriptors normalized to kebab-case.
    expect(smoke.overallDescriptors).toEqual(["spice", "cream", "citrus", "earth"]);
    // Absent time → system-finalized (ADR-002).
    expect(smoke.smokedAtSource).toBe("system-finalized");
    expect(smoke.smokedAtPrecision).toBe("approximate");
    expect(smoke.rating).toBeNull();

    const progression = await h.deps.db
      .select()
      .from(smokeProgression)
      .where(eq(smokeProgression.smokeId, result.smoke.smokeId))
      .orderBy(smokeProgression.ordinal);
    expect(progression.map((p) => p.ordinal)).toEqual([0, 1]);
    expect(progression[1]!.specificDescriptors).toEqual(["tangerine"]);

    const keys = await h.deps.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.clientRequestId, input.clientRequestId));
    expect(keys).toHaveLength(1);

    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, result.smoke.smokeId));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("smoke.created");
    expect(audits[0]!.actor).toBe("mcp");
  });

  it("accepts a sparse but valid smoke (cigar + one substantive field)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Davidoff Signature 2000", brand: "Davidoff" });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cream", "bread"],
      construction: { draw: "excellent" },
      assessment: { liked: true },
    });
    expect(result.cigarCreated).toBe(false);
    const smoke = (await h.deps.db.select().from(smokes).where(eq(smokes.id, result.smoke.smokeId)))[0]!;
    expect(smoke.overallDescriptors).toEqual(["cream", "bread"]);
    expect(smoke.rating).toBeNull();
  });

  it("links to a strong trigram match instead of creating a duplicate", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Padron 1926 Serie No. 1", brand: "Padron" });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Padron 1926 Serie No. 1" } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.cigarCreated).toBe(false);
    expect(result.smoke.cigar.cigarId).toBe(existingId);
  });

  it("errors cigar_ambiguous with candidates when several strongly match", async () => {
    await h.seedCigar({ canonicalName: "Cohiba Robusto" });
    await h.seedCigar({ canonicalName: "Cohiba Robustos" });
    const promise = saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Cohiba Robusto" } },
      overallDescriptors: ["cedar"],
    });
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CigarAmbiguousError);
    const payload = (error as CigarAmbiguousError).toPayload();
    expect(payload.code).toBe("cigar_ambiguous");
    expect((payload.candidates as unknown[]).length).toBeGreaterThanOrEqual(2);
    // No smoke was written for the ambiguous attempt.
    const all = await h.deps.db.select().from(cigars).where(eq(cigars.canonicalName, "Cohiba Robusto"));
    expect(all).toHaveLength(1);
  });

  it("accepts an imported smoke whose only substantive content is originalMarkdown", async () => {
    const input: SaveSmokeInput = {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "God of Fire Series B", brand: "God of Fire", type: "NC" } },
      smokedAt: { value: "2025-11-16", source: "legacy-document", precision: "day" },
      assessment: { rating: 82 },
      journal: { title: "Series B 11/16", narrative: null },
      provenance: { source: "legacy-import", client: "nc-reviews/god-of-fire/series-b.md#1" },
      originalMarkdown: "## Review 1 - Double Robusto - 11/16/2025\n\nWell constructed and easy to like.",
    };
    const result = await saveSmoke(h.deps, user, input);
    expect(result.cigarCreated).toBe(true);

    const smoke = (await h.deps.db.select().from(smokes).where(eq(smokes.id, result.smoke.smokeId)))[0]!;
    expect(smoke.provenanceSource).toBe("legacy-import");
    expect(smoke.originalMarkdown).toContain("## Review 1 - Double Robusto - 11/16/2025");
    expect(smoke.journalNarrative).toBeNull();
    expect(smoke.rating).toBe(82);
    // Heading date → day-precision, legacy-document provenance.
    expect(smoke.smokedAtSource).toBe("legacy-document");
    expect(smoke.smokedAtPrecision).toBe("day");
    expect(smoke.overallDescriptors).toEqual([]);
    // Import audit rows are attributed to the import actor.
    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, result.smoke.smokeId));
    expect(audits[0]!.actor).toBe("import");
  });

  it("stamps an omitted legacy-import smokedAt as unknown with a null value", async () => {
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "La Flor Dominicana La Nox", brand: "La Flor Dominicana", type: "NC" } },
      provenance: { source: "legacy-import", client: "nc-reviews/la-flor-dominicana/la-nox.md#1" },
      originalMarkdown: "## Rview 1 - Toro - 10/31\n\nHalloween pick.",
    });
    const smoke = (await h.deps.db.select().from(smokes).where(eq(smokes.id, result.smoke.smokeId)))[0]!;
    expect(smoke.smokedAt).toBeNull();
    expect(smoke.smokedAtSource).toBe("unknown");
    expect(smoke.smokedAtPrecision).toBeNull();
  });

  it("rejects a smoke with no substantive field (minimum validity)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Arturo Fuente 8-5-8" });
    const error = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.some((f) => f.path === "smoke")).toBe(true);
  });

  it("reports rating and position violations with field paths", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Montecristo No. 4" });
    const error = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["earth"],
      assessment: { rating: 150 },
      progression: [{ stage: "opening", approximatePosition: 4, verbatim: "x" }],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    const paths = (error as ValidationError).fields.map((f) => f.path);
    expect(paths).toContain("assessment.rating");
    expect(paths).toContain("progression[0].approximatePosition");
  });

  it("replays an identical retry: original result, replayed=true, no duplicate", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Oliva Serie V Melanio" });
    const input: SaveSmokeInput = {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["espresso"],
      assessment: { rating: 91 },
    };
    const first = await saveSmoke(h.deps, user, input);
    const second = await saveSmoke(h.deps, user, input);
    expect(second.replayed).toBe(true);
    expect(second.smoke.smokeId).toBe(first.smoke.smokeId);
    const count = await h.deps.db.select().from(smokes).where(eq(smokes.cigarId, cigarId));
    expect(count).toHaveLength(1);
  });

  it("conflicts when the same clientRequestId carries a different payload", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "My Father Le Bijou 1922" });
    const clientRequestId = newRequestId();
    await saveSmoke(h.deps, user, { clientRequestId, cigar: { cigarId }, overallDescriptors: ["leather"] });
    const error = await saveSmoke(h.deps, user, {
      clientRequestId,
      cigar: { cigarId },
      overallDescriptors: ["leather", "coffee"],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
  });
});
