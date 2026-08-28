import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { DomainError } from "@cj/domain";
import { createHarness, newRequestId, type DomainHarness } from "@cj/domain/testing";
import type { Principal } from "@cj/domain";
import { appRouter } from "./_app";
import type { Context } from "../trpc";

// Procedure-level tests over the real embedded-PG harness: the caller runs the
// same procedures (context, authz, error mapping) the HTTP surface runs.
function caller(deps: DomainHarness["deps"], principal: Principal | null) {
  return appRouter.createCaller({ deps, principal } satisfies Context);
}

async function trpcError(promise: Promise<unknown>): Promise<TRPCError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

describe("tRPC API", () => {
  let h: DomainHarness;
  let userA: Principal;
  let userB: Principal;

  beforeAll(async () => {
    h = await createHarness();
    userA = await h.createUser("api-a@example.com");
    userB = await h.createUser("api-b@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("rejects the unauthenticated with UNAUTHORIZED", async () => {
    const anon = caller(h.deps, null);
    const listErr = await trpcError(anon.smokes.list({}));
    expect(listErr.code).toBe("UNAUTHORIZED");
    const searchErr = await trpcError(anon.cigars.search({ query: "cohiba" }));
    expect(searchErr.code).toBe("UNAUTHORIZED");
  });

  it("runs a save → list → get → update → delete round trip, stamping manual provenance", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: `Round Trip ${newRequestId()}`,
      brand: "Padron",
    });
    const a = caller(h.deps, userA);

    const saved = await a.smokes.save({
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["Cedar", "Cocoa"],
      progression: [{ stage: "opening", descriptors: ["cedar"], verbatim: "Woody." }],
      assessment: { rating: 85, liked: true, impression: "Reliable." },
      journal: { title: "Evening", narrative: "Even burn throughout." },
    });
    expect(saved.smoke.version).toBe(1);
    const smokeId = saved.smoke.smokeId;

    const list = await a.smokes.list({ cigarId });
    expect(list.totalMatches).toBe(1);
    expect(list.smokes[0]!.smokeId).toBe(smokeId);
    expect(list.smokes[0]!.descriptors).toEqual(["cedar", "cocoa"]);

    const got = await a.smokes.get({ smokeId });
    expect(got.version).toBe(1);
    expect(got.provenance.source).toBe("manual"); // stamped server-side, not client-supplied
    expect(got.assessment.rating).toBe(85);

    const updated = await a.smokes.update({
      clientRequestId: newRequestId(),
      smokeId,
      expectedVersion: got.version,
      changes: { assessment: { rating: 92 }, overallDescriptors: { add: ["leather"] } },
    });
    expect(updated.smoke.version).toBe(2);

    const afterUpdate = await a.smokes.get({ smokeId });
    expect(afterUpdate.assessment.rating).toBe(92);
    expect(afterUpdate.overallDescriptors).toContain("leather");

    const deleted = await a.smokes.delete({ smokeId });
    expect(deleted.smokeId).toBe(smokeId);
    const goneErr = await trpcError(a.smokes.get({ smokeId }));
    expect(goneErr.code).toBe("NOT_FOUND");
  });

  it("maps a stale expected version to CONFLICT carrying the domain payload", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Conflict ${newRequestId()}` });
    const a = caller(h.deps, userA);
    const saved = await a.smokes.save({
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["earth"],
    });

    const err = await trpcError(
      a.smokes.update({
        clientRequestId: newRequestId(),
        smokeId: saved.smoke.smokeId,
        expectedVersion: 99,
        changes: { assessment: { rating: 50 } },
      }),
    );
    expect(err.code).toBe("CONFLICT");
    const domain = (err.cause as DomainError).toPayload();
    expect(domain.code).toBe("version_conflict");
    expect(domain.currentVersion).toBe(1);
  });

  it("does not let another user read, update, or delete a smoke via the API (reported not-found)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Private ${newRequestId()}` });
    const a = caller(h.deps, userA);
    const b = caller(h.deps, userB);
    const saved = await a.smokes.save({
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["hay"],
    });
    const smokeId = saved.smoke.smokeId;

    const attempts: (() => Promise<unknown>)[] = [
      () => b.smokes.get({ smokeId }),
      () =>
        b.smokes.update({
          clientRequestId: newRequestId(),
          smokeId,
          expectedVersion: 1,
          changes: { assessment: { rating: 1 } },
        }),
      () => b.smokes.delete({ smokeId }),
    ];
    for (const attempt of attempts) {
      const err = await trpcError(attempt());
      expect(err.code).toBe("NOT_FOUND");
      expect((err.cause as DomainError).code).toBe("smoke_not_found");
    }

    // A's smoke is untouched.
    const still = await a.smokes.get({ smokeId });
    expect(still.assessment.liked).toBeNull();
    expect(still.version).toBe(1);
  });

  it("browses the catalog alphabetically, catalog-only", async () => {
    await h.seedCigar({ canonicalName: "Zylophone Browse Api" });
    await h.seedCigar({ canonicalName: "Aardvark Browse Api" });
    const a = caller(h.deps, userA);

    const result = await a.cigars.browse();
    const names = result.cigars.map((c) => c.canonicalName);
    expect(names.indexOf("Aardvark Browse Api")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("Aardvark Browse Api")).toBeLessThan(names.indexOf("Zylophone Browse Api"));
    expect(result.totalCount).toBeGreaterThanOrEqual(result.cigars.length);
    expect(result.cigars[0]).not.toHaveProperty("userSmokeCount");
  });

  it("requires auth to browse the catalog", async () => {
    const anon = caller(h.deps, null);
    const err = await trpcError(anon.cigars.browse());
    expect(err.code).toBe("UNAUTHORIZED");
  });

  it("sets and clears a want mark idempotently, reflected in cigars.get, scoped to the caller", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Want Api ${newRequestId()}`, brand: "WA" });
    const a = caller(h.deps, userA);
    const b = caller(h.deps, userB);

    // Not wanted initially.
    expect((await a.cigars.get({ cigarId })).wanted).toBe(false);

    // Set → get reflects it; re-set is an idempotent no-op.
    const set = await a.cigars.setWant({ cigarId, wanted: true });
    expect(set).toMatchObject({ cigarId, wanted: true, changed: true });
    expect((await a.cigars.get({ cigarId })).wanted).toBe(true);
    expect((await a.cigars.setWant({ cigarId, wanted: true })).changed).toBe(false);

    // Another user never sees A's mark.
    expect((await b.cigars.get({ cigarId })).wanted).toBe(false);

    // Clear → get flips back.
    expect((await a.cigars.setWant({ cigarId, wanted: false })).wanted).toBe(false);
    expect((await a.cigars.get({ cigarId })).wanted).toBe(false);
  });

  it("maps a want on an unknown cigar to NOT_FOUND (cigar_not_found)", async () => {
    const a = caller(h.deps, userA);
    const err = await trpcError(
      a.cigars.setWant({ cigarId: "00000000-0000-0000-0000-000000000000", wanted: true }),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect((err.cause as DomainError).code).toBe("cigar_not_found");
  });

  it("requires auth to set a want", async () => {
    const anon = caller(h.deps, null);
    const err = await trpcError(anon.cigars.setWant({ cigarId: "x", wanted: true }));
    expect(err.code).toBe("UNAUTHORIZED");
  });

  it("surfaces cigar search guidance shapes (single / brand / no match)", async () => {
    await h.seedCigar({ canonicalName: "Bolivar Belicosos Finos", brand: "Bolivar" });
    await h.seedCigar({ canonicalName: "Montecristo Edmundo", brand: "Montecristo" });
    await h.seedCigar({ canonicalName: "Montecristo No. 2", brand: "Montecristo" });
    const a = caller(h.deps, userA);

    // Exact canonical name → single_match.
    expect((await a.cigars.search({ query: "Bolivar Belicosos Finos" })).guidance).toBe(
      "single_match",
    );

    // A bare brand name → brand_match, returning that brand's cigars.
    const brand = await a.cigars.search({ query: "Montecristo" });
    expect(brand.guidance).toBe("brand_match");
    expect(brand.matches.length).toBeGreaterThanOrEqual(2);
    expect(brand.matches.every((m) => m.brand === "Montecristo")).toBe(true);

    expect((await a.cigars.search({ query: "qqqq no such brand zzzz" })).guidance).toBe("no_match");
  });
});
