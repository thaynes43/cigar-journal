import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { auditLog, brands, lines, blends, cigars } from "@cj/db";
import { brandSlug } from "./catalog-browse.js";
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
import {
  variantRelation,
  identityCoverage,
  identityResidues,
  journalLinkCompatible,
  rankByIdentity,
  CANDIDATE_POOL,
} from "./name-heuristics.js";
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

  // THE ASYMMETRY, AND WHERE IT STILL LIVES. A one-sided residue is one name
  // saying MORE, not one name saying something else — the blend-level row meeting
  // the vitola-level one. This predicate still admits it, because the crawler's
  // leaf binding, the curation duplicate queue and the candidate RANKING all read
  // "does this contradict the name", and a name that merely says more does not.
  // The JOURNAL's link-vs-create verdict no longer rests on it (2026-09-01,
  // `journalLinkCompatible` below): there, saying more is a question, not a link.
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

  // THE SPELLING-VARIANT TABLE (#237). Accents and plurals were the only two
  // spellings the rule folded; the trade writes far more than two. Each pair
  // below is one word written two ways in the live catalog or in live vendor
  // listing titles, and each one read as two different identity claims before
  // the table existed.
  it("identityTokensCompatible: one wrapper, more than one spelling", () => {
    expect(identityTokensCompatible("Camacho Ecuador Robusto", "Camacho Ecuadorian Robusto")).toBe(true);
    expect(identityTokensCompatible("Sobremesa San Andres Maduro", "Sobremesa Mexican Maduro")).toBe(true);
    expect(
      identityTokensCompatible("Cavalier Prospektor Barber Pole", "Cavalier Prospektor Barberpole"),
    ).toBe(true);
    // `sun grown` was pair-joined and `shade grown` was not, so the orphaned
    // `grown` read as identity against the one-word spelling.
    expect(
      identityTokensCompatible("HC Series White Shade Grown Toro", "HC Series White Shadegrown Toro"),
    ).toBe(true);
  });

  it("identityTokensCompatible: one release word, more than one spelling", () => {
    expect(
      identityTokensCompatible("Padron 1964 Anniversary Exclusivo", "Padron 1964 Aniversario Exclusivo"),
    ).toBe(true);
    expect(
      identityTokensCompatible("Drew Estate Liga Privada Anniversario 10", "Drew Estate Liga Privada Aniversario 10"),
    ).toBe(true);
    expect(
      identityTokensCompatible("Aganorsa Leaf Aniversario 25 Edicion Limitada", "Aganorsa Leaf Aniversario 25 Edition Limitada"),
    ).toBe(true);
    expect(
      identityTokensCompatible("Davidoff Aniversario Special R", "Davidoff Aniversario Especial R"),
    ).toBe(true);
    expect(identityTokensCompatible("Rocky Patel Nicaragua Toro", "Rocky Patel Nicaraguan Toro")).toBe(true);
    // Both canonical keys are already vitola vocabulary, so the misspelling and
    // the Spanish spelling become vocabulary with them.
    expect(identityTokensCompatible("Henry Clay Rothchilde", "Henry Clay Rothschild")).toBe(true);
    expect(identityTokensCompatible("Blackened S84 Corona Doble", "Blackened S84 Double Corona")).toBe(true);
  });

  // EQUIVALENCE IS A TABLE, NOT A DISTANCE, and this is why: over the live
  // catalog's own tokens, edit distance 1 pairs `Face` with `Farce` and `Fuente`
  // with `Fuerte`. A rule that equated near spellings would re-create the exact
  // defect the identity guard was written for.
  it("identityTokensCompatible: a near spelling is not an equivalence", () => {
    expect(identityTokensCompatible("Tatuaje Monster Series The Face", "Tatuaje Monster Series The Farce")).toBe(false);
    expect(identityTokensCompatible("Arturo Fuente Robusto", "Arturo Fuerte Robusto")).toBe(false);
    // And a real wrapper claim is still a claim: unifying the spellings of
    // `Ecuador` does not make Ecuador the same thing as Corojo.
    expect(identityTokensCompatible("Camacho Ecuador Robusto", "Camacho Corojo Robusto")).toBe(true);
    expect(identityResidues("Camacho Ecuador Robusto", "Camacho Corojo Robusto").query).toEqual(
      new Set(["ecuador"]),
    );
  });

  // THE STEMMING FLOOR, RE-MEASURED (#237). The floor was on the TOKEN, and the
  // #235 verify pass proved it fired on identity words anyway: `opus` is four
  // characters, so the rule that promised never to truncate a short word
  // truncated it to `opu`. Measuring the STEM refuses that and keeps every
  // plural the catalog actually carries.
  it("identityResidues: the singular fold is measured on the stem, never on a doubled s", () => {
    expect(identityResidues("Arturo Fuente Opus", "Arturo Fuente").query).toEqual(new Set(["opus"]));
    // English has no plural ending in a doubled s — `press` is a live listing
    // word and `dress box` is trade vocabulary, neither a plural of anything.
    expect(identityResidues("Marca Dress Box Robusto", "Marca Robusto").query).toEqual(
      new Set(["dress"]),
    );
    // Still folds the plurals it was written for.
    expect(identityResidues("Oliva Series", "Oliva").query).toEqual(new Set(["serie"]));
    expect(identityTokensCompatible("Tatuaje Monsters Smash", "Tatuaje Monster Smash")).toBe(true);
    // What remains true, stated rather than denied: a six-letter word still
    // folds, so `andres` folds to `andre`. Nothing in the live catalog collides
    // with that stem, and the one place it mattered — the San Andrés wrapper —
    // is joined by the spelling table before this rule sees the word.
    expect(identityResidues("Marca Andres", "Marca").query).toEqual(new Set(["andre"]));
    expect(identityResidues("Marca San Andres", "Marca Mexican").query).toEqual(new Set());
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

  // THE DEMOTION COVERAGE CAUSED (#237). Coverage is the share of the QUERY a
  // candidate accounts for and is blind to the candidate's own extra words, so a
  // longer, more specific catalog name that happens to contain every word of the
  // query scored a perfect 1 — and, as an absolute primary key, outranked a
  // near-exact match that dropped a single word. The user asking for the Torpedo
  // was offered the Diplomatico.
  it("rankByIdentity: a far better trigram match is not demoted by a marginal identity gain", () => {
    const query = "Padron 1964 Anniversary Series Torpedo";
    // Full coverage on the query, and a different vitola.
    expect(identityCoverage(query, "Padron 1964 Anniversary Series Diplomatico")).toBe(1);
    // One word short of full — and the cigar the query names.
    expect(identityCoverage(query, "Padron 1964 Anniversary Torpedo")).toBeLessThan(1);

    const ranked = rankByIdentity(
      query,
      [
        { name: "Padron 1964 Anniversary Series Diplomatico", sim: 0.62 },
        { name: "Padron 1964 Anniversary Torpedo", sim: 0.93 },
      ],
      (row) => row,
    );
    expect(ranked[0]!.name).toBe("Padron 1964 Anniversary Torpedo");
  });

  // WHAT STAYS ABSOLUTE. Banding coverage is safe only because the guard's own
  // verdict is now the first key: a candidate that CONTRADICTS the name — a
  // mutual residue, `Bride` where the query said `Creature` — sorts below every
  // candidate that merely says more or less, whatever its trigram score. That is
  // the fourteen-sibling case, and no band or blend may override it.
  it("rankByIdentity: a contradicting name never outranks a compatible one", () => {
    const query = "Tatuaje Monster Smash The Creature";
    const ranked = rankByIdentity(
      query,
      [
        { name: "Tatuaje Monster Smash The Bride", sim: 0.99 },
        { name: "Tatuaje Monster Smash The Creature Especial Reserva", sim: 0.4 },
      ],
      (row) => row,
    );
    expect(ranked[0]!.name).toBe("Tatuaje Monster Smash The Creature Especial Reserva");
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

  // THE JOURNAL'S OWN VERDICT (production, 2026-09-01). `strongLinkCompatible`
  // refuses a MUTUAL residue only, and that allowance is what linked `Atabey
  // Black Ritos` onto the catalog's `Atabey Ritos` — a different blend — since
  // `ritos` folds to `rito` on both sides and `{black}` sat on the query side
  // alone. `journalLinkCompatible` links only a candidate making the SAME
  // identity claims; everything else goes to the ask branch.
  it("journalLinkCompatible: a residue on either side alone is not a link", () => {
    expect(strongLinkCompatible("Atabey Black Ritos", "Atabey Ritos")).toBe(true);
    expect(journalLinkCompatible("Atabey Black Ritos", "Atabey Ritos")).toBe(false);
    expect(journalLinkCompatible("Atabey Ritos", "Atabey Black Ritos")).toBe(false);
    // The vitola-level name meeting its blend-level row: a question now, because
    // the ask branch exists and a silent link costs data the question does not.
    expect(
      journalLinkCompatible("Drew Estate Liga Privada No. 9 Flying Pig", "Drew Estate Liga Privada No. 9"),
    ).toBe(false);
  });

  // The wrapper axis, three-valued as `variantRelation` reads it: a STATED
  // disagreement is refused, silence is not a claim and still links.
  it("journalLinkCompatible: a stated wrapper disagreement is not a link", () => {
    expect(
      journalLinkCompatible("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary Natural"),
    ).toBe(false);
    expect(journalLinkCompatible("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary")).toBe(
      true,
    );
    expect(
      journalLinkCompatible("Herrera Esteli Norteno Robusto Maduro", "Herrera Esteli Norteno Robusto"),
    ).toBe(true);
  });

  // VOCABULARY IS STILL NOT IDENTITY, which is what keeps the stricter rule from
  // minting a duplicate for every user who says a size or a wrapper out loud:
  // sizes, containers and wrappers are struck before either residue is built, and
  // one word spelled two ways is one word.
  it("journalLinkCompatible: sizes, plurals and spelling variants still link", () => {
    expect(journalLinkCompatible("Cohiba Robusto", "Cohiba Robustos")).toBe(true);
    expect(journalLinkCompatible("Cohiba", "Cohiba Robusto")).toBe(true);
    expect(journalLinkCompatible("Padrón 1964 Aniversario", "Padron 1964 Anniversary")).toBe(true);
    expect(journalLinkCompatible("Camacho Ecuador Robusto", "Camacho Ecuadorian Robusto")).toBe(true);
    expect(journalLinkCompatible("Padron 1926 Serie No. 1", "Padron 1926 Serie No. 1")).toBe(true);
    // The structured claims of difference it inherits unchanged — these create
    // rather than ask, and the resolver keeps them out of the ask branch.
    expect(journalLinkCompatible("Davidoff Signature 2000", "Davidoff Signature")).toBe(false);
    expect(
      journalLinkCompatible("Davidoff Signature 2000", "Davidoff Signature 2000 Tubos Pack"),
    ).toBe(false);
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

  // THE ONE-SIDED RESIDUE, END TO END — AND THE DECISION FLIPPED ON 2026-09-01.
  // This case used to LINK: the blend-level row is what most of this catalog
  // holds, and a name reaching one vitola further was read as saying more rather
  // than saying something else. That reading is what let `Atabey Black Ritos`
  // land on `Atabey Ritos` in production, and the calculus had changed under it:
  // when the allowance was written the only alternative to linking was minting a
  // near-twin row, but the ask branch (#235) now exists, so the choice is between
  // a round trip and a silent link that contaminates smoke history, ratings,
  // inventory, prices and enrichment. `Sky Flower` is a claim about which cigar
  // this is, and only the user knows whether the blend-level row is meant.
  it("asks instead of linking a vitola-level name onto its blend-level row", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Warped Flor de Valle" });
    expect(await similarity("Warped Flor de Valle Sky Flower", "Warped Flor de Valle")).toBeGreaterThanOrEqual(0.6);
    const error = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Warped Flor de Valle Sky Flower" } },
      overallDescriptors: ["cocoa"],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CigarAmbiguousError);
    expect((error as CigarAmbiguousError).candidates.map((c) => c.cigarId)).toContain(existingId);
    const created = await h.deps.db
      .select({ id: cigars.id })
      .from(cigars)
      .where(eq(cigars.canonicalName, "Warped Flor de Valle Sky Flower"));
    expect(created).toHaveLength(0);
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

// ONE POOL FOR BOTH READERS (#237). `searchCigars` drew fifty trigram candidates
// and ranked them; `resolveCigar` drew TEN and decided link-vs-create over those.
// Ranking cannot recover a row the pool never held, so on a family larger than
// ten the resolver was deciding on an arbitrary slice of it — and the slice is
// arbitrary in exactly the way ADR-012 warns about, since siblings that differ in
// one word out of six score alike.
//
// The family below is built so the row the query names is TWELFTH on trigram: it
// is the only candidate that does not CONTRADICT the name, and every sibling
// above it does. Under `LIMIT 10` the resolver never saw it at all; with the
// shared pool it is in the candidate list, and ranked first.
//
// Since 2026-09-01 that row is offered rather than linked — it says more than the
// query (`Especial Reserva Toro`), and a name that reaches past the row is the
// Atabey Black Ritos shape. The pool width is still exactly what this proves: a
// resolver that cannot see the row cannot offer it either, and the user would be
// asked to choose between twelve siblings none of which is theirs.
describe("resolveCigar draws the same candidate pool searchCigars does", () => {
  let h: DomainHarness;
  let user: Principal;
  // Twelve contradicting siblings — every one of them a `The <word>` release
  // that is not the one being named.
  const CONTRADICTING = [
    "The Chuck",
    "The Tiff",
    "The Hyde",
    "The Mummy",
    "The Drac",
    "The Ghoul",
    "The Bride",
    "The Frank",
    "The Krueger",
    "The Michael",
    "The Jekyll",
    "The Wolfman",
  ].map((edition) => `Tatuaje Monster Smash ${edition}`);
  // The row the query names, spelled longer — a ONE-SIDED residue, which the
  // guard admits, at a trigram score below every sibling above.
  const NAMED = "Tatuaje Monster Smash The Creature Especial Reserva Toro";
  const QUERY = "Tatuaje Monster Smash The Creature";
  let namedId: string;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("candidate-pool@example.com");
    for (const name of CONTRADICTING) {
      await h.seedCigar({ canonicalName: name, brand: "Tatuaje", line: "Monster Smash" });
    }
    namedId = await h.seedCigar({ canonicalName: NAMED, brand: "Tatuaje", line: "Monster Smash" });
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // The premise, asserted rather than assumed: if pg_trgm ever reorders this
  // family the test below stops meaning what it says, and this is where that
  // shows up.
  it("puts the named row outside the first ten of the trigram order", async () => {
    const ranked = await h.deps.db.execute(sql`
      SELECT canonical_name, similarity(canonical_name, ${QUERY}) AS sim
      FROM cigars
      WHERE canonical_name % ${QUERY}
      ORDER BY sim DESC
    `);
    const names = (ranked.rows as unknown as { canonical_name: string; sim: number }[]).map(
      (row) => row.canonical_name,
    );
    expect(names.indexOf(NAMED)).toBeGreaterThanOrEqual(10);
    expect(names.length).toBeLessThanOrEqual(CANDIDATE_POOL);
  });

  it("offers the named row first — the row the old ten-row pool could not see", async () => {
    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: QUERY, brand: "Tatuaje" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CigarAmbiguousError);
    const candidates = (error as CigarAmbiguousError).candidates;
    // Twelfth on trigram, first in the list: the only candidate that does not
    // contradict the name, which is what `rankByIdentity` sorts on before all else.
    expect(candidates[0]!.cigarId).toBe(namedId);
  });

  // The pool is a DECISION width, not a page width. A user cannot be read fifty
  // candidates, so the ambiguity list stays the size `search_cigars` caps its own
  // page at.
  it("still offers a readable list when nothing in the pool is admissible", async () => {
    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Tatuaje Monster Smash The Banshee", brand: "Tatuaje" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CigarAmbiguousError);
    const candidates = (error as CigarAmbiguousError).candidates;
    expect(candidates.length).toBe(10);
    expect(candidates.length).toBeLessThan(CANDIDATE_POOL);
  });
});

// THE REGRESSION PIN (production, 2026-09-01). The catalog held `Atabey Ritos`.
// A ChatGPT session called `add_cigar` for `Atabey Black Ritos` — Atabey Black is
// a different blend — and got `created: false, guidance: already_existed`
// pointing at the Ritos row. `ritos` folds to `rito` on both sides, so the whole
// disagreement was the residue `{black}` on the QUERY side alone, which the
// mutual-residue rule called compatible. Retrying with `confirmedDistinct` made
// the right row, which is the round trip the resolver now asks for by itself.
//
// The link was the expensive outcome, not the question: smoke history, ratings,
// inventory, prices and enrichment all attach to the id, so one silent link
// contaminates every one of them with no error for anyone to react to.
describe("resolveCigar journal-link guard — Black Ritos is not Ritos (regression)", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("atabey-black@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function similarity(a: string, b: string): Promise<number> {
    const r = await h.deps.db.execute(sql`SELECT similarity(${a}, ${b}) AS s`);
    return Number((r.rows[0] as { s: number | string }).s);
  }

  async function cigarCount(): Promise<number> {
    return (await h.deps.db.select({ id: cigars.id }).from(cigars)).length;
  }

  it("asks instead of linking Atabey Black Ritos onto Atabey Ritos, then creates on confirmation", async () => {
    const ritosId = await h.seedCigar({ canonicalName: "Atabey Ritos", brand: "Atabey" });
    // The pair really is trigram-strong — the guard, not a weak score, is what
    // decides. This is the assertion that made the production bug possible.
    expect(await similarity("Atabey Black Ritos", "Atabey Ritos")).toBeGreaterThanOrEqual(0.6);
    const before = await cigarCount();

    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Atabey Black Ritos", brand: "Atabey" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CigarAmbiguousError);
    const ambiguous = error as CigarAmbiguousError;
    expect(ambiguous.toPayload().code).toBe("cigar_ambiguous");
    expect(ambiguous.candidates.map((c) => c.cigarId)).toContain(ritosId);
    // Neither linked NOR created: the transaction rolled back.
    expect(await cigarCount()).toBe(before);

    // The user confirms the Black is not the Ritos, and the same call goes
    // through — the round trip the session had to take by hand in production.
    const created = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Atabey Black Ritos", brand: "Atabey" },
      confirmedDistinct: true,
    });
    expect(created.created).toBe(true);
    expect(created.cigar.canonicalName).toBe("Atabey Black Ritos");
    expect(created.cigar.cigarId).not.toBe(ritosId);
  });

  // THE OTHER DIRECTION, which the old rule got wrong just as silently: the
  // catalog holds only the Black and the user names the plain one, leaving the
  // residue on the CANDIDATE side. Seeded on a sibling vitola so both directions
  // live in one database — by now this one holds both Ritos rows, and an exact
  // name would simply link.
  it("asks when the residue is on the catalog row instead of the name", async () => {
    const blackId = await h.seedCigar({ canonicalName: "Atabey Black Divinos", brand: "Atabey" });
    expect(await similarity("Atabey Divinos", "Atabey Black Divinos")).toBeGreaterThanOrEqual(0.6);
    const before = await cigarCount();

    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Atabey Divinos", brand: "Atabey" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CigarAmbiguousError);
    expect((error as CigarAmbiguousError).candidates.map((c) => c.cigarId)).toContain(blackId);
    expect(await cigarCount()).toBe(before);
  });

  // THE WRAPPER AXIS. ADR-012 is explicit that wrapper variants a brand sells as
  // separate products are distinct blends, and the catalog holds exactly one of
  // the pair — so a described Maduro against a lone Natural row is neither a link
  // (they are different products) nor a create (the row may be the collapse
  // bucket that already holds both). `variantRelation` calls the pair
  // `different`; `strongLinkCompatible` deliberately ignores that and the journal
  // no longer does.
  it("asks on a stated wrapper disagreement rather than linking or creating", async () => {
    const naturalId = await h.seedCigar({
      canonicalName: "Padron 1964 Anniversary Natural",
      brand: "Padron",
    });
    expect(
      await similarity("Padron 1964 Anniversary Maduro", "Padron 1964 Anniversary Natural"),
    ).toBeGreaterThanOrEqual(0.6);
    const before = await cigarCount();

    const error = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Padron 1964 Anniversary Maduro", brand: "Padron" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CigarAmbiguousError);
    expect((error as CigarAmbiguousError).candidates.map((c) => c.cigarId)).toContain(naturalId);
    expect(await cigarCount()).toBe(before);
  });

  // WHAT STILL LINKS, in the same database and by the same rule: vocabulary is
  // not identity. A wrapper the row does not state is silence, not a
  // disagreement, and a size word is not the product's name.
  it("still links a stated wrapper onto a row that states none", async () => {
    const existingId = await h.seedCigar({ canonicalName: "Herrera Esteli Norteno Robusto" });
    const result = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Herrera Esteli Norteno Robusto Maduro" } },
      overallDescriptors: ["cocoa"],
    });
    expect(result.smoke.cigar.cigarId).toBe(existingId);
    expect(result.cigarCreated).toBe(false);
  });
});

