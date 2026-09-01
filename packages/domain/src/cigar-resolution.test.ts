import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { cigars } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { saveSmoke } from "./save-smoke.js";
import { addCigar } from "./add-cigar.js";
import { searchCigars } from "./reads.js";
import {
  numbersCompatible,
  packagingCompatible,
  resolveCigar,
  strongLinkCompatible,
  variantCompatible,
  identityTokensCompatible,
} from "./cigar-resolution.js";
import { variantRelation, identityCoverage, rankByIdentity } from "./name-heuristics.js";
import { CigarAmbiguousError, CigarNotFoundError, IdempotencyConflictError } from "./errors.js";
import type { Principal } from "./index.js";

// Pure guard coverage (no DB): the disqualifiers behind the strong-link filter.
describe("strong-link guard predicates", () => {
  it("numbersCompatible: two-sided distinct numbers are incompatible", () => {
    expect(numbersCompatible("1964 Maduro", "1926 Maduro")).toBe(false);
    expect(numbersCompatible("Liga Privada T52", "Liga Privada No. 9")).toBe(false);
  });

  it("numbersCompatible: a one-sided digit extra is incompatible", () => {
    // The reported bug: the naked name has no digit, so the old "both sides must
    // differ" rule wrongly called it compatible.
    expect(numbersCompatible("Davidoff Signature 2000", "Davidoff Signature")).toBe(false);
    expect(numbersCompatible("Davidoff Signature", "Davidoff Signature 2000")).toBe(false);
  });

  it("numbersCompatible: agreeing (or absent) numbers stay compatible", () => {
    expect(numbersCompatible("Padron 1926 Serie No. 1", "Padron 1926 Serie No. 1")).toBe(true);
    expect(numbersCompatible("Cohiba Robusto", "Cohiba Robustos")).toBe(true);
    // Same number on both sides — the packaging guard, not this one, separates a pack.
    expect(numbersCompatible("Davidoff Signature 2000", "Davidoff Signature 2000 Tubos Pack")).toBe(
      true,
    );
  });

  it("packagingCompatible: an extra packaging token is incompatible either direction", () => {
    expect(
      packagingCompatible("Davidoff Signature 2000", "Davidoff Signature 2000 Tubos Pack"),
    ).toBe(false);
    expect(packagingCompatible("Padron 1964 Tin", "Padron 1964")).toBe(false);
    expect(packagingCompatible("Oliva Serie V Sampler", "Oliva Serie V")).toBe(false);
  });

  it("packagingCompatible: no packaging mismatch stays compatible", () => {
    expect(packagingCompatible("Cohiba Robusto", "Cohiba Robustos")).toBe(true);
    // Both carry the same packaging token — a match, not a variant gap.
    expect(packagingCompatible("Padron 1964 Tin", "Padron 1964 Tin")).toBe(true);
  });

  it("strongLinkCompatible: ANDs the number, packaging and identity guards", () => {
    expect(strongLinkCompatible("Davidoff Signature 2000", "Davidoff Signature")).toBe(false);
    expect(
      strongLinkCompatible("Davidoff Signature 2000", "Davidoff Signature 2000 Tubos Pack"),
    ).toBe(false);
    expect(
      strongLinkCompatible("Tatuaje Monster Series The Face", "Tatuaje Monster Series The Bride"),
    ).toBe(false);
    expect(strongLinkCompatible("Padron 1926 Serie No. 1", "Padron 1926 Serie No. 1")).toBe(true);
  });

  // THE WORD-TOKEN GENERALIZATION of the number guard. Everything the digit rule
  // says about `1964` vs `1926` is true of `The Face` vs `The Bride`, and the
  // catalog paid for the gap: see the regression suite at the foot of this file.
  it("identityTokensCompatible: a mutual identity residue is incompatible", () => {
    expect(
      identityTokensCompatible("Tatuaje Monster Series The Face", "Tatuaje Monster Series The Bride"),
    ).toBe(false);
    expect(identityTokensCompatible("Arturo Fuente OpusX", "Arturo Fuente Hemingway")).toBe(false);
    // Siblings of one release differing only in the edition word.
    expect(
      identityTokensCompatible("Tatuaje Monster Smash The Wolfman", "Tatuaje Monster Smash The Mummy"),
    ).toBe(false);
  });

  // THE LOAD-BEARING ASYMMETRY. A one-sided residue is one name saying MORE, not
  // one name saying something else — the blend-level row meeting the vitola-level
  // one. Refusing this link would mint a second row for every casually named
  // cigar, which is the duplicate this whole guard exists to prevent.
  it("identityTokensCompatible: a one-sided residue stays compatible, both directions", () => {
    expect(
      identityTokensCompatible("Drew Estate Liga Privada No. 9 Flying Pig", "Drew Estate Liga Privada No. 9"),
    ).toBe(true);
    expect(
      identityTokensCompatible("Drew Estate Liga Privada No. 9", "Drew Estate Liga Privada No. 9 Flying Pig"),
    ).toBe(true);
    expect(identityTokensCompatible("Oliva Serie V Melanio", "Oliva Serie V Melanio")).toBe(true);
  });

  // Vocabulary is not identity: each of these words is already judged by its own
  // rule, so none of them may create a residue here. The wrapper case is the
  // #192/#208 scope pin restated — `strongLinkCompatible` must not acquire a
  // wrapper guard by the back door.
  it("identityTokensCompatible: sizes, containers and wrappers are not identity", () => {
    expect(identityTokensCompatible("Cohiba Robusto", "Cohiba Double Corona")).toBe(true);
    expect(identityTokensCompatible("Oliva Serie V Sampler", "Oliva Serie V Tin")).toBe(true);
    expect(
      identityTokensCompatible("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary Natural"),
    ).toBe(true);
    expect(identityTokensCompatible("Marca Toro Sun Grown", "Marca Toro Maduro")).toBe(true);
  });

  // One word, two spellings — folded, not treated as two identities.
  it("identityTokensCompatible: folds accents and the trailing plural", () => {
    expect(identityTokensCompatible("Padrón 1964 Aniversario", "Padron 1964 Aniversario")).toBe(true);
    expect(identityTokensCompatible("Oliva Serie V Melanio", "Oliva Series V Melanio")).toBe(true);
  });

  // Ranking, not just admissibility: within a family the residue is the ONLY
  // signal that distinguishes members, so it has to outrank the whole-string
  // score rather than tie-break under it.
  it("identityCoverage: ranks the named sibling above a higher-scoring cousin", () => {
    const query = "Tatuaje Monster Smash The Creature";
    expect(identityCoverage(query, "Tatuaje Monster Smash The Creature")).toBe(1);
    expect(identityCoverage(query, "Tatuaje Monster Smash The Bride")).toBeLessThan(1);

    const ranked = rankByIdentity(
      query,
      [
        { name: "Tatuaje Monster Smash The Bride", sim: 0.95 },
        { name: "Tatuaje Monster Smash The Creature", sim: 0.5 },
      ],
      (row) => row,
    );
    expect(ranked[0]!.name).toBe("Tatuaje Monster Smash The Creature");
  });

  // THE MEASURE IS ASYMMETRIC FOR THIS CASE. A query naming only a brand states
  // nothing that could rank one catalog row above another, so every candidate
  // carrying the brand must TIE and the trigram order must survive intact. A
  // symmetric measure (Jaccard) fails exactly here: dividing by the union scores
  // each candidate `1/k` in its own token count and reorders the page by
  // shortest name — a length preference wearing the identity rule's clothes.
  it("identityCoverage: a brand-only query ties, leaving the trigram order intact", () => {
    const query = "Tatuaje";
    expect(identityCoverage(query, "Tatuaje Monster Smash The Bride")).toBe(1);
    expect(identityCoverage(query, "Tatuaje Havana VI Verocu No. 2")).toBe(1);

    const rows = [
      { name: "Tatuaje Havana VI Verocu No. 2", sim: 0.42 },
      { name: "Tatuaje Monster Smash The Bride", sim: 0.31 },
      { name: "Tatuaje Brown Label Robusto", sim: 0.28 },
    ];
    expect(rankByIdentity(query, rows, (row) => row).map((r) => r.name)).toEqual(
      rows.map((r) => r.name),
    );
  });

  // TWO GUARDS, NOT THREE. Matching v2 added a wrapper-variant guard and it
  // belongs to the MATCHER, over vendor listings, where a refusal costs a triage
  // row. `strongLinkCompatible` is the JOURNAL's guard, over words a user typed,
  // where a refusal costs a duplicate catalog entry — so the wrapper rule stays
  // out of it and the #192/#208 definition stands.
  it("strongLinkCompatible: the wrapper-variant guard is not one of them", () => {
    expect(strongLinkCompatible("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary")).toBe(true);
    expect(variantCompatible("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary")).toBe(true);
    // The matcher's own three-valued view of the same pair, which is what makes
    // the question answerable there without changing the answer here.
    expect(variantRelation("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary")).toBe("unstated");
    expect(variantRelation("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary Natural")).toBe("different");
  });

  // One wrapper, three vendor spellings, one claim.
  it("variantRelation: normalizes a two-word wrapper onto its single-token key", () => {
    expect(variantRelation("Marca Toro Sun Grown", "Marca Toro sungrown")).toBe("same");
    expect(variantRelation("Marca Toro sun-grown", "Marca Toro Sun Grown")).toBe("same");
    expect(variantRelation("Marca Toro Sun Grown", "Marca Toro Maduro")).toBe("different");
  });
});

