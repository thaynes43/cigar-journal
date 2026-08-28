import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { smokes, smokeProgression, auditLog } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { updateSmoke } from "./update-smoke.js";
import type { Principal } from "./index.js";
import { VersionConflictError, SmokeNotFoundError, ValidationError } from "./errors.js";

describe("updateSmoke", () => {
  let h: DomainHarness;
  let user: Principal;
  let smokeId: string;
  let cigarId: string;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("update@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    cigarId = await h.seedCigar({ canonicalName: `Fresh Cigar ${newRequestId()}` });
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
      assessment: { rating: 80, impression: "solid" },
      journal: { title: "t", narrative: "n" },
    });
    smokeId = saved.smoke.smokeId;
  });

  it("applies field-scoped changes, bumps version, and audits", async () => {
    const target = await h.seedCigar({ canonicalName: `Corrected ${newRequestId()}` });
    const result = await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId,
      changes: {
        assessment: { rating: 90 },
        cigar: { resolveTo: target },
        overallDescriptors: { add: ["Leather"], remove: ["cedar"] },
        journal: { title: null },
        construction: { draw: "good" },
      },
    });

    expect(result.smoke.version).toBe(2);
    expect(result.changedFields).toEqual(
      expect.arrayContaining(["assessment.rating", "cigar", "overallDescriptors", "journal.title", "construction.draw"]),
    );

    const smoke = (await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId)))[0]!;
    expect(smoke.rating).toBe(90);
    expect(smoke.cigarId).toBe(target);
    expect(smoke.overallDescriptors).toEqual(["leather"]);
    expect(smoke.journalTitle).toBeNull();
    expect(smoke.journalNarrative).toBe("n"); // omitted key keeps
    expect(smoke.draw).toBe("good");

    const audits = await h.deps.db.select().from(auditLog).where(eq(auditLog.smokeId, smokeId));
    expect(audits.some((a) => a.action === "smoke.updated")).toBe(true);
  });

  it("append-only progression is retry-safe under a replayed clientRequestId", async () => {
    const clientRequestId = newRequestId();
    const input = {
      clientRequestId,
      smokeId,
      changes: { progression: { append: [{ stage: "final inch", descriptors: ["leather"], verbatim: "Draw tightened." }] } },
    };
    const first = await updateSmoke(h.deps, user, input);
    const second = await updateSmoke(h.deps, user, input);

    expect(second.replayed).toBe(true);
    expect(second.smoke.version).toBe(first.smoke.version);
    const rows = await h.deps.db.select().from(smokeProgression).where(eq(smokeProgression.smokeId, smokeId));
    expect(rows).toHaveLength(1); // appended once, not twice
  });

  it("appends progression with continuing ordinals across separate edits", async () => {
    await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId,
      changes: { progression: { append: [{ stage: "a", verbatim: "one" }] } },
    });
    await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId,
      changes: { progression: { append: [{ stage: "b", verbatim: "two" }] } },
    });
    const rows = await h.deps.db
      .select()
      .from(smokeProgression)
      .where(eq(smokeProgression.smokeId, smokeId))
      .orderBy(smokeProgression.ordinal);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
  });

  it("rejects an empty (no-op) correction instead of bumping the version", async () => {
    const empty = await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId,
      changes: {},
    }).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(ValidationError);
    expect((empty as ValidationError).fields.some((f) => f.path === "changes")).toBe(true);

    // A block that carries no operative keys is also a no-op and rejected.
    const emptyAppend = await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId,
      changes: { progression: { append: [] } },
    }).catch((e: unknown) => e);
    expect(emptyAppend).toBeInstanceOf(ValidationError);

    // The smoke is untouched: still version 1 from beforeEach.
    const smoke = (await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId)))[0]!;
    expect(smoke.version).toBe(1);
  });

  it("errors version_conflict when expectedVersion is stale", async () => {
    const error = await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId,
      expectedVersion: 99,
      changes: { assessment: { rating: 70 } },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VersionConflictError);
    const payload = (error as VersionConflictError).toPayload();
    expect(payload.expectedVersion).toBe(99);
    expect(payload.currentVersion).toBe(1);
  });

  it("passes when a supplied expectedVersion matches", async () => {
    const result = await updateSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      smokeId,
      expectedVersion: 1,
      changes: { assessment: { rating: 70 } },
    });
    expect(result.smoke.version).toBe(2);
  });

  it("does not let another user update the smoke", async () => {
    const other = await h.createUser(`intruder-${newRequestId()}@example.com`);
    const error = await updateSmoke(h.deps, other, {
      clientRequestId: newRequestId(),
      smokeId,
      changes: { assessment: { rating: 10 } },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmokeNotFoundError);
    const smoke = (await h.deps.db.select().from(smokes).where(eq(smokes.id, smokeId)))[0]!;
    expect(smoke.rating).toBe(80); // untouched
  });
});
