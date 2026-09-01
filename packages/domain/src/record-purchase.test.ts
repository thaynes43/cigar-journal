import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { purchases, vendors, cigars, enrichmentRequests, auditLog } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { recordPurchase } from "./record-purchase.js";
import { getMyInventory } from "./inventory.js";
import type { Principal } from "./index.js";
import { CigarAmbiguousError, ValidationError } from "./errors.js";

describe("recordPurchase", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("record-purchase@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("logs a described-cigar acquisition, auto-creating the cigar and queuing enrichment", async () => {
    const result = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Aurora Arc Toro", brand: "Aurora", type: "NC" } },
      quantity: 10,
      purchasedAt: "2026-01-10",
      packaging: "box",
      pricePerStick: 12.5,
    });
    expect(result.cigar.verification).toBe("unverified"); // created from words
    expect(result.holdingAfter).toEqual({ totalAcquired: 10, remaining: 10 });
    expect(result.replayed).toBe(false);

    const rows = await h.deps.db.select().from(purchases).where(eq(purchases.id, result.purchaseId));
    expect(rows[0]!.source).toBe("llm-conversation");
    expect(rows[0]!.quantity).toBe(10);
    expect(Number(rows[0]!.pricePerStick)).toBe(12.5);

    // Described cigar → enrichment queued through the same path add_cigar uses.
    const queued = await h.deps.db
      .select()
      .from(enrichmentRequests)
      .where(eq(enrichmentRequests.cigarId, result.cigar.cigarId));
    expect(queued).toHaveLength(1);

    // purchase.record audit row, attributed to the mcp actor, no smokeId.
    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId));
    const rec = audits.find(
      (a) => a.action === "purchase.record" && (a.after as { purchaseId?: string }).purchaseId === result.purchaseId,
    );
    expect(rec).toBeDefined();
    expect(rec!.actor).toBe("mcp");
    expect(rec!.smokeId).toBeNull();
    expect(rec!.clientId).toBeNull(); // no credential on this principal (#183)
  });

  it("queues nothing when a described purchase LINKS to an existing catalog row", async () => {
    // The created gate: the queue exists to fill a gap this purchase opened. A
    // described name that resolves to a row already in the catalog filled no gap,
    // and queueing there would file a request against exactly the unverified and
    // untyped rows the #154 curation press refuses without an override.
    const canonicalName = "Ambergris Tide Purchase";
    const cigarId = await h.seedCigar({ canonicalName, brand: "Ambergris", verification: "unverified" });

    const result = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName, brand: "Ambergris" } },
      quantity: 2,
    });

    expect(result.cigar.cigarId).toBe(cigarId);
    expect(
      await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId)),
    ).toHaveLength(0);
  });

  it("stamps the calling credential's client on the purchase audit row", async () => {
    // The inventory half of #183: a leaked journal-scoped token buying on the
    // owner's behalf must be separable from the owner's own console afterwards.
    const cigarId = await h.seedCigar({ canonicalName: "Client Attribution Corona" });
    const result = await recordPurchase(h.deps, { ...user, clientId: "cl_journal_token" }, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 3,
    });

    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.userId, user.userId));
    const rec = audits.find(
      (a) => a.action === "purchase.record" && (a.after as { purchaseId?: string }).purchaseId === result.purchaseId,
    )!;
    expect([rec.actor, rec.clientId]).toEqual(["mcp", "cl_journal_token"]);
  });

  it("resolves a known vendor case-insensitively and links it by id", async () => {
    const [vendor] = await h.deps.db
      .insert(vendors)
      .values({ name: "Small Batch Cigar" })
      .returning({ id: vendors.id });
    const cigarId = await h.seedCigar({ canonicalName: "Vendor Match Robusto", brand: "VM" });

    const result = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 5,
      vendorName: "small batch cigar", // different casing
    });
    const row = (await h.deps.db.select().from(purchases).where(eq(purchases.id, result.purchaseId)))[0]!;
    expect(row.vendorId).toBe(vendor!.id);
    expect(row.notes).toBeNull();
    // A resolved id ref does not queue enrichment.
    expect(
      await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, cigarId)),
    ).toHaveLength(0);
  });

  it("stores an unknown vendor name in notes rather than minting a registry row", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Ghost Vendor Corona", brand: "GV" });
    const before = await h.deps.db.select().from(vendors);

    const result = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 3,
      vendorName: "Nowhere Cigar Emporium",
      notes: "birthday gift",
    });
    const row = (await h.deps.db.select().from(purchases).where(eq(purchases.id, result.purchaseId)))[0]!;
    expect(row.vendorId).toBeNull();
    expect(row.notes).toContain("birthday gift");
    expect(row.notes).toContain("vendor: Nowhere Cigar Emporium");

    // No vendor registry row was created for the conversational mention.
    const after = await h.deps.db.select().from(vendors);
    expect(after).toHaveLength(before.length);
  });

  it("corrects an over-count with a negative-quantity row; holdings stay derived", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Overcount Belicoso", brand: "OC" });
    const bought = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 6,
    });
    expect(bought.holdingAfter.totalAcquired).toBe(6);

    const corrected = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: -2,
      notes: "Two were a gift, never mine.",
    });
    expect(corrected.holdingAfter.totalAcquired).toBe(4);
    expect(corrected.holdingAfter.remaining).toBe(4);

    // Both rows persist — the ledger is append-only.
    const rows = await h.deps.db.select().from(purchases).where(eq(purchases.cigarId, cigarId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.quantity).sort()).toEqual([-2, 6]);
  });

  it("rejects a negative quantity with no notes (validation_error on notes)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Reasonless Robusto", brand: "RR" });
    const error = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: -1,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.some((f) => f.path === "notes")).toBe(true);
  });

  it("rejects a zero quantity", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Zero Zino", brand: "ZZ" });
    const error = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 0,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.some((f) => f.path === "quantity")).toBe(true);
  });

  it("counts the caller's explicit humidor consumptions in remaining", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Consumed Churchill", brand: "CC" });
    // Buy, then smoke one FROM the humidor; a second smoke is off-humidor and
    // must not deduct (ADR-008 — no derivation heuristic).
    const { saveSmoke } = await import("./save-smoke.js");
    await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 3,
      purchasedAt: "2026-01-01",
    });
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["marker"],
      smokedAt: { value: "2026-02-01", source: "user", precision: "day" },
      consumption: { fromHumidor: true },
    });
    await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["lounge"],
      smokedAt: { value: "2026-02-05", source: "user", precision: "day" },
      consumption: { fromHumidor: false }, // off-humidor → no deduction
    });
    const again = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 2,
      purchasedAt: "2026-03-01",
    });
    // 5 acquired, 1 explicitly consumed from the humidor → remaining 4.
    expect(again.holdingAfter.totalAcquired).toBe(5);
    expect(again.holdingAfter.remaining).toBe(4);
  });

  it("replays an identical retry with no duplicate ledger row", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Replay Rothschild", brand: "RepR" });
    const input = {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 4,
    };
    const first = await recordPurchase(h.deps, user, input);
    const second = await recordPurchase(h.deps, user, input);
    expect(second.replayed).toBe(true);
    expect(second.purchaseId).toBe(first.purchaseId);
    const rows = await h.deps.db.select().from(purchases).where(eq(purchases.cigarId, cigarId));
    expect(rows).toHaveLength(1);
  });

  it("scopes holdings to the caller — another user's purchase is invisible", async () => {
    const intruder = await h.createUser("record-purchase-intruder@example.com");
    const cigarId = await h.seedCigar({ canonicalName: "Isolation Idolo II", brand: "Iso" });
    await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      quantity: 4,
    });
    const intruderInv = await getMyInventory(h.deps, intruder);
    expect(intruderInv.holdings.some((hh) => hh.cigar.cigarId === cigarId)).toBe(false);
  });

  it("records the purchase even when the enrichment queue fails", async () => {
    // Never trade the ledger row for the enrichment (#188). Driven with a REAL
    // Postgres error rather than a stubbed throw, because the hazard is
    // server-side: a failed statement aborts the transaction, so every other
    // statement — the purchase, its audit row — fails too. Queueing ahead of the
    // insert committed nothing at all; ordering the queue last and rolling back to
    // the savepoint is what survives it.
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
      const result = await recordPurchase(h.deps, user, {
        clientRequestId: newRequestId(),
        cigar: { described: { canonicalName: "Ferrous Cascade Toro", brand: "Ferrous" } },
        quantity: 4,
      });

      // The committed rows, not just the returned envelope — the point is that the
      // transaction survived the failure inside it.
      const rows = await h.deps.db.select().from(purchases).where(eq(purchases.id, result.purchaseId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(4);
      expect(await h.deps.db.select().from(cigars).where(eq(cigars.id, result.cigar.cigarId))).toHaveLength(1);
      expect(
        await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, result.cigar.cigarId)),
      ).toHaveLength(0);

      // And the loss of the enrichment is not silent.
      expect(warn.mock.calls.flat().join(" ")).toContain("enrichment_queue_failed");
    } finally {
      warn.mockRestore();
      await h.deps.db.execute(sql`drop trigger cj_test_block_enrichment on enrichment_requests`);
      await h.deps.db.execute(sql`drop function cj_test_block_enrichment()`);
    }
  });

  // ---- confirmedDistinct: the one-call cigar_ambiguous recovery --------------
  //
  // The flag lived only on add_cigar, so a sampler of related-but-distinct sticks
  // cost three calls each — search_cigars → add_cigar(confirmedDistinct) →
  // record_purchase(cigarId). These pin the semantics as IDENTICAL to add_cigar's
  // (add-cigar.test.ts carries the mirror cases), because a hatch that behaves
  // differently on the two tools is worse than no hatch at all.

  it("confirmedDistinct breaks a cigar_ambiguous deadlock and lands the purchase in ONE call", async () => {
    // Two same-number, non-packaging siblings that both strong-match — the guard
    // cannot separate them, so the naked query is ambiguous by design.
    await h.seedCigar({ canonicalName: "Meridian Sampler 1998 Alpha", brand: "Meridian" });
    await h.seedCigar({ canonicalName: "Meridian Sampler 1998 Beta", brand: "Meridian" });

    const clientRequestId = newRequestId();
    const described = { canonicalName: "Meridian Sampler 1998", brand: "Meridian" };

    const deadlock = await recordPurchase(h.deps, user, {
      clientRequestId,
      cigar: { described },
      quantity: 3,
    }).catch((e: unknown) => e);
    expect(deadlock).toBeInstanceOf(CigarAmbiguousError);

    // The user, shown the candidates, confirmed neither is theirs. The SAME
    // clientRequestId is reused deliberately: the ambiguous call rolled back and
    // recorded no envelope, so the recovery is a true re-issue of one intent.
    const result = await recordPurchase(h.deps, user, {
      clientRequestId,
      cigar: { described },
      confirmedDistinct: true,
      quantity: 3,
      pricePerStick: 9.5,
    });

    expect(result.cigar.canonicalName).toBe("Meridian Sampler 1998");
    expect(result.cigar.verification).toBe("unverified"); // created from their words
    expect(result.holdingAfter).toEqual({ totalAcquired: 3, remaining: 3 });
    expect(result.replayed).toBe(false);

    // A distinct row, not one of the siblings — and exactly one of it.
    const created = await h.deps.db
      .select()
      .from(cigars)
      .where(eq(cigars.canonicalName, "Meridian Sampler 1998"));
    expect(created).toHaveLength(1);
    expect(created[0]!.id).toBe(result.cigar.cigarId);

    // The ledger row landed on the same call — the whole point of the change.
    const rows = await h.deps.db.select().from(purchases).where(eq(purchases.id, result.purchaseId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cigarId).toBe(result.cigar.cigarId);
    expect(rows[0]!.quantity).toBe(3);

    // Enrichment gating is untouched: the override CREATED the row, so the gap it
    // opened is queued, exactly as an unflagged described purchase would be.
    const queued = await h.deps.db
      .select()
      .from(enrichmentRequests)
      .where(eq(enrichmentRequests.cigarId, result.cigar.cigarId));
    expect(queued).toHaveLength(1);
  });

  it("confirmedDistinct still LINKS a case-insensitive exact name — an override never mints a literal duplicate", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Zenith Ledger Prime 2020", brand: "Zenith" });

    const result = await recordPurchase(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "zenith ledger prime 2020", brand: "Zenith" } },
      confirmedDistinct: true,
      quantity: 5,
    });

    expect(result.cigar.cigarId).toBe(existingId);
    expect(result.cigar.verification).toBe("verified"); // the seeded row, not a new one
    expect(
      await h.deps.db.select().from(cigars).where(sql`lower(${cigars.canonicalName}) = 'zenith ledger prime 2020'`),
    ).toHaveLength(1);

    // created:false, so the cigar.created gate holds and nothing is queued — a
    // link filled no gap, override or not.
    expect(
      await h.deps.db.select().from(enrichmentRequests).where(eq(enrichmentRequests.cigarId, existingId)),
    ).toHaveLength(0);
  });

  it("replays a confirmedDistinct purchase — one ledger row, one cigar", async () => {
    const input = {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Vela Ledger Distinct 3000", brand: "Vela" } },
      confirmedDistinct: true,
      quantity: 2,
    };
    const first = await recordPurchase(h.deps, user, input);
    const second = await recordPurchase(h.deps, user, input);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.purchaseId).toBe(first.purchaseId);
    expect(second.cigar.cigarId).toBe(first.cigar.cigarId);
    expect(
      await h.deps.db.select().from(purchases).where(eq(purchases.cigarId, first.cigar.cigarId)),
    ).toHaveLength(1);
    expect(
      await h.deps.db.select().from(cigars).where(eq(cigars.canonicalName, "Vela Ledger Distinct 3000")),
    ).toHaveLength(1);
  });
});