// Regression suite for the strong-match number-token guard (cigar-resolution).
// pg_trgm similarity is blind to product numbers, so number-distinct names score
// above the strong-link threshold on shared letters alone. Production linked
// "1964 Maduro" reviews onto "Padron 1926 Maduro" and "Liga Privada T52" onto
// "...No. 9" this way (data since hand-fixed). Each case below is trigram-strong
// (asserted) yet must NOT strong-link — a new unverified cigar is created instead.
describe("resolveCigar number-token guard", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("resolve@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function similarity(a: string, b: string): Promise<number> {
    const r = await h.deps.db.execute(sql`SELECT similarity(${a}, ${b}) AS s`);
    return Number((r.rows[0] as { s: number | string }).s);
  }

  // Seeds `existing`, saves a described smoke named `query`, and asserts the save
  // created a fresh cigar rather than linking to `existing` — after first proving
  // the pair is trigram-strong (so the guard, not a weak score, is what prevents
  // the link).
  async function expectNoStrongLink(existing: string, query: string): Promise<void> {
    expect(await similarity(query, existing)).toBeGreaterThanOrEqual(0.6);
    const existingId = await h.seedCigar({ canonicalName: existing });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: query } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.smoke.cigar.cigarId).not.toBe(existingId);
    expect(result.smoke.cigar.canonicalName).toBe(query);
    expect(result.cigarCreated).toBe(true);
  }

  it("does not link 1964 Maduro onto 1926 Maduro", async () => {
    await expectNoStrongLink("1926 Maduro", "1964 Maduro");
  });

  it("does not link 1964 Natural onto 1926 Natural", async () => {
    await expectNoStrongLink("1926 Natural", "1964 Natural");
  });

  it("does not link Liga Privada T52 onto Liga Privada No. 9", async () => {
    await expectNoStrongLink("Drew Estate Liga Privada No. 9", "Drew Estate Liga Privada T52");
  });

  it("still strong-links when the model numbers agree", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Padron 1926 Serie No. 1" });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Padron 1926 Serie No. 1" } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.smoke.cigar.cigarId).toBe(existingId);
    expect(result.cigarCreated).toBe(false);
  });

  it("does not link Davidoff Signature 2000 onto the naked Davidoff Signature (one-sided digit)", async () => {
    await expectNoStrongLink("Davidoff Signature", "Davidoff Signature 2000");
  });

  it("does not link a naked stick onto its Tubos Pack (packaging variant)", async () => {
    // Tubos-only case: the packaging variant is the sole seeded row, yet the
    // naked-stick save must still create rather than silently link to a pack.
    // A distinct product name (the one-sided test above already created a
    // "…Signature 2000" row in this shared DB — reusing it would exact-link).
    await expectNoStrongLink("Montecristo Epic 2010 Tubos Pack", "Montecristo Epic 2010");
  });

  // THE SCOPE PIN FOR THE WRAPPER GUARD. Wave 2 briefly folded `variantCompatible`
  // into `strongLinkCompatible`, which silently re-decided this call: a user
  // saying "Padrón 1964 Anniversary Maduro" over a catalog row named without the
  // wrapper would have stopped linking and MINTED A SECOND ROW for the cigar they
  // have already smoked. That is the duplicate this whole wave exists to prevent,
  // arriving through the journal instead of the crawler. The guard is a matcher
  // rule; this path keeps the #192/#208 behaviour it had on main.
  it("still strong-links a described wrapper variant onto a row that names none", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Herrera Esteli Norteno Robusto" });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Herrera Esteli Norteno Robusto Maduro" } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.smoke.cigar.cigarId).toBe(existingId);
    expect(result.cigarCreated).toBe(false);
  });

  // #206, sharing this file's single embedded Postgres. resolveCigar is the front
  // door for save_smoke, record_purchase and add_cigar, so the equality pinned
  // here — malformed is INDISTINGUISHABLE from unknown-but-valid — is the answer
  // all three inherit.
  it("resolveCigar answers a malformed id exactly as it answers an unknown one", async () => {
    const malformed = await h.deps.db
      .transaction((tx) => resolveCigar(tx, { cigarId: "not-a-uuid" }))
      .catch((e: unknown) => e);
    const unknown = await h.deps.db
      .transaction((tx) => resolveCigar(tx, { cigarId: newRequestId() }))
      .catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(CigarNotFoundError);
    expect(unknown).toBeInstanceOf(CigarNotFoundError);
    expect((malformed as CigarNotFoundError).toPayload()).toEqual(
      (unknown as CigarNotFoundError).toPayload(),
    );
  });

  // The guard keys on the ref's SHAPE, not on any string it carries: a described
  // ref names a cigar rather than identifying one, reaches no uuid column, and
  // must still link or create exactly as before — including when the name itself
  // is a string no uuid column would accept.
  it("resolveCigar leaves the described path untouched by the id guard", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Guarded Path Reserva Robusto" });
    const linked = await h.deps.db.transaction((tx) =>
      resolveCigar(tx, { described: { canonicalName: "Guarded Path Reserva Robusto" } }),
    );
    expect(linked.cigarId).toBe(existingId);
    expect(linked.created).toBe(false);

    const created = await h.deps.db.transaction((tx) =>
      resolveCigar(tx, { described: { canonicalName: "not-a-uuid" } }),
    );
    expect(created.created).toBe(true);
    expect(created.canonicalName).toBe("not-a-uuid");
  });

  // THE ONE-SIDED RESIDUE, END TO END. The blend-level row is what most of this
  // catalog holds, and a user naming the vitola-level product must still land on
  // it rather than minting a near-twin. This is the case the identity guard is
  // deliberately silent about, and the reason it reads a MUTUAL residue only.
  it("still strong-links a vitola-level name onto its blend-level row", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Warped Flor de Valle" });
    expect(await similarity("Warped Flor de Valle Sky Flower", "Warped Flor de Valle")).toBeGreaterThanOrEqual(0.6);
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Warped Flor de Valle Sky Flower" } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.smoke.cigar.cigarId).toBe(existingId);
    expect(result.cigarCreated).toBe(false);
  });
});

