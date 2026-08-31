import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { auditLog, blends, brands, lines, reviewObservations, vendors } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { brandSlug } from "./catalog-browse.js";
import { recordReviewObservation, REVIEW_EXCERPT_MAX } from "./review-observations.js";
import { ValidationError } from "./errors.js";

// Review ingestion (ADR-013 §2, migration 0028) against a real Postgres.
//
// The property this file exists to prove is the acceptance criterion in issue
// #199: a re-crawl creates zero duplicates. Not "usually", and not "as long as
// the adapter remembers to check first" — the key is a database constraint and
// the writer resolves against it, so the second ingest of the same URL cannot
// produce a second row even when it races itself.
//
// The harness DB is shared across this file, so every source key carries a
// per-run tag: a bare "halfwheel" would collide between tests the moment two of
// them ingest the same fixture URL.
describe("review observations", () => {
  let h: DomainHarness;
  const tag = newRequestId().slice(0, 8);

  // A brand → line → blend chain, because a blend cannot exist without one and
  // the aggregate spine resolves through both.
  async function seedBlend(
    name: string,
  ): Promise<{ blendId: string; lineId: string; brandId: string }> {
    const brandRows = await h.deps.db
      .insert(brands)
      .values({ name: `${name} ${tag}`, slug: brandSlug(`${name} ${tag}`) })
      .returning({ id: brands.id });
    const brandId = brandRows[0]!.id;
    const lineRows = await h.deps.db
      .insert(lines)
      .values({ brandId, name: `${name} Line`, slug: brandSlug(`${name} Line`) })
      .returning({ id: lines.id });
    const lineId = lineRows[0]!.id;
    const blendRows = await h.deps.db
      .insert(blends)
      .values({ lineId, name: `${name} Blend`, slug: brandSlug(`${name} Blend`) })
      .returning({ id: blends.id });
    return { blendId: blendRows[0]!.id, lineId, brandId };
  }

  async function loadRow(observationId: string) {
    const rows = await h.deps.db.execute(sql`
      SELECT source, source_id, url, reviewer, native_scale, native_score, normalized_score,
             reviewed_at::text AS reviewed_at, excerpt, cigar_id, blend_id, raw,
             last_seen_at, created_at, updated_at
      FROM review_observations WHERE id = ${observationId}
    `);
    return (rows.rows as unknown as Record<string, unknown>[])[0]!;
  }

  // Scoped to ONE source key, not to the run tag: every source in this file
  // carries the tag, so a tag-wide filter would count every other test's rows.
  async function auditRows(action: string, source: string) {
    return await h.deps.db
      .select({
        actor: auditLog.actor,
        clientId: auditLog.clientId,
        userId: auditLog.userId,
        after: auditLog.after,
        before: auditLog.before,
      })
      .from(auditLog)
      .where(sql`${auditLog.action} = ${action} AND ${auditLog.after}->>'source' = ${source}`);
  }

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("ingests a leaf-linked observation, normalizing the native score and keeping it", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Halfwheel Toro ${tag}`, type: "NC" });
    const result = await recordReviewObservation(h.deps.db, {
      source: `halfwheel-basic-${tag}`,
      url: "https://halfwheel.example/review/toro",
      reviewer: "Charlie Minato",
      nativeScale: "0-100",
      nativeScore: 91,
      reviewedAt: "2026-03-14",
      excerpt: "Cocoa and cedar, with a black pepper finish that never turns harsh.",
      cigarId,
      raw: { extractor: "halfwheel/v1" },
      seenAt: new Date("2026-08-31T09:00:00.000Z"),
    });

    expect(result.inserted).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.normalizedScore).toBe(91);

    const row = await loadRow(result.observationId);
    // The native scale and score survive alongside the normalized value — the
    // property that makes the normalization convention restatable later.
    expect(row.native_scale).toBe("0-100");
    expect(row.native_score).toBe("91");
    expect(Number(row.normalized_score)).toBe(91);
    expect(row.reviewed_at).toBe("2026-03-14");
    expect(row.cigar_id).toBe(cigarId);
    expect(row.blend_id).toBeNull();
    expect(row.raw).toEqual({ extractor: "halfwheel/v1" });
  });

  it("normalizes a letter grade and a star rating onto the same axis", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Graded Robusto ${tag}`, type: "NC" });
    const graded = await recordReviewObservation(h.deps.db, {
      source: `letters-${tag}`,
      url: "https://letters.example/review/robusto",
      nativeScale: "letter",
      nativeScore: "B+",
      cigarId,
      seenAt: new Date("2026-08-31T09:00:00.000Z"),
    });
    expect(graded.normalizedScore).toBe(87);
    expect((await loadRow(graded.observationId)).native_score).toBe("B+");

    const starred = await recordReviewObservation(h.deps.db, {
      source: `stars-${tag}`,
      url: "https://stars.example/review/robusto",
      nativeScale: "0-5-stars",
      nativeScore: 4.5,
      cigarId,
      seenAt: new Date("2026-08-31T09:00:00.000Z"),
    });
    expect(starred.normalizedScore).toBe(90);
  });

  it("links to a blend when that is the most specific level the source states", async () => {
    const { blendId } = await seedBlend("Blendwise");
    const result = await recordReviewObservation(h.deps.db, {
      source: `blendwise-${tag}`,
      url: "https://blendwise.example/review/the-blend",
      nativeScale: "0-10",
      nativeScore: 8.7,
      blendId,
      seenAt: new Date("2026-08-31T09:00:00.000Z"),
    });
    expect(result.normalizedScore).toBe(87);
    const row = await loadRow(result.observationId);
    expect(row.blend_id).toBe(blendId);
    expect(row.cigar_id).toBeNull();
  });

  it("records the registry link when the source is registered", async () => {
    // A reviewer registers with no market focus and as no purchase destination —
    // the migration's CHECK forbids anything else.
    const vendorRows = await h.deps.db
      .insert(vendors)
      .values({ name: `Halfwheel ${tag}`, kind: "reviewer", focus: null, purchaseLinkout: false })
      .returning({ id: vendors.id });
    const sourceId = vendorRows[0]!.id;
    const cigarId = await h.seedCigar({ canonicalName: `Registered ${tag}`, type: "NC" });

    const result = await recordReviewObservation(h.deps.db, {
      source: `halfwheel-registered-${tag}`,
      sourceId,
      url: "https://halfwheel.example/review/registered",
      nativeScale: "0-100",
      nativeScore: 88,
      cigarId,
      seenAt: new Date("2026-08-31T09:00:00.000Z"),
    });
    expect((await loadRow(result.observationId)).source_id).toBe(sourceId);
  });

  describe("idempotency on (source, url)", () => {
    it("a re-crawl finding the same review writes no second row and no second audit", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Recrawled ${tag}`, type: "NC" });
      const input = {
        source: `recrawl-${tag}`,
        url: "https://recrawl.example/review/one",
        reviewer: "A. Reviewer",
        nativeScale: "0-100",
        nativeScore: 90,
        excerpt: "Consistent.",
        cigarId,
        seenAt: new Date("2026-08-31T09:00:00.000Z"),
      } as const;

      const first = await recordReviewObservation(h.deps.db, input);
      expect(first.inserted).toBe(true);

      const second = await recordReviewObservation(h.deps.db, {
        ...input,
        seenAt: new Date("2026-09-01T09:00:00.000Z"),
      });

      // Same row, and nothing the source claims has moved.
      expect(second.observationId).toBe(first.observationId);
      expect(second.inserted).toBe(false);
      expect(second.changed).toBe(false);

      const rows = await h.deps.db
        .select({ id: reviewObservations.id })
        .from(reviewObservations)
        .where(sql`${reviewObservations.source} = ${`recrawl-${tag}`}`);
      expect(rows).toHaveLength(1);

      // Liveness moved; "last edited" did not. Conflating the two would make
      // every row look freshly amended after every nightly crawl.
      const row = await loadRow(first.observationId);
      expect(new Date(row.last_seen_at as string).toISOString()).toBe("2026-09-01T09:00:00.000Z");
      expect(new Date(row.updated_at as string).toISOString()).toBe("2026-08-31T09:00:00.000Z");

      // A night of no news is not an audit event.
      expect(await auditRows("review.record", `recrawl-${tag}`)).toHaveLength(1);
      expect(await auditRows("review.amend", `recrawl-${tag}`)).toHaveLength(0);
    });

    it("a corrected score amends the row in place and is audited with its before", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Amended ${tag}`, type: "NC" });
      const base = {
        source: `amend-${tag}`,
        url: "https://amend.example/review/one",
        nativeScale: "0-100",
        cigarId,
      };
      const first = await recordReviewObservation(h.deps.db, {
        ...base,
        nativeScore: 88,
        seenAt: new Date("2026-08-31T09:00:00.000Z"),
      });
      const second = await recordReviewObservation(h.deps.db, {
        ...base,
        nativeScore: 92,
        seenAt: new Date("2026-09-05T09:00:00.000Z"),
      });

      // A reviewer correcting themselves is an amendment to ONE observation, not
      // a second data point — otherwise the correction and the original would
      // both count toward the blend's mean.
      expect(second.observationId).toBe(first.observationId);
      expect(second.inserted).toBe(false);
      expect(second.changed).toBe(true);

      const rows = await h.deps.db
        .select({ id: reviewObservations.id })
        .from(reviewObservations)
        .where(sql`${reviewObservations.source} = ${`amend-${tag}`}`);
      expect(rows).toHaveLength(1);

      const row = await loadRow(first.observationId);
      expect(Number(row.normalized_score)).toBe(92);
      expect(new Date(row.updated_at as string).toISOString()).toBe("2026-09-05T09:00:00.000Z");
      // `created_at` is when we first saw it and never moves.
      expect(new Date(row.created_at as string).toISOString()).toBe("2026-08-31T09:00:00.000Z");

      const amend = await auditRows("review.amend", `amend-${tag}`);
      expect(amend).toHaveLength(1);
      expect((amend[0]!.before as Record<string, unknown>).normalizedScore).toBe(88);
      expect((amend[0]!.after as Record<string, unknown>).normalizedScore).toBe(92);
    });

    it("keys on the source too — the same url under two sources is two observations", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Syndicated ${tag}`, type: "NC" });
      const url = "https://syndicated.example/review/shared";
      const a = await recordReviewObservation(h.deps.db, {
        source: `syn-a-${tag}`,
        url,
        nativeScale: "0-100",
        nativeScore: 80,
        cigarId,
        seenAt: new Date("2026-08-31T09:00:00.000Z"),
      });
      const b = await recordReviewObservation(h.deps.db, {
        source: `syn-b-${tag}`,
        url,
        nativeScale: "0-100",
        nativeScore: 84,
        cigarId,
        seenAt: new Date("2026-08-31T09:00:00.000Z"),
      });
      expect(b.observationId).not.toBe(a.observationId);
      expect(b.inserted).toBe(true);
    });

    it("folds the source key's case, so a capitalization change re-ingests nothing", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Cased ${tag}`, type: "NC" });
      const shared = {
        url: "https://cased.example/review/one",
        nativeScale: "0-100",
        nativeScore: 90,
        cigarId,
        seenAt: new Date("2026-08-31T09:00:00.000Z"),
      } as const;
      const first = await recordReviewObservation(h.deps.db, { ...shared, source: `Cased-${tag}` });
      const second = await recordReviewObservation(h.deps.db, {
        ...shared,
        source: `CASED-${tag}`,
      });
      expect(second.observationId).toBe(first.observationId);
      expect(second.inserted).toBe(false);
    });
  });

  describe("refusals", () => {
    const seenAt = new Date("2026-08-31T09:00:00.000Z");

    it("requires exactly one target — never zero, never both", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Targeted ${tag}`, type: "NC" });
      const { blendId } = await seedBlend("Targeted");
      const base = {
        source: `targets-${tag}`,
        url: "https://targets.example/review/one",
        nativeScale: "0-100",
        nativeScore: 90,
        seenAt,
      };
      await expect(recordReviewObservation(h.deps.db, base)).rejects.toThrow(ValidationError);
      await expect(
        recordReviewObservation(h.deps.db, { ...base, cigarId, blendId }),
      ).rejects.toThrow(ValidationError);
    });

    it("refuses an over-long excerpt rather than truncating it", async () => {
      // The bound is a copyright rule, not a formatting preference: truncating
      // would accept a full review body forever and quietly store its first 400
      // characters, so the adapter that sent a page never finds out.
      const cigarId = await h.seedCigar({ canonicalName: `Excerpted ${tag}`, type: "NC" });
      const base = {
        source: `excerpt-${tag}`,
        url: "https://excerpt.example/review/one",
        nativeScale: "0-100",
        nativeScore: 90,
        cigarId,
        seenAt,
      };
      await expect(
        recordReviewObservation(h.deps.db, {
          ...base,
          excerpt: "x".repeat(REVIEW_EXCERPT_MAX + 1),
        }),
      ).rejects.toThrow(ValidationError);

      // The bound itself is inclusive, and the stored text is not shortened.
      const ok = await recordReviewObservation(h.deps.db, {
        ...base,
        excerpt: "y".repeat(REVIEW_EXCERPT_MAX),
      });
      expect(String((await loadRow(ok.observationId)).excerpt)).toHaveLength(REVIEW_EXCERPT_MAX);
    });

    it("refuses an unknown scale and reports every problem at once", async () => {
      const base = {
        source: `bad-${tag}`,
        url: "https://bad.example/review/one",
        nativeScale: "0-20",
        nativeScore: 17,
        seenAt,
      };
      try {
        // No target AND an unknown scale: a caller should learn both in one trip
        // rather than one field per round trip.
        await recordReviewObservation(h.deps.db, base);
        expect.unreachable("should have refused");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const paths = (error as ValidationError).fields.map((f) => f.path);
        expect(paths).toContain("target");
        expect(paths).toContain("nativeScale");
      }
    });

    it("writes nothing at all when it refuses", async () => {
      const before = await h.deps.db.execute(
        sql`SELECT count(*)::int AS n FROM review_observations`,
      );
      await expect(
        recordReviewObservation(h.deps.db, {
          source: `nothing-${tag}`,
          url: "https://nothing.example/review/one",
          nativeScale: "letter",
          nativeScore: "E",
          cigarId: await h.seedCigar({ canonicalName: `Nothing ${tag}`, type: "NC" }),
          seenAt,
        }),
      ).rejects.toThrow(ValidationError);
      const after = await h.deps.db.execute(
        sql`SELECT count(*)::int AS n FROM review_observations`,
      );
      expect((after.rows as unknown as { n: number }[])[0]!.n).toBe(
        (before.rows as unknown as { n: number }[])[0]!.n,
      );
    });
  });

  describe("attribution", () => {
    it("defaults to the system actor with an explicit null client", async () => {
      const cigarId = await h.seedCigar({ canonicalName: `Systemic ${tag}`, type: "NC" });
      await recordReviewObservation(h.deps.db, {
        source: `system-${tag}`,
        url: "https://system.example/review/one",
        nativeScale: "0-100",
        nativeScore: 90,
        cigarId,
        seenAt: new Date("2026-08-31T09:00:00.000Z"),
      });
      const rows = await auditRows("review.record", `system-${tag}`);
      expect(rows).toHaveLength(1);
      // The crawler holds no credential; `auditActor` records that as an explicit
      // null rather than leaving the column to chance (#183).
      expect(rows[0]!.actor).toBe("system");
      expect(rows[0]!.clientId).toBeNull();
      expect(rows[0]!.userId).toBeNull();
    });

    it("carries an agent's principal and run onto the audit row", async () => {
      const user = await h.createUser(`agent-${tag}@example.com`);
      const cigarId = await h.seedCigar({ canonicalName: `Agented ${tag}`, type: "NC" });
      const result = await recordReviewObservation(
        h.deps.db,
        {
          source: `agent-${tag}`,
          url: "https://agent.example/review/one",
          nativeScale: "0-100",
          nativeScore: 90,
          cigarId,
          seenAt: new Date("2026-08-31T09:00:00.000Z"),
        },
        {
          actor: "agent",
          principal: { ...user, clientId: "svc-curate" },
          runId: "wo-cigar-reviews-20260831",
          correlationId: "corr-1",
        },
      );
      expect(result.inserted).toBe(true);

      const rows = await h.deps.db
        .select({
          actor: auditLog.actor,
          clientId: auditLog.clientId,
          userId: auditLog.userId,
          runId: auditLog.runId,
          correlationId: auditLog.correlationId,
        })
        .from(auditLog)
        .where(sql`${auditLog.after}->>'observationId' = ${result.observationId}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("agent");
      expect(rows[0]!.clientId).toBe("svc-curate");
      expect(rows[0]!.userId).toBe(user.userId);
      expect(rows[0]!.runId).toBe("wo-cigar-reviews-20260831");
      expect(rows[0]!.correlationId).toBe("corr-1");
    });
  });
});
