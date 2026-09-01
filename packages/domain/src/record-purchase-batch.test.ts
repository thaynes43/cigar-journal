import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { purchases, cigars, enrichmentRequests, auditLog, vendors } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { recordPurchaseBatch, MAX_BATCH_ITEMS } from "./record-purchase-batch.js";
import { recordPurchase } from "./record-purchase.js";
import { getMyInventory } from "./inventory.js";
import { ValidationError, IdempotencyConflictError } from "./errors.js";
import type { Principal, RecordPurchaseBatchItemInput, RecordPurchaseBatchItemResult } from "./index.js";

// The fourteen sticks of the sampler that motivated this tool (#231). They are
// one product family a word apart, which is exactly the shape the resolver
// refuses to decide alone — so this list is both the acceptance scenario and the
// hardest input the ambiguity arm sees.
const MONSTERS = [
  "The Frank",
  "The Drac",
  "The Face",
  "The Mummy",
  "The Wolfman",
  "The JV13",
  "The Krueger",
  "The Chuck",
  "The Michael",
  "The Jason",
  "The Tiff",
  "The Bride",
  "The Skinny Monster",
  "The Pudgy Monster",
].map((name) => `Tatuaje Monster Smash ${name}`);

function item(
  canonicalName: string,
  overrides: Partial<RecordPurchaseBatchItemInput> = {},
): RecordPurchaseBatchItemInput {
  return {
    clientRequestId: newRequestId(),
    cigar: { described: { canonicalName, brand: "Tatuaje", type: "NC" } },
    quantity: 1,
    ...overrides,
  };
}