// THE REGRESSION PIN (production, 2026-08-30). A real ChatGPT session called
// add_cigar for "Tatuaje Monster Series The Face" and got `created: false`
// against the live row for "Tatuaje Monster Series The Bride" — two different
// cigars sharing one id, silently, with no error for the model to react to.
// Every guard the resolver had was blind to it: the names carry no digit, no
// packaging word and no wrapper word, and they score far above the strong-link
// floor on the twenty-seven characters they share.
describe("resolveCigar identity-token guard — Face is not Bride (regression)", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("face-bride@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("errors cigar_ambiguous instead of silently linking The Face to The Bride", async () => {
    const brideId = await h.seedCigar({
      canonicalName: "Tatuaje Monster Series The Bride",
      brand: "Tatuaje",
      line: "Monster Series",
    });
    // The pair really is trigram-strong — the guard, not a weak score, is what
    // stops the link. This is the assertion that made the bug possible.
    const r = await h.deps.db.execute(
      sql`SELECT similarity('Tatuaje Monster Series The Face', 'Tatuaje Monster Series The Bride') AS s`,
    );
    expect(Number((r.rows[0] as { s: number | string }).s)).toBeGreaterThanOrEqual(0.6);

    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: {
        canonicalName: "Tatuaje Monster Series The Face",
        brand: "Tatuaje",
        line: "Monster Series",
        edition: "The Face",
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CigarAmbiguousError);
    const ambiguous = error as CigarAmbiguousError;
    expect(ambiguous.toPayload().code).toBe("cigar_ambiguous");
    expect(ambiguous.candidates.map((c) => c.cigarId)).toContain(brideId);

    // Neither linked NOR created: the transaction rolled back, so The Face is
    // still absent and The Bride still means only The Bride.
    const faces = await h.deps.db
      .select({ id: cigars.id })
      .from(cigars)
      .where(eq(cigars.canonicalName, "Tatuaje Monster Series The Face"));
    expect(faces).toHaveLength(0);
  });
});

