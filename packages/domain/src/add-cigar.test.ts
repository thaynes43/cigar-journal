import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { enrichmentRequests, productPhotos, auditLog, cigars } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { addCigar } from "./add-cigar.js";
import { saveSmoke } from "./save-smoke.js";
import type { Principal } from "./index.js";
import { CigarAmbiguousError, ValidationError } from "./errors.js";

describe("addCigar", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("add-cigar@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function enrichmentFor(cigarId: string) {
    return h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId));
  }

  it("creates an unverified entry, queues enrichment, and audits cigar.add", async () => {
    const result = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Nebula Drift Toro", brand: "Nebula", type: "NC" },
    });
    expect(result.created).toBe(true);
    expect(result.enrichmentQueued).toBe(true);
    expect(result.replayed).toBe(false);
    expect(result.cigar.verification).toBe("unverified");

    const queued = await enrichmentFor(result.cigar.cigarId);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe("pending");
    expect(queued[0]!.requestedBy).toBe(user.userId);

    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId));
    const addAudit = audits.find(
      (a) => a.action === "cigar.add" && (a.after as { cigarId?: string }).cigarId === result.cigar.cigarId,
    );
    expect(addAudit).toBeDefined();
    expect(addAudit!.actor).toBe("mcp");
    expect(addAudit!.smokeId).toBeNull();
  });

  it("links to an existing catalog row on a second add and never double-queues enrichment", async () => {
    const first = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Comet Tail Robusto", brand: "Comet" },
    });
    expect(first.created).toBe(true);
    expect(first.enrichmentQueued).toBe(true);

    // A different intent (new clientRequestId), same name → resolves to the
    // existing row; enrichment already pending, so nothing new is queued.
    const second = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Comet Tail Robusto", brand: "Comet" },
    });
    expect(second.created).toBe(false);
    expect(second.enrichmentQueued).toBe(false);
    expect(second.cigar.cigarId).toBe(first.cigar.cigarId);

    expect(await enrichmentFor(first.cigar.cigarId)).toHaveLength(1);
  });

  it("errors cigar_ambiguous when a described name matches several catalog rows", async () => {
    await h.seedCigar({ canonicalName: "Twin Star Corona", brand: "Twin", vitolaName: "Corona" });
    await h.seedCigar({ canonicalName: "Twin Star Coronas", brand: "Twin", vitolaName: "Coronas" });
    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Twin Star Corona" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CigarAmbiguousError);
  });

  it("rejects a blank canonicalName with a field-pathed validation_error", async () => {
    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "   " },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.some((f) => f.path === "cigar.canonicalName")).toBe(true);
  });

  it("skips enrichment when requestEnrichment is false", async () => {
    const result = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Silent Meteor Lancero", brand: "Silent" },
      requestEnrichment: false,
    });
    expect(result.created).toBe(true);
    expect(result.enrichmentQueued).toBe(false);
    expect(await enrichmentFor(result.cigar.cigarId)).toHaveLength(0);
  });

  it("skips enrichment when the resolved cigar already has a photo and full vitola dims", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: "Complete Cosmos Toro",
      brand: "Complete",
      vitolaName: "Toro",
      lengthInches: "6.0",
      ringGauge: 52,
    });
    await h.deps.db.insert(productPhotos).values({
      cigarId,
      objectKey: `obj/${cigarId}`,
      thumbKey: `thumb/${cigarId}`,
      contentType: "image/webp",
      width: 800,
      height: 600,
      bytes: 12345,
    });

    const result = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Complete Cosmos Toro" },
    });
    expect(result.created).toBe(false);
    expect(result.cigar.cigarId).toBe(cigarId);
    expect(result.enrichmentQueued).toBe(false);
    expect(await enrichmentFor(cigarId)).toHaveLength(0);
  });

  it("replays an identical retry: original result, replayed=true, no duplicate enrichment", async () => {
    const input = {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Replay Ridge Robusto", brand: "Replay" },
    };
    const first = await addCigar(h.deps, user, input);
    const second = await addCigar(h.deps, user, input);
    expect(second.replayed).toBe(true);
    expect(second.cigar.cigarId).toBe(first.cigar.cigarId);
    expect(second.enrichmentQueued).toBe(first.enrichmentQueued);
    expect(await enrichmentFor(first.cigar.cigarId)).toHaveLength(1);
  });

  it("scopes the idempotency key per user — a reused id across users is not a replay", async () => {
    const other = await h.createUser("add-cigar-other@example.com");
    const clientRequestId = newRequestId();
    const mine = await addCigar(h.deps, user, {
      clientRequestId,
      cigar: { canonicalName: "Shared Orbit Perfecto", brand: "Shared" },
    });
    // Same clientRequestId value, different user: independent namespace, so this
    // is a genuine call (not a replay), and it links to the catalog row user made.
    const theirs = await addCigar(h.deps, other, {
      clientRequestId,
      cigar: { canonicalName: "Shared Orbit Perfecto", brand: "Shared" },
    });
    expect(theirs.replayed).toBe(false);
    expect(theirs.cigar.cigarId).toBe(mine.cigar.cigarId);
    expect(theirs.created).toBe(false);
    // The other user's enrichment request records them as requester, but the
    // cigar already had a pending request, so none is added.
    expect(await enrichmentFor(mine.cigar.cigarId)).toHaveLength(1);
  });

  // ---- packaging / one-sided-number guard + confirmedDistinct escape hatch ---

  // THE REPORTED REPRO, AND HALF OF IT WAS RE-DECIDED BY #164. The naked
  // `Signature` is still a different product — a one-sided digit is a structured
  // claim of difference — but the Tubos Pack is NOT: packaging is never identity,
  // so `Davidoff Signature 2000` is that row's cigar and links to it instead of
  // minting a third row beside the pack. What the repro was really about (a
  // number-distinct name must not fold onto its naked sibling) is unchanged.
  it("the reported repro: 'Davidoff Signature 2000' is distinct of Signature, links its Tubos Pack, and a smoke saves against it", async () => {
    const sigId = await h.seedCigar({
      canonicalName: "Davidoff Signature",
      brand: "Davidoff",
      line: "Signature",
      vitolaName: "Grand Toro",
    });
    const tubosId = await h.seedCigar({
      canonicalName: "Davidoff Signature 2000 Tubos Pack",
      brand: "Davidoff",
      line: "Signature",
    });

    const result = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Davidoff Signature 2000", brand: "Davidoff", line: "Signature" },
    });
    expect(result.created).toBe(false);
    expect(result.cigar.cigarId).toBe(tubosId);
    expect(result.cigar.cigarId).not.toBe(sigId);

    // The returned catalog id is real and usable — a smoke links straight to it.
    const smoke = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: result.cigar.cigarId },
      overallDescriptors: ["cream"],
    });
    expect(smoke.smoke.cigar.cigarId).toBe(result.cigar.cigarId);
    expect(smoke.cigarCreated).toBe(false);
  });

  it("confirmedDistinct overrides a genuine (non-packaging) ambiguity and creates", async () => {
    // Two same-number, non-packaging siblings that both strong-match — the
    // guard cannot separate them, so the naked query is ambiguous by design.
    await h.seedCigar({ canonicalName: "Astra Comet 1998 Alpha", brand: "Astra" });
    await h.seedCigar({ canonicalName: "Astra Comet 1998 Beta", brand: "Astra" });

    const ambiguous = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Astra Comet 1998", brand: "Astra" },
    }).catch((e: unknown) => e);
    expect(ambiguous).toBeInstanceOf(CigarAmbiguousError);

    const created = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Astra Comet 1998", brand: "Astra" },
      confirmedDistinct: true,
    });
    expect(created.created).toBe(true);
    expect(created.cigar.canonicalName).toBe("Astra Comet 1998");
  });

  it("confirmedDistinct still links a case-insensitive EXACT name (never a literal duplicate)", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Zenith Prime 2020", brand: "Zenith" });
    const result = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "zenith prime 2020", brand: "Zenith" },
      confirmedDistinct: true,
    });
    expect(result.created).toBe(false);
    expect(result.cigar.cigarId).toBe(existingId);
  });

  it("confirmedDistinct replays on the same clientRequestId — a single row, no double create", async () => {
    const input = {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Vela Distinct 3000", brand: "Vela" },
      confirmedDistinct: true,
    };
    const first = await addCigar(h.deps, user, input);
    const second = await addCigar(h.deps, user, input);
    expect(first.created).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.cigar.cigarId).toBe(first.cigar.cigarId);

    const rows = await h.deps.db
      .select({ id: cigars.id })
      .from(cigars)
      .where(eq(cigars.canonicalName, "Vela Distinct 3000"));
    expect(rows).toHaveLength(1);
  });
});
