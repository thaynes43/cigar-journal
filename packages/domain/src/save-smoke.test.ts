import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  smokes,
  smokeProgression,
  smokeConsumptions,
  purchases,
  cigars,
  idempotencyKeys,
  auditLog,
  enrichmentRequests,
} from "@cj/db";
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
          specificDescriptors: ["Tangerine peel", "grandpa's attic"],
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
    // descriptors are normalized to kebab-case, but specificDescriptors are the
    // user's exact words and must survive VERBATIM — no casing/space folding.
    expect(progression[1]!.descriptors).toEqual(["cream", "citrus"]);
    expect(progression[1]!.specificDescriptors).toEqual(["Tangerine peel", "grandpa's attic"]);

    const keys = await h.deps.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.clientRequestId, input.clientRequestId));
    expect(keys).toHaveLength(1);

    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, result.smoke.smokeId));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("smoke.created");
    expect(audits[0]!.actor).toBe("mcp");
    // A session-driven principal carries no OAuth client (#183).
    expect(audits[0]!.clientId).toBeNull();
  });

  it("records the calling credential's client on a journal write, and null without one", async () => {
    // The incident question issue #183 exists for: a service token minted with the
    // default allowlist can write its subject's journal, and before this those rows
    // were indistinguishable from the same subject's own web session. actor and
    // clientId are asserted TOGETHER — the sweep that added the client must not have
    // quietly changed an actor.
    const cigarId = await h.seedCigar({ canonicalName: "Attribution Test Robusto" });
    const viaToken: Principal = { ...user, clientId: "cl_service_token" };

    const withClient = await saveSmoke(h.deps, viaToken, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
      assessment: { liked: true },
    });
    const clientless = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
      assessment: { liked: true },
    });

    const rowFor = async (smokeId: string) =>
      (await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, smokeId)))[0]!;
    const tokenRow = await rowFor(withClient.smoke.smokeId);
    expect([tokenRow.actor, tokenRow.clientId]).toEqual(["mcp", "cl_service_token"]);
    const sessionRow = await rowFor(clientless.smoke.smokeId);
    expect([sessionRow.actor, sessionRow.clientId]).toEqual(["mcp", null]);
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

  it("errors cigar_ambiguous with differentiator-bearing candidates when several strongly match", async () => {
    await h.seedCigar({ canonicalName: "Cohiba Robusto", brand: "Cohiba", vitolaName: "Robusto" });
    await h.seedCigar({ canonicalName: "Cohiba Robustos", brand: "Cohiba", vitolaName: "Robustos" });
    const promise = saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Cohiba Robusto" } },
      overallDescriptors: ["cedar"],
    });
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CigarAmbiguousError);
    const payload = (error as CigarAmbiguousError).toPayload();
    expect(payload.code).toBe("cigar_ambiguous");
    const candidates = payload.candidates as {
      cigarId: string;
      canonicalName: string;
      brand: string | null;
      vitola: string | null;
      verification: string;
    }[];
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    // Candidates carry the fields that make the ask_user answerable.
    for (const c of candidates) {
      expect(c).toHaveProperty("brand");
      expect(c).toHaveProperty("vitola");
      expect(c.verification).toBe("verified");
    }
    expect(candidates.map((c) => c.vitola)).toEqual(expect.arrayContaining(["Robusto", "Robustos"]));
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

  // ---- explicit consumption (ADR-008) --------------------------------------

  it("captures a from-humidor consumption at save (source user) and folds it into the audit", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Consume Corona", brand: "Csm" });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      consumption: { fromHumidor: true },
    });
    const rows = await h.deps.db
      .select()
      .from(smokeConsumptions)
      .where(eq(smokeConsumptions.smokeId, result.smoke.smokeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("user");
    expect(rows[0]!.purchaseId).toBeNull();

    const audit = (
      await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, result.smoke.smokeId))
    )[0]!;
    expect((audit.after as { consumption?: { source: string } }).consumption?.source).toBe("user");
  });

  it("writes NO consumption when the block is omitted or fromHumidor is false", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Unknown Provenance Robusto", brand: "Unk" });
    const omitted = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
    });
    const explicitFalse = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["lounge"],
      consumption: { fromHumidor: false },
    });
    for (const id of [omitted.smoke.smokeId, explicitFalse.smoke.smokeId]) {
      const rows = await h.deps.db
        .select()
        .from(smokeConsumptions)
        .where(eq(smokeConsumptions.smokeId, id));
      expect(rows).toHaveLength(0);
    }
  });

  it("attributes a consumption to an owned lot and rejects a foreign lot", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Lot Attribution Lonsdale", brand: "Lot" });
    const otherCigarId = await h.seedCigar({ canonicalName: "Other Cigar", brand: "Oth" });
    const [lot] = await h.deps.db
      .insert(purchases)
      .values({ userId: user.userId, cigarId, quantity: 5, purchasedAt: "2026-01-01" })
      .returning({ id: purchases.id });
    const [foreignLot] = await h.deps.db
      .insert(purchases)
      .values({ userId: user.userId, cigarId: otherCigarId, quantity: 5 })
      .returning({ id: purchases.id });

    const ok = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      consumption: { fromHumidor: true, purchaseId: lot!.id },
    });
    const rows = await h.deps.db
      .select()
      .from(smokeConsumptions)
      .where(eq(smokeConsumptions.smokeId, ok.smoke.smokeId));
    expect(rows[0]!.purchaseId).toBe(lot!.id);

    // A lot of a DIFFERENT cigar is foreign → validation_error, no smoke written.
    const error = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      consumption: { fromHumidor: true, purchaseId: foreignLot!.id },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.some((f) => f.path === "consumption.purchaseId")).toBe(true);
  });

  it("does not double-deduct on a replayed save with consumption", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Replay Consume Toro", brand: "RepC" });
    const input: SaveSmokeInput = {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      consumption: { fromHumidor: true },
    };
    const first = await saveSmoke(h.deps, user, input);
    const second = await saveSmoke(h.deps, user, input);
    expect(second.replayed).toBe(true);
    const rows = await h.deps.db
      .select()
      .from(smokeConsumptions)
      .where(eq(smokeConsumptions.smokeId, first.smoke.smokeId));
    expect(rows).toHaveLength(1); // linked once, not twice
  });

  it("returns holdingAfter only when a consumption block was supplied, reflecting the deduction", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "HoldingAfter Toro", brand: "HA" });
    await h.deps.db.insert(purchases).values({ userId: user.userId, cigarId, quantity: 3 });

    // No consumption block → no holdingAfter (nothing was deducted, none reported).
    const omitted = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
    });
    expect(omitted.holdingAfter).toBeUndefined();

    // fromHumidor: false — the block is present, so the (undeducted) stock is reported.
    const off = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["lounge"],
      consumption: { fromHumidor: false },
    });
    expect(off.holdingAfter).toEqual({ totalAcquired: 3, remaining: 3 });

    // fromHumidor: true — deducts one; holdingAfter shows the new remaining (mirrors record_purchase).
    const deduct = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["humidor"],
      consumption: { fromHumidor: true },
    });
    expect(deduct.holdingAfter).toEqual({ totalAcquired: 3, remaining: 2 });
  });
  // ---- gap-fill enrichment (#177) -------------------------------------------
  // add_cigar → save_smoke is the documented path; a described save is the safety
  // net for a client that skipped the prelude, and when it CREATES the entry it
  // queues what add_cigar would have queued. Three gates, each asserted below —
  // created, described, llm-conversation provenance. The created gate keeps the
  // queue off the merely-incomplete rows that make up most of the catalog; the
  // provenance gate keeps the next full archive import from filing one request
  // per distinct cigar.

  // The enrichment-queue rows for one cigar. Filtered in JS to match the house
  // style in this suite (no extra drizzle operator imports for a one-off read).
  async function enrichmentRowsFor(cigarId: string) {
    const all = await h.deps.db.select().from(enrichmentRequests);
    return all.filter((r) => r.cigarId === cigarId);
  }

  it("queues enrichment exactly once for a described conversational save, and never twice", async () => {
    const described = {
      canonicalName: "Quasarium Halo Toro",
      brand: "Quasarium",
      type: "NC" as const,
    };
    const first = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described },
      overallDescriptors: ["marker"],
      provenance: { source: "llm-conversation" },
    });
    expect(first.cigarCreated).toBe(true);
    expect(first.enrichmentQueued).toBe(true);
    const cigarId = first.smoke.cigar.cigarId;
    expect(await enrichmentRowsFor(cigarId)).toHaveLength(1);

    // A second smoke of the same cigar LINKS to the row just created (exact name),
    // so it filled no gap and the created gate stops it before the queue is even
    // consulted. That is what keeps a heavy smoker off a pile of duplicates.
    const second = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described },
      overallDescriptors: ["marker"],
      provenance: { source: "llm-conversation" },
    });
    expect(second.smoke.cigar.cigarId).toBe(cigarId);
    expect(second.cigarCreated).toBe(false);
    expect(second.enrichmentQueued).toBe(false);
    expect(await enrichmentRowsFor(cigarId)).toHaveLength(1);
  });

  it("queues NOTHING for a described legacy-import save (the archive-reimport guard)", async () => {
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Vellichor Sable Corona", brand: "Vellichor" } },
      originalMarkdown: "Imported from the legacy ledger.",
      provenance: { source: "legacy-import", client: "importer" },
    });
    expect(result.cigarCreated).toBe(true);
    expect(result.enrichmentQueued).toBe(false);
    expect(await enrichmentRowsFor(result.smoke.cigar.cigarId)).toHaveLength(0);
  });

  it("queues nothing for a manual save or for a save against an existing cigarId", async () => {
    // The web form: described gap-fill is possible there too, but it has its own
    // repair surfaces and must not push work into the crawler's queue.
    const manual = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Petrichor Vector Robusto", brand: "Petrichor" } },
      overallDescriptors: ["marker"],
      provenance: { source: "manual" },
    });
    expect(manual.cigarCreated).toBe(true);
    expect(manual.enrichmentQueued).toBe(false);
    expect(await enrichmentRowsFor(manual.smoke.cigar.cigarId)).toHaveLength(0);

    // The common path — a resolved id — takes no enrichment reads at all.
    const cigarId = await h.seedCigar({ canonicalName: "Sonderling Prism Toro", brand: "Sonderling" });
    const byId = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      provenance: { source: "llm-conversation" },
    });
    expect(byId.enrichmentQueued).toBe(false);
    expect(await enrichmentRowsFor(cigarId)).toHaveLength(0);
  });

  it("queues nothing for a described save that LINKS to an existing incomplete cigar", async () => {
    // The created gate, which is the whole of review major 1 on PR #188. Without
    // it the enrichment fired on resolve as well as create, so every conversational
    // save of an already-catalogued cigar filed a request — and most catalog rows
    // are incomplete, so that is roughly one row per described save, aimed at
    // exactly the unverified/untyped entries the curation press refuses without an
    // override. It also made enrichmentQueued:true reachable with
    // cigarCreated:false, which all four surfaces documenting the field say
    // cannot happen.
    const canonicalName = "Ambergris Tide Robusto";
    const cigarId = await h.seedCigar({ canonicalName, brand: "Ambergris", verification: "unverified" });

    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName, brand: "Ambergris" } },
      overallDescriptors: ["marker"],
      provenance: { source: "llm-conversation" },
    });

    expect(result.smoke.cigar.cigarId).toBe(cigarId);
    expect(result.cigarCreated).toBe(false);
    expect(result.enrichmentQueued).toBe(false);
    expect(await enrichmentRowsFor(cigarId)).toHaveLength(0);
  });

  it("saves the smoke even when the enrichment queue fails, and says enrichmentQueued false", async () => {
    // Never trade the entry for the enrichment. Driven with a REAL Postgres error
    // rather than a stubbed throw, because the hazard is server-side: a failed
    // statement aborts the transaction, so every later statement — the smoke, its
    // audit row — fails too. A stubbed throw would not reproduce that and a bare
    // try/catch would not survive it. Rolling back to the savepoint is what does.
    await h.deps.db.execute(sql`
      create function cj_test_block_enrichment() returns trigger as $$
      begin raise exception 'enrichment boom'; end;
      $$ language plpgsql
    `);
    await h.deps.db.execute(sql`
      create trigger cj_test_block_enrichment before insert on enrichment_requests
      for each row execute function cj_test_block_enrichment()
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await saveSmoke(h.deps, user, {
        clientRequestId: newRequestId(),
        cigar: { described: { canonicalName: "Ferrous Cascade Toro", brand: "Ferrous" } },
        overallDescriptors: ["marker"],
        provenance: { source: "llm-conversation" },
      });

      expect(result.cigarCreated).toBe(true);
      expect(result.enrichmentQueued).toBe(false);

      // The committed row, not just the returned envelope — the point is that the
      // transaction survived the failure inside it.
      const saved = await h.deps.db.select().from(smokes).where(eq(smokes.id, result.smoke.smokeId));
      expect(saved).toHaveLength(1);
      expect(await enrichmentRowsFor(result.smoke.cigar.cigarId)).toHaveLength(0);

      // And the loss of the enrichment is not silent.
      expect(warn.mock.calls.flat().join(" ")).toContain("enrichment_queue_failed");
    } finally {
      warn.mockRestore();
      await h.deps.db.execute(sql`drop trigger cj_test_block_enrichment on enrichment_requests`);
      await h.deps.db.execute(sql`drop function cj_test_block_enrichment()`);
    }
  });

  // Two identical saves genuinely in flight together under one clientRequestId.
  // The loser can be turned back at either of two gates: the in-transaction
  // loadIdempotency check, if the winner has already committed, or the unique
  // violation on (user_id, client_request_id), if it has not. The second is the
  // one that was dead before isUniqueViolation walked the cause chain — drizzle
  // wraps the pg error, so the code sat one `cause` hop below where the
  // predicate looked, the replay never fired, and the loser saw a raw 23505.
  //
  // Left to chance that gate is the rarer of the two, so the smokes insert is
  // slowed to hold both transactions open past each other's loadIdempotency and
  // make the collision the normal outcome. The assertions still only claim what
  // BOTH gates owe — neither call rejects, exactly one is the writer, one smoke
  // row — so a scheduling change cannot turn this into a flake.
  it("replays instead of rejecting when two identical saves race the same clientRequestId", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Race Condition Robusto", brand: "Race" });
    const input: SaveSmokeInput = {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
      journal: { title: "Raced", narrative: "Two callers, one request id." },
    };

    await h.deps.db.execute(sql`
      create function cj_test_slow_smoke() returns trigger as $$
      begin perform pg_sleep(0.25); return new; end;
      $$ language plpgsql
    `);
    await h.deps.db.execute(sql`
      create trigger cj_test_slow_smoke before insert on smokes
      for each row execute function cj_test_slow_smoke()
    `);

    try {
      const settled = await Promise.allSettled([
        saveSmoke(h.deps, user, input),
        saveSmoke(h.deps, user, input),
      ]);

      // Carried as reason strings so a regression names the error it threw.
      const rejected = settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason)] : []));
      expect(rejected).toEqual([]);

      const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(results.filter((r) => r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.smoke.smokeId)).size).toBe(1);

      // The loser's rolled-back smoke insert must leave nothing behind.
      const rows = await h.deps.db.select().from(smokes).where(eq(smokes.cigarId, cigarId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(results[0]!.smoke.smokeId);

      const keys = await h.deps.db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.clientRequestId, input.clientRequestId));
      expect(keys).toHaveLength(1);
    } finally {
      await h.deps.db.execute(sql`drop trigger cj_test_slow_smoke on smokes`);
      await h.deps.db.execute(sql`drop function cj_test_slow_smoke()`);
    }
  });
});