describe("recordPurchaseBatch", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("record-purchase-batch@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function purchaseRowsFor(cigarIds: string[]) {
    if (cigarIds.length === 0) return [];
    return h.deps.db.select().from(purchases).where(inArray(purchases.cigarId, cigarIds));
  }

  it("ingests a fourteen-stick sampler in two calls, the second re-sending the whole batch", async () => {
    // THE ACCEPTANCE SCENARIO. A real Tatuaje Monster Smash sampler cost roughly
    // three calls per stick before this tool existed (search_cigars →
    // add_cigar(confirmedDistinct) → record_purchase(cigarId)) — about forty-two
    // calls for fourteen cigars.
    //
    // Pass 1: nothing in the catalog matches, so the first monster is created;
    // each one after it lands a word away from a sibling this batch just minted,
    // which is precisely the case the resolver hands back rather than guessing.
    const buyer: Principal = { ...user, clientId: "cl_sampler_token" };
    const items = MONSTERS.map((name) => item(name));
    const first = await recordPurchaseBatch(h.deps, buyer, {
      clientRequestId: newRequestId(),
      defaults: { purchasedAt: "2026-08-31", vendorName: "Small Batch Cigar", packaging: "sampler" },
      items,
    });

    expect(first.summary.items).toBe(14);
    expect(first.summary.failed).toBe(0);
    // Every line is decided one way or the other, and the ambiguity is real —
    // that is the friction this tool has to survive, not fail on.
    expect(first.summary.created + first.summary.ambiguous).toBe(14);
    expect(first.summary.ambiguous).toBeGreaterThan(0);
    expect(first.summary.created).toBeGreaterThan(0);
    // An ambiguous line answers with the siblings to put to the user, and wrote
    // nothing at all.
    const ambiguous = first.items.filter((r) => r.status === "ambiguous");
    for (const line of ambiguous) {
      expect(line.error?.code).toBe("cigar_ambiguous");
      expect((line.error?.candidates as unknown[]).length).toBeGreaterThan(0);
      expect(line.purchaseId).toBeUndefined();
    }

    // Pass 2 is the documented recovery: the user was shown the candidates and
    // confirmed none is theirs, so the WHOLE batch goes back under a fresh batch
    // id with confirmedDistinct on just the ambiguous lines. Every other item is
    // byte-identical and must replay rather than buy a second time.
    const confirmed = new Set(ambiguous.map((r) => r.index));
    const second = await recordPurchaseBatch(h.deps, buyer, {
      clientRequestId: newRequestId(),
      defaults: { purchasedAt: "2026-08-31", vendorName: "Small Batch Cigar", packaging: "sampler" },
      items: items.map((entry, index) =>
        confirmed.has(index) ? { ...entry, confirmedDistinct: true } : entry,
      ),
    });

    expect(second.summary.recorded).toBe(14);
    expect(second.summary.ambiguous).toBe(0);
    expect(second.summary.failed).toBe(0);
    expect(second.summary.sticks).toBe(14);
    // Every line created its catalog entry — a replayed line reports what it
    // originally did, so `replayed` is the orthogonal count of how many of them
    // did no new work this time. The lines that landed in pass 1 replayed; the
    // confirmed ones did the rest.
    expect(second.summary.created).toBe(14);
    expect(second.summary.replayed).toBe(first.summary.created);
    expect(second.summary.recorded - second.summary.replayed).toBe(first.summary.ambiguous);

    // Fourteen distinct catalog rows, fourteen ledger rows — not one more.
    const cigarIds = second.items.map((r) => r.cigar!.cigarId);
    expect(new Set(cigarIds).size).toBe(14);
    expect(await purchaseRowsFor(cigarIds)).toHaveLength(14);

    // Every row was created from the user's words, so every one queued the
    // specs-and-photo lookup add_cigar would have queued.
    const queued = await h.deps.db
      .select()
      .from(enrichmentRequests)
      .where(inArray(enrichmentRequests.cigarId, cigarIds));
    expect(queued).toHaveLength(14);

    // The shared facts reached every line, and the audit rows carry the
    // credential that bought (#183) — a batch does not launder attribution.
    const rows = await purchaseRowsFor(cigarIds);
    expect(rows.every((r) => r.packaging === "sampler")).toBe(true);
    expect(rows.every((r) => r.purchasedAt === "2026-08-31")).toBe(true);
    const purchaseIds = new Set(rows.map((r) => r.id));
    const audits = (await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId))).filter(
      (a) => a.action === "purchase.record" && purchaseIds.has((a.after as { purchaseId: string }).purchaseId),
    );
    expect(audits).toHaveLength(14);
    expect(audits.every((a) => a.actor === "mcp" && a.clientId === "cl_sampler_token")).toBe(true);

    // And the humidor really holds fourteen sticks of it.
    const inventory = await getMyInventory(h.deps, user);
    const held = inventory.holdings.filter((holding) => cigarIds.includes(holding.cigar.cigarId));
    expect(held).toHaveLength(14);
    expect(held.every((holding) => holding.remaining === 1)).toBe(true);
  }, 60_000);

  it("isolates a failing line: the good ones land and the bad one says why", async () => {
    const good = await h.seedCigar({ canonicalName: "Batch Isolation Robusto", brand: "BI" });
    const alsoGood = await h.seedCigar({ canonicalName: "Batch Isolation Toro", brand: "BI" });

    const result = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      items: [
        { clientRequestId: newRequestId(), cigar: { cigarId: good }, quantity: 3 },
        // A correction with no reason — record_purchase's own rule, enforced per
        // line rather than at the batch edge.
        { clientRequestId: newRequestId(), cigar: { cigarId: alsoGood }, quantity: -1 },
        { clientRequestId: newRequestId(), cigar: { cigarId: alsoGood }, quantity: 2 },
      ],
    });

    expect(result.items.map((r) => r.status)).toEqual(["existing", "failed", "existing"]);
    expect(result.summary).toMatchObject({ recorded: 2, existing: 2, failed: 1, sticks: 5 });
    // The field path names WHICH line, which is the whole difference between a
    // fixable answer and a hunt through the batch.
    expect(result.items[1]!.error?.code).toBe("validation_error");
    expect((result.items[1]!.error?.fields as { path: string }[])[0]!.path).toBe("items[1].notes");
    // The failed line wrote nothing; the two good ones did.
    expect(await purchaseRowsFor([alsoGood])).toHaveLength(1);
  });

  it("labels a described line that links to an existing row `existing` and queues no enrichment", async () => {
    // The created gate, inherited whole from record_purchase: a line that filled
    // no catalog gap must not file an enrichment request against a row that was
    // already there.
    const canonicalName = "Batch Linkage Lancero";
    const cigarId = await h.seedCigar({ canonicalName, brand: "Linkage", verification: "unverified" });

    const result = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      items: [
        {
          clientRequestId: newRequestId(),
          cigar: { described: { canonicalName, brand: "Linkage" } },
          quantity: 2,
        },
      ],
    });

    const line = result.items[0]!;
    expect(line.status).toBe("existing");
    expect(line.cigar!.cigarId).toBe(cigarId);
    expect(line.enrichmentQueued).toBe(false);
    expect(
      await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId)),
    ).toHaveLength(0);
  });

  it("applies defaults per line, letting an item override one and null another out", async () => {
    const [vendor] = await h.deps.db
      .insert(vendors)
      .values({ name: "Batch Defaults Cigar Co" })
      .returning({ id: vendors.id });
    const inherits = await h.seedCigar({ canonicalName: "Defaults Inherited Corona", brand: "DF" });
    const overrides = await h.seedCigar({ canonicalName: "Defaults Overridden Corona", brand: "DF" });
    const optsOut = await h.seedCigar({ canonicalName: "Defaults Cleared Corona", brand: "DF" });

    const result = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      defaults: {
        purchasedAt: "2026-07-04",
        vendorName: "Batch Defaults Cigar Co",
        packaging: "box",
        pricePerStick: 8,
      },
      items: [
        { clientRequestId: newRequestId(), cigar: { cigarId: inherits }, quantity: 1 },
        { clientRequestId: newRequestId(), cigar: { cigarId: overrides }, quantity: 1, pricePerStick: 12.5 },
        // An explicit null is how ONE line opts out of a default the rest share.
        { clientRequestId: newRequestId(), cigar: { cigarId: optsOut }, quantity: 1, vendorName: null },
      ],
    });
    expect(result.summary.recorded).toBe(3);

    const byCigar = new Map(
      (await purchaseRowsFor([inherits, overrides, optsOut])).map((row) => [row.cigarId, row]),
    );
    expect(byCigar.get(inherits)!.purchasedAt).toBe("2026-07-04");
    expect(byCigar.get(inherits)!.vendorId).toBe(vendor!.id);
    expect(Number(byCigar.get(inherits)!.pricePerStick)).toBe(8);
    expect(Number(byCigar.get(overrides)!.pricePerStick)).toBe(12.5);
    // The override is field-scoped: the other defaults still apply to that line.
    expect(byCigar.get(overrides)!.packaging).toBe("box");
    expect(byCigar.get(optsOut)!.vendorId).toBeNull();
    expect(byCigar.get(optsOut)!.purchasedAt).toBe("2026-07-04");
  });

  it("replays the whole batch on an identical re-send, and conflicts on a changed one", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Batch Envelope Belicoso", brand: "BE" });
    const clientRequestId = newRequestId();
    const items = [{ clientRequestId: newRequestId(), cigar: { cigarId }, quantity: 4 }];

    const first = await recordPurchaseBatch(h.deps, user, { clientRequestId, items });
    expect(first.replayed).toBe(false);

    const replay = await recordPurchaseBatch(h.deps, user, { clientRequestId, items });
    expect(replay.replayed).toBe(true);
    expect(replay.items).toEqual(first.items);
    // A replay does no work at all — one ledger row, not two.
    expect(await purchaseRowsFor([cigarId])).toHaveLength(1);

    // Same batch id, different intent: not recoverable, mint a new id.
    const conflict = await recordPurchaseBatch(h.deps, user, {
      clientRequestId,
      items: [{ ...items[0]!, quantity: 9 }],
    }).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(IdempotencyConflictError);
  });

  it("replays a line whose own key was spent by a standalone record_purchase", async () => {
    // The item envelope is the record_purchase envelope: a line already logged
    // singly must not buy a second time just because it arrived inside a batch.
    const cigarId = await h.seedCigar({ canonicalName: "Cross Surface Churchill", brand: "CS" });
    const itemRequestId = newRequestId();
    const single = await recordPurchase(h.deps, user, {
      clientRequestId: itemRequestId,
      cigar: { cigarId },
      quantity: 5,
      purchasedAt: "2026-03-03",
    });

    const batch = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      defaults: { purchasedAt: "2026-03-03" },
      items: [{ clientRequestId: itemRequestId, cigar: { cigarId }, quantity: 5 }],
    });

    const line = batch.items[0]!;
    expect(line.replayed).toBe(true);
    expect(line.purchaseId).toBe(single.purchaseId);
    expect(batch.summary).toMatchObject({ recorded: 1, replayed: 1 });
    expect(await purchaseRowsFor([cigarId])).toHaveLength(1);
  });

  it("reports a spent line key used for a different intent as that line's failure", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Spent Key Panatela", brand: "SK" });
    const other = await h.seedCigar({ canonicalName: "Spent Key Perfecto", brand: "SK" });
    const itemRequestId = newRequestId();
    await recordPurchase(h.deps, user, { clientRequestId: itemRequestId, cigar: { cigarId }, quantity: 1 });

    const result = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      items: [
        { clientRequestId: itemRequestId, cigar: { cigarId }, quantity: 7 },
        { clientRequestId: newRequestId(), cigar: { cigarId: other }, quantity: 1 },
      ],
    });

    expect(result.items[0]!.status).toBe("failed");
    expect(result.items[0]!.error?.code).toBe("idempotency_conflict");
    // And the batch carried on — the conflict is one line's problem.
    expect(result.items[1]!.status).toBe("existing");
  });

  it("refuses a batch whose envelope keys collide, before spending any of them", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Collision Corona", brand: "CO" });
    const clientRequestId = newRequestId();
    const shared = newRequestId();

    const duplicated = await recordPurchaseBatch(h.deps, user, {
      clientRequestId,
      items: [
        { clientRequestId: shared, cigar: { cigarId }, quantity: 1 },
        { clientRequestId: shared, cigar: { cigarId }, quantity: 2 },
      ],
    }).catch((e: unknown) => e);
    expect(duplicated).toBeInstanceOf(ValidationError);
    expect((duplicated as ValidationError).fields[0]!.path).toBe("items[1].clientRequestId");

    // The batch id is an envelope key too — reusing it for a line would spend it.
    const reusedBatchId = await recordPurchaseBatch(h.deps, user, {
      clientRequestId,
      items: [{ clientRequestId, cigar: { cigarId }, quantity: 1 }],
    }).catch((e: unknown) => e);
    expect(reusedBatchId).toBeInstanceOf(ValidationError);

    // Nothing was written and no key was spent, so a corrected send goes through
    // under the same batch id.
    const fixed = await recordPurchaseBatch(h.deps, user, {
      clientRequestId,
      items: [{ clientRequestId: newRequestId(), cigar: { cigarId }, quantity: 1 }],
    });
    expect(fixed.summary.recorded).toBe(1);
  });

  it("refuses an empty batch and one over the item ceiling", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Ceiling Cazadores", brand: "CE" });
    const empty = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      items: [],
    }).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(ValidationError);
    expect((empty as ValidationError).fields[0]!.path).toBe("items");

    const oversized = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      items: Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({
        clientRequestId: newRequestId(),
        cigar: { cigarId },
        quantity: 1,
      })),
    }).catch((e: unknown) => e);
    expect(oversized).toBeInstanceOf(ValidationError);
    expect((oversized as ValidationError).fields[0]!.message).toContain(String(MAX_BATCH_ITEMS));
  });

  it("keeps a batch scoped to its caller", async () => {
    const stranger = await h.createUser("batch-stranger@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Scoped Sampler Short", brand: "SS" });
    await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      items: [{ clientRequestId: newRequestId(), cigar: { cigarId }, quantity: 2 }],
    });

    const theirs = await getMyInventory(h.deps, stranger);
    expect(theirs.holdings.some((holding) => holding.cigar.cigarId === cigarId)).toBe(false);
  });

  it("counts a correction line as net sticks, not as another acquisition", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Net Sticks Nub", brand: "NS" });
    const result = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      items: [
        { clientRequestId: newRequestId(), cigar: { cigarId }, quantity: 5 },
        {
          clientRequestId: newRequestId(),
          cigar: { cigarId },
          quantity: -2,
          notes: "Two of the five were already logged.",
        },
      ],
    });
    expect(result.summary.sticks).toBe(3);
    const last = result.items[1] as RecordPurchaseBatchItemResult;
    expect(last.holdingAfter).toEqual({ totalAcquired: 3, remaining: 3 });
  });

  it("resolves the lines in order, so a repeated name links to the row the batch just minted", async () => {
    // Sequential execution is a correctness property, not a performance choice:
    // run concurrently, two lines naming the same cigar could each see a catalog
    // without the other and mint two rows for one product.
    const canonicalName = "Sequential Seed Sublime";
    const result = await recordPurchaseBatch(h.deps, user, {
      clientRequestId: newRequestId(),
      items: [
        {
          clientRequestId: newRequestId(),
          cigar: { described: { canonicalName, brand: "Sequential" } },
          quantity: 1,
        },
        {
          clientRequestId: newRequestId(),
          cigar: { described: { canonicalName, brand: "Sequential" } },
          quantity: 1,
        },
      ],
    });

    expect(result.items.map((r) => r.status)).toEqual(["created", "existing"]);
    expect(result.items[0]!.cigar!.cigarId).toBe(result.items[1]!.cigar!.cigarId);
    expect(
      await h.deps.db.select().from(cigars).where(eq(cigars.canonicalName, canonicalName)),
    ).toHaveLength(1);
  });
});