// A FAMILY, NOT A PAIR. Tatuaje's Monster series is fourteen live siblings whose
// names differ in one word out of six — the shape that defeats both halves of
// the old behaviour at once: the guard could not tell them apart, and the
// trigram ranking could not put the right one in front of the user.
describe("resolveCigar and search_cigars over a sibling family", () => {
  let h: DomainHarness;
  let user: Principal;
  const SIBLINGS = [
    "The Frank",
    "The Drac",
    "The Face",
    "The Wolfman",
    "The Mummy",
    "The Jason JV13",
    "The Jekyll",
    "The Hyde",
    "The Krueger",
    "The Michael",
    "The Chuck",
    "The Tiff",
    "The Bride",
    "The Creature",
  ].map((edition) => `Tatuaje Monster Smash ${edition}`);
  const seeded = new Map<string, string>();

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("monster-smash@example.com");
    for (const name of SIBLINGS) {
      seeded.set(name, await h.seedCigar({ canonicalName: name, brand: "Tatuaje", line: "Monster Smash" }));
    }
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("links an existing sibling by its exact name", async () => {
    const result = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Tatuaje Monster Smash The Creature", brand: "Tatuaje" },
    });
    expect(result.created).toBe(false);
    expect(result.cigar.cigarId).toBe(seeded.get("Tatuaje Monster Smash The Creature"));
  });

  // The two halves of the real conversation, in order: the model asks, the user
  // answers, the model re-issues. The first call must NOT create — the whole
  // point is that a name one word off a family of fourteen is a question.
  it("asks (cigar_ambiguous) for an unseen sibling, offering its family as candidates", async () => {
    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Tatuaje Monster Smash The Ghoul", brand: "Tatuaje" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CigarAmbiguousError);
    const candidates = (error as CigarAmbiguousError).candidates;
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(SIBLINGS).toContain(candidate.canonicalName);
    }
    const ghouls = await h.deps.db
      .select({ id: cigars.id })
      .from(cigars)
      .where(eq(cigars.canonicalName, "Tatuaje Monster Smash The Ghoul"));
    expect(ghouls).toHaveLength(0);
  });

  it("creates that sibling once the user confirms it is none of them", async () => {
    const result = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Tatuaje Monster Smash The Ghoul", brand: "Tatuaje" },
      confirmedDistinct: true,
    });
    expect(result.created).toBe(true);
    expect(result.cigar.canonicalName).toBe("Tatuaje Monster Smash The Ghoul");
  });

  // SAVE_SMOKE REACHES THE SAME BRANCH WITH NO ESCAPE HATCH OF ITS OWN — it
  // never sets `confirmedDistinct` — so mid-journal the model has to settle the
  // question and save again. The plain recovery is safe: the ambiguity threw
  // inside the transaction, so nothing was written and the clientRequestId was
  // never spent.
  it("asks when save_smoke names an unseen sibling, then re-saves under the same clientRequestId", async () => {
    const requestId = newRequestId();
    const error = await saveSmoke(h.deps, user, {
      clientRequestId: requestId,
      cigar: { described: { canonicalName: "Tatuaje Monster Smash The Banshee" } },
      overallDescriptors: ["cocoa"],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CigarAmbiguousError);
    const candidates = (error as CigarAmbiguousError).candidates;
    expect(candidates.length).toBeGreaterThan(0);
    // Every candidate is a member of this family — including The Ghoul, minted
    // by the confirmed-distinct case above and a true sibling from then on.
    for (const candidate of candidates) {
      expect(candidate.canonicalName.startsWith("Tatuaje Monster Smash ")).toBe(true);
    }

    const brideId = seeded.get("Tatuaje Monster Smash The Bride")!;
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: requestId,
      cigar: { cigarId: brideId },
      overallDescriptors: ["cocoa"],
    });
    expect(saved.smoke.cigar.cigarId).toBe(brideId);
    expect(saved.cigarCreated).toBe(false);
  });

  // THE TRAP IN THE OTHER RECOVERY. Idempotency keys are unique per (user,
  // clientRequestId) and NOT per tool, so routing the answer through add_cigar
  // SPENDS the id the save was going to reuse. The follow-up save then arrives
  // with a different payload under a spent key: `idempotency_conflict`, and it
  // is `recoverable: false` — the journal entry is stranded unless the model
  // knows to issue the save under a fresh id. This is what the tool text now
  // states, pinned here so the text cannot drift from the mechanic.
  it("strands the save under a spent clientRequestId when the recovery detours through add_cigar", async () => {
    const requestId = newRequestId();
    const ambiguous = await saveSmoke(h.deps, user, {
      clientRequestId: requestId,
      cigar: { described: { canonicalName: "Tatuaje Monster Smash The Banshee" } },
      overallDescriptors: ["cedar"],
    }).catch((e: unknown) => e);
    expect(ambiguous).toBeInstanceOf(CigarAmbiguousError);

    // The user confirms none of the siblings is theirs.
    const added = await addCigar(h.deps, user, {
      clientRequestId: requestId,
      cigar: { canonicalName: "Tatuaje Monster Smash The Banshee", brand: "Tatuaje" },
      confirmedDistinct: true,
    });
    expect(added.created).toBe(true);

    const conflict = await saveSmoke(h.deps, user, {
      clientRequestId: requestId,
      cigar: { cigarId: added.cigar.cigarId },
      overallDescriptors: ["cedar"],
    }).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(IdempotencyConflictError);
    expect((conflict as IdempotencyConflictError).recoverable).toBe(false);

    // A fresh id finishes the entry the user was in the middle of writing.
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId: added.cigar.cigarId },
      overallDescriptors: ["cedar"],
    });
    expect(saved.smoke.cigar.cigarId).toBe(added.cigar.cigarId);
  });

  // RANKING, the second defect. Fourteen siblings score alike on trigram, so the
  // page of five the search returned was five arbitrary members of the family —
  // the one the user named as likely missing as present. Identity-first ordering
  // puts it first, and `single_match` becomes reachable again.
  it("search_cigars ranks the named sibling first out of fourteen", async () => {
    const exact = await searchCigars(h.deps, user, {
      query: "Tatuaje Monster Smash The Creature",
      limit: 5,
    });
    expect(exact.matches[0]!.canonicalName).toBe("Tatuaje Monster Smash The Creature");
    expect(exact.guidance).toBe("single_match");

    // Same demand without the exact spelling: the residue still identifies the
    // sibling, and the verdict stays the honest `multiple_matches`.
    const partial = await searchCigars(h.deps, user, {
      query: "Tatuaje Monster Smash Creature",
      limit: 5,
    });
    expect(partial.matches[0]!.canonicalName).toBe("Tatuaje Monster Smash The Creature");
    expect(partial.guidance).toBe("multiple_matches");
  });
});