// ==========================================================================
// FAMILY ROWS AND VITOLA SPECIALIZATION (ADR-017, issue #290).
//
// The production case: `Padron 1926 Natural` — brand linked, no line, no blend,
// no vitola, two of the owner's smokes on it — identified mid-session as the
// Serie 1926 No. 2. Setting the row's vitola would have declared both earlier
// smokes a No. 2, so the row is left alone and the stated vitola gets its own
// leaf under the family's structure. Every branch of that rule is pinned here.
// ==========================================================================
describe("resolveCigar family rows and vitola specialization (ADR-017)", () => {
  let h: DomainHarness;
  let user: Principal;

  beforeAll(async () => {
    h = await createHarness();
    user = await h.createUser("specialize@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function seedRegistry(
    brandName: string,
    lineName: string,
    blendName: string,
  ): Promise<{ brandId: string; lineId: string; blendId: string }> {
    const brandRows = await h.deps.db
      .insert(brands)
      .values({ name: brandName, slug: brandSlug(brandName) })
      .returning({ id: brands.id });
    const brandId = brandRows[0]!.id;
    const lineRows = await h.deps.db
      .insert(lines)
      .values({ brandId, name: lineName, slug: brandSlug(lineName) })
      .returning({ id: lines.id });
    const lineId = lineRows[0]!.id;
    const blendRows = await h.deps.db
      .insert(blends)
      .values({ lineId, name: blendName, slug: brandSlug(blendName) })
      .returning({ id: blends.id });
    return { brandId, lineId, blendId: blendRows[0]!.id };
  }

  async function readCigar(cigarId: string) {
    const rows = await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)).limit(1);
    return rows[0]!;
  }

  async function auditAfter(action: string, cigarId: string): Promise<Record<string, unknown>> {
    const rows = await h.deps.db.select().from(auditLog);
    const row = rows
      .filter((entry) => entry.action === action)
      .map((entry) => entry.after as Record<string, unknown>)
      .find((after) => after?.cigarId === cigarId || after?.cigar_id === cigarId);
    return row ?? {};
  }

  // THE MINT, and the whole of what a sibling inherits. The described name
  // already carries the vitola, so it is the name — composing would have
  // produced `… Belicoso Belicoso`.
  it("mints the sibling under the family's structure and keeps the described name", async () => {
    const registry = await seedRegistry("Alturas", "Reserva", "Natural");
    const familyId = await h.seedCigar({
      canonicalName: "Alturas Reserva Natural",
      brand: "Alturas",
      line: "Reserva",
      type: "NC",
      ...registry,
    });

    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: {
        described: {
          canonicalName: "Alturas Reserva Natural Belicoso",
          vitola: { name: "Belicoso", lengthInches: 5.5, ringGauge: 52 },
        },
      },
      overallDescriptors: ["cocoa"],
    });

    expect(saved.cigarCreated).toBe(true);
    expect(saved.smoke.cigar.cigarId).not.toBe(familyId);
    expect(saved.smoke.cigar.canonicalName).toBe("Alturas Reserva Natural Belicoso");
    expect(saved.specializedFrom).toEqual({
      cigarId: familyId,
      canonicalName: "Alturas Reserva Natural",
    });
    // A created sibling queues its enrichment on the existing rule — a save that
    // creates fills a gap (#177).
    expect(saved.enrichmentQueued).toBe(true);

    const sibling = await readCigar(saved.smoke.cigar.cigarId);
    expect(sibling.brandId).toBe(registry.brandId);
    expect(sibling.lineId).toBe(registry.lineId);
    expect(sibling.blendId).toBe(registry.blendId);
    expect(sibling.brand).toBe("Alturas");
    expect(sibling.line).toBe("Reserva");
    expect(sibling.type).toBe("NC");
    expect(sibling.vitolaName).toBe("Belicoso");
    expect(Number(sibling.lengthInches)).toBe(5.5);
    expect(sibling.ringGauge).toBe(52);
    expect(sibling.nameSource).toBe("freeform");
    expect(sibling.verification).toBe("unverified");

    // THE FAMILY ROW IS NEVER RETYPED — the owner's whole objection.
    const family = await readCigar(familyId);
    expect(family.vitolaName).toBeNull();
    expect(family.canonicalName).toBe("Alturas Reserva Natural");
  });

  // The other composition: the user named the family, the vitola came from the
  // field, so the sibling's name is the family's plus the vitola.
  it("composes <family> <vitola> when the described name does not carry it", async () => {
    const familyId = await h.seedCigar({ canonicalName: "Marca Uno Reserva" });

    const added = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Marca Uno Reserva", vitola: { name: "Toro" } },
    });

    expect(added.created).toBe(true);
    expect(added.cigar.cigarId).not.toBe(familyId);
    expect(added.cigar.canonicalName).toBe("Marca Uno Reserva Toro");
    expect(added.specializedFrom).toEqual({
      cigarId: familyId,
      canonicalName: "Marca Uno Reserva",
    });

    // The audit is the only record of the pairing — the family row is not written
    // to, so nothing else could carry it.
    const after = await auditAfter("cigar.add", added.cigar.cigarId);
    expect(after.specializedFrom).toEqual({
      cigarId: familyId,
      canonicalName: "Marca Uno Reserva",
    });
  });

  // GET-OR-CREATE. The second ask finds the leaf the first minted — matched on
  // the family's parts plus the folded vitola — and links it.
  it("links an existing sibling instead of minting a second one", async () => {
    const registry = await seedRegistry("Ventura", "Grande", "Natural");
    const familyId = await h.seedCigar({
      canonicalName: "Ventura Grande Natural",
      brand: "Ventura",
      ...registry,
    });

    const first = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Ventura Grande Natural", vitola: { name: "No. 2" } },
    });
    expect(first.created).toBe(true);
    expect(first.cigar.canonicalName).toBe("Ventura Grande Natural No. 2");

    const second = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Ventura Grande Natural", vitola: { name: "no. 2" } },
    });
    expect(second.created).toBe(false);
    expect(second.cigar.cigarId).toBe(first.cigar.cigarId);
    expect(second.specializedFrom).toEqual({
      cigarId: familyId,
      canonicalName: "Ventura Grande Natural",
    });
  });

  // UNKNOWN STAYS UNKNOWN. No stated vitola is not a claim about the vitola, so
  // the family row is exactly the right place for the smoke.
  it("links to the family row when no vitola is stated", async () => {
    const familyId = await h.seedCigar({ canonicalName: "Costera Azul Natural" });

    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { described: { canonicalName: "Costera Azul Natural" } },
      overallDescriptors: ["cedar"],
    });

    expect(saved.smoke.cigar.cigarId).toBe(familyId);
    expect(saved.cigarCreated).toBe(false);
    expect(saved.specializedFrom).toBeUndefined();
  });

  // A CANDIDATE THAT RECORDS ITS VITOLA IS NOT A FAMILY ROW, so the link-or-create
  // verdict it already got is the verdict it keeps. Both halves of "as before":
  // a number-distinct sibling still creates...
  it("creates as before against a candidate whose recorded vitola is number-distinct", async () => {
    const existingId = await h.seedCigar({
      canonicalName: "Sierra Doble Serie No. 2",
      vitolaName: "No. 2",
    });

    const added = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Sierra Doble Serie No. 4", vitola: { name: "No. 4" } },
    });

    expect(added.created).toBe(true);
    expect(added.cigar.cigarId).not.toBe(existingId);
    expect(added.specializedFrom).toBeUndefined();
    expect((await readCigar(added.cigar.cigarId)).vitolaName).toBe("No. 4");
  });

  // ...and a size word, which is vocabulary and not identity, still links exactly
  // as it did before this ADR (flow 002). Specialization must not turn that into
  // a mint by the back door.
  it("keeps today's link when the candidate records a differing size word", async () => {
    const existingId = await h.seedCigar({
      canonicalName: "Barlovento Clasico Robusto",
      vitolaName: "Robusto",
    });

    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: {
        described: { canonicalName: "Barlovento Clasico Toro", vitola: { name: "Toro" } },
      },
      overallDescriptors: ["cedar"],
    });

    expect(saved.smoke.cigar.cigarId).toBe(existingId);
    expect(saved.cigarCreated).toBe(false);
    expect(saved.specializedFrom).toBeUndefined();
  });

  // THE CONFIRMED-DISTINCT PATH IS UNTOUCHED. The user was shown candidates and
  // said none is theirs, so the described entry is created verbatim — no family
  // structure inherited, nothing specialized.
  it("leaves the confirmedDistinct path alone", async () => {
    const registry = await seedRegistry("Bahia", "Verde", "Natural");
    const familyId = await h.seedCigar({
      canonicalName: "Bahia Verde Natural",
      brand: "Bahia",
      ...registry,
    });

    const added = await addCigar(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { canonicalName: "Bahia Verde Natural Robusto", vitola: { name: "Robusto" } },
      confirmedDistinct: true,
    });

    expect(added.created).toBe(true);
    expect(added.cigar.cigarId).not.toBe(familyId);
    expect(added.specializedFrom).toBeUndefined();
    const created = await readCigar(added.cigar.cigarId);
    expect(created.canonicalName).toBe("Bahia Verde Natural Robusto");
    // Resolved from the DESCRIBED fields, as that path always has — not inherited
    // from the family row.
    expect(created.brandId).toBeNull();
    expect(created.lineId).toBeNull();
    expect(created.blendId).toBeNull();
  });

  // The family row's own name already carries the size its field never recorded.
  // Composing would name the family itself, and minting a second row under the
  // family's own name is never right — so it links, and nothing is specialized.
  it("links the family row when the stated vitola is already in its name", async () => {
    const familyId = await h.seedCigar({ canonicalName: "Puerto Claro Anejo Torpedo" });

    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: {
        described: { canonicalName: "Puerto Claro Anejo Torpedo", vitola: { name: "Torpedo" } },
      },
      overallDescriptors: ["cedar"],
    });

    expect(saved.smoke.cigar.cigarId).toBe(familyId);
    expect(saved.cigarCreated).toBe(false);
    expect(saved.specializedFrom).toBeUndefined();
    expect((await readCigar(familyId)).vitolaName).toBeNull();
  });
});
