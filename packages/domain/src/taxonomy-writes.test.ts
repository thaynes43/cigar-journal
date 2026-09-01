import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, blendBlenders, blends, brands, cigars, lines } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { brandSlug } from "./catalog-browse.js";
import { fold } from "./taxonomy-keys.js";
import {
  createBrand,
  createBrandWithinTx,
  createLine,
  addLineAliases,
  createBlend,
  addBlendAliases,
  createBlender,
  creditBlender,
  editRegistryAliases,
  assignCigarParts,
  loadCigarNameParts,
  recomposeCigarName,
  aliasKeysFor,
  mintRegistrySlug,
  registrySlugCandidates,
  RESERVED_SLUG_SUFFIX,
  assertSlugMintable,
} from "./taxonomy-writes.js";
import { renameCigar, setCigarFacts } from "./curation.js";
import { resolveCigar } from "./cigar-resolution.js";
import { updateCigar } from "./update-cigar.js";
import { CigarNotFoundError, ValidationError, UnauthorizedError } from "./errors.js";
import type { Principal } from "./deps.js";

// Registry writes, ancestry wiring and name recomposition (ADR-012 Wave 2).

describe("taxonomy writes", () => {
  let h: DomainHarness;
  let curator: Principal;
  let user: Principal;
  let padronId: string;
  let drewEstateId: string;

  const seedBrand = async (name: string): Promise<string> => {
    const rows = await h.deps.db
      .insert(brands)
      .values({ name, slug: brandSlug(name), aliases: [...new Set([brandSlug(name), fold(name)])] })
      .returning({ id: brands.id });
    return rows[0]!.id;
  };

  const auditsFor = (action: string) =>
    h.deps.db
      .select({ action: auditLog.action, actor: auditLog.actor, clientId: auditLog.clientId, after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.action, action));

  beforeAll(async () => {
    h = await createHarness();
    curator = await h.createUser("registry-curator@example.com", "admin");
    user = await h.createUser("registry-user@example.com");
    padronId = await seedBrand("Padrón");
    drewEstateId = await seedBrand("Drew Estate");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  describe("aliasKeysFor", () => {
    // Aliases are MATCHING KEYS, derived here rather than accepted from the
    // caller: a display spelling stored in `aliases` would simply never be probed
    // for, which is a silent failure rather than a loud one.
    it("derives folded keys and nothing else", () => {
      expect(aliasKeysFor("Liga Privada")).toEqual(["liga-privada"]);
      expect(aliasKeysFor("No. 9", ["Number 9"])).toEqual(["no-9", "number-9"]);
    });

    // The Wave 3 residue #220 missed. The name-derived key used to include
    // `brandSlug(name)` so the row's own slug rode along in the probe — correct
    // while slugs were transcriptions, junk once `mintRegistrySlug` folded, since
    // the folded key IS the minted slug and no vendor writes an accent as a
    // hyphen. One accented name, one key.
    it("emits exactly one name-derived key for an accented name — the folded one", () => {
      for (const [name, key] of [
        ["Padrón", "padron"],
        ["Cavalier Genève", "cavalier-geneve"],
        ["Don Pepín García", "don-pepin-garcia"],
        ["Jaime García", "jaime-garcia"],
      ] as const) {
        expect(aliasKeysFor(name)).toEqual([key]);
        // The key a mint stores and the slug it addresses on are the same string,
        // which is what lets one GIN probe answer both questions.
        expect(aliasKeysFor(name)).toContain(mintRegistrySlug(name));
        expect(aliasKeysFor(name)).not.toContain(brandSlug(name));
      }
    });

    // A caller may still ADD the transcription deliberately — it folds to itself,
    // being ASCII already — which is what keeps a legacy URL key reachable after
    // a slug rename (migration 0029, Padrón).
    it("accepts a legacy transcription as an explicit extra key", () => {
      expect(aliasKeysFor("Padrón", ["padr-n"])).toEqual(["padr-n", "padron"]);
    });
  });

  // `unfiled` means IS NULL at every hierarchy level (DESIGN-004 D-05), so a
  // registry row wearing it would be permanently unreachable by URL. The slug is
  // a DERIVED addressing key, so deriving a different one costs the row nothing —
  // which is why this suffixes rather than refusing a perfectly legitimate name.
  describe("mintRegistrySlug", () => {
    it("never returns the reserved slug, whatever the spelling", () => {
      for (const name of ["Unfiled", "UNFILED", "unfiled", "  unfiled  ", "Unfiled!", "-unfiled-"]) {
        expect(mintRegistrySlug(name)).not.toBe("unfiled");
        expect(mintRegistrySlug(name)).toBe(`unfiled${RESERVED_SLUG_SUFFIX}`);
      }
    });

    it("is brandSlug for every ASCII name that does not collide with it", () => {
      for (const name of ["Liga Privada", "No. 9", "1964 Anniversary Series", "Unfiled Reserva"]) {
        expect(mintRegistrySlug(name)).toBe(brandSlug(name.trim()));
      }
      // Only the exact key is reserved: `Un-Filed!` slugs to `un-filed`, which
      // addresses nothing special, so it is minted untouched.
      expect(mintRegistrySlug("Un-Filed!")).toBe("un-filed");
      expect(mintRegistrySlug("Unfiled Reserva")).toBe("unfiled-reserva");
    });

    // The Wave 3 change. `brandSlug()` collapses each accented character to a
    // hyphen, so the ~60 marcas that wave adds would have minted URL keys like
    // `don-pep-n-garc-a`. Folding first gives them the key a reader would guess.
    it("folds accents, so a new marca gets a readable key", () => {
      expect(mintRegistrySlug("Don Pepín García")).toBe("don-pepin-garcia");
      expect(mintRegistrySlug("Padrón")).toBe("padron");
      expect(mintRegistrySlug("La Aroma de Cuba Mi Amor Reserva")).toBe("la-aroma-de-cuba-mi-amor-reserva");
      expect(mintRegistrySlug("  Añejo  ")).toBe("anejo");

      // It is `fold()` doing the work, not a private table of substitutions —
      // the same function every alias key is derived with.
      for (const name of ["Don Pepín García", "Padrón", "Añejo", "Fóldy"]) {
        expect(mintRegistrySlug(name)).toBe(fold(name));
      }
    });

    // The reservation guards the FOLDED result, which is the ordering that
    // matters: fold, then check. A spelling that only reaches the reserved word
    // by folding still has to be caught.
    it("still reserves `unfiled` after folding", () => {
      expect(mintRegistrySlug("Unfiléd")).toBe(`unfiled${RESERVED_SLUG_SUFFIX}`);
      expect(mintRegistrySlug("Unfiléd")).not.toBe("unfiled");
    });

    // The legacy transcription is untouched — it is the stored key for every row
    // minted before this change and for the brand URLs those rows answer on.
    // Two flavors, and `registrySlugCandidates` is what spans them.
    it("leaves brandSlug alone and offers both flavors for lookup", () => {
      expect(brandSlug("Padrón")).toBe("padr-n");
      expect(registrySlugCandidates("Padrón")).toEqual(["padron", "padr-n"]);
      // An ASCII name collapses to one candidate, so the common lookup stays a
      // single-value probe.
      expect(registrySlugCandidates("Drew Estate")).toEqual(["drew-estate"]);
      expect(registrySlugCandidates("!!!")).toEqual([]);
    });
  });

  // The second line of defence behind the minter. It cannot fire on today's
  // paths — `requireSlug` mints through `mintRegistrySlug`, which never yields
  // the bare slug — and that is the point: the create paths refuse the value
  // rather than trusting that every future caller reached them through the
  // minter. A guard nothing can exercise is a guard nobody can trust, so it is
  // exercised here directly.
  describe("assertSlugMintable", () => {
    it("refuses the reserved slug and passes everything else", () => {
      expect(() => assertSlugMintable("unfiled", "name")).toThrow(ValidationError);
      try {
        assertSlugMintable("unfiled", "name");
      } catch (err) {
        expect((err as ValidationError).fields).toEqual([
          {
            path: "name",
            message: "The slug 'unfiled' is reserved for the catalog's unfiled population.",
          },
        ]);
      }
      for (const slug of [`unfiled${RESERVED_SLUG_SUFFIX}`, "unfiled-reserva", "un-filed", "padr-n"]) {
        expect(() => assertSlugMintable(slug, "name")).not.toThrow();
      }
    });

    // Wave 3 (#214) made brands mintable from TypeScript for the first time —
    // until then the registry was seeded only by migration 0026/0027, so the
    // reservation had no brand-level write path to guard. It needs none of its
    // own: every create path mints through `requireSlug`, so the new one is
    // covered by construction. Pinned because "covered by construction" is a
    // claim about a chokepoint, and chokepoints are exactly what a later
    // refactor routes around.
    it("holds on the brand path Wave 3 added", async () => {
      const brand = await createBrand(h.deps, curator, { name: "Unfiled" });
      expect(brand.slug).toBe(`unfiled${RESERVED_SLUG_SUFFIX}`);
      expect(brand.slug).not.toBe("unfiled");
    });
  });

  // What the fold buys, on the real write path rather than on the minter alone.
  describe("minting an accented marca", () => {
    it("gives a new brand a readable slug that IS its folded alias key", async () => {
      const name = "Don Pepín García";
      const result = await createBrand(h.deps, curator, { name });

      expect(result.slug).toBe("don-pepin-garcia");
      expect(result.aliases).toContain("don-pepin-garcia");

      const row = (await h.deps.db.select().from(brands).where(eq(brands.id, result.brandId)))[0]!;
      expect(row.name).toBe(name);
      expect(row.slug).toBe("don-pepin-garcia");

      // SLUG AND FOLDED ALIAS KEY NOW COINCIDE. Before this change the slug was
      // the `brandSlug()` transcription (`don-pep-n-garc-a`) and the folded key
      // was something else, so the row's own address was a key the alias array
      // did not carry. Now the row's slug is one of its alias entries, which is
      // why ONE GIN containment probe resolves both questions — "which row
      // answers to this spelling" and "which row lives at this URL key" — with
      // no second lookup against `slug`. This probe is that claim: it asks the
      // alias index and reads the slug off what comes back.
      const probe = await h.deps.db.execute(
        sql`SELECT slug, name FROM brands WHERE aliases && ARRAY['don-pepin-garcia']::text[]`,
      );
      expect(probe.rows).toHaveLength(1);
      expect((probe.rows as unknown as { slug: string; name: string }[])[0]).toEqual({
        slug: "don-pepin-garcia",
        name,
      });
      expect(row.slug).toBe(fold(name));
      expect(row.aliases).toContain(row.slug);
    });

    // `cigars.brand_id` is a projection of the free-text `brand`, derived by
    // `deriveBrandId`. That derivation is a slug lookup, so folding the mint
    // without folding the lookup would leave every cigar whose brand text is
    // accented unlinked from the marca just minted for it — and unlinked is the
    // SILENT outcome there, since an unmatched spelling yields null by design.
    it("links a cigar's accented brand text to the folded row", async () => {
      const name = "Joya de Nicaragua Antaño";
      const minted = await createBrand(h.deps, curator, { name });
      expect(minted.slug).toBe("joya-de-nicaragua-antano");

      const cigarId = await h.seedCigar({ canonicalName: "Antano Gran Consul", verification: "unverified" });
      await updateCigar(h.deps, user, { clientRequestId: newRequestId(), cigarId, fields: { brand: name } });

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row).toMatchObject({ brand: name, brandId: minted.brandId });
    });

    // The same derivation still reaches a LEGACY-flavor row. `Padrón` is stored
    // as `padr-n`, and the candidate list carries the transcription too, so the
    // link the catalog has always made keeps being made.
    it("still links accented brand text to a legacy padr-n row", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Padron Legacy Probe", verification: "unverified" });
      await updateCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "Padrón" },
      });

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row).toMatchObject({ brand: "Padrón", brandId: padronId });
    });

    // The rail that makes minting accented names safe rather than a
    // duplicate-marca hazard. `Padrón` was seeded the old way: slug `padr-n`,
    // aliases `['padr-n','padron']`. Minting it again now derives slug `padron`,
    // which the unique index on `brands.slug` would happily admit alongside
    // `padr-n` — the two flavors do not collide with each other. The FOLDED KEY
    // is what collides, and the global alias check is what sees it.
    //
    // So: REFUSED, not reused. `createBrand` is a mint, not a get-or-create, and
    // it names the existing spelling so the curator learns the marca is already
    // there. (register_taxonomy is the get-or-create; it probes both flavors and
    // reuses this row instead of reaching here — pinned in taxonomy-curation.test.ts.)
    it("refuses a second Padrón and leaves the seeded row alone", async () => {
      const before = await h.deps.db.execute(
        sql`SELECT id, slug FROM brands WHERE aliases && ARRAY['padron']::text[]`,
      );
      expect(before.rows).toHaveLength(1);

      const refusal = await createBrand(h.deps, curator, { name: "Padrón" }).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(ValidationError);
      // It refuses on the FOLDED key, and names the spelling already holding it.
      // The message used to read `padr-n`: the mint derived the transcription as
      // well, it sorted first, and so the refusal quoted a key the curator never
      // typed and could not see. Now one name derives one key, and the key the
      // refusal names is the one that actually collided.
      expect((refusal as ValidationError).fields).toEqual([
        { path: "aliases", message: "The matching key 'padron' is already claimed by 'Padrón'." },
      ]);

      // NO SECOND ROW. Not by folded key, and not by either slug flavor.
      const after = await h.deps.db.execute(
        sql`SELECT id, slug FROM brands WHERE aliases && ARRAY['padron']::text[] OR slug IN ('padron','padr-n')`,
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows).toEqual(before.rows);
      expect((after.rows as unknown as { slug: string }[])[0]!.slug).toBe("padr-n");
    });
  });

  // The one collision the check cannot see on its own: `aliases` has no unique
  // constraint, so two transactions claiming the same folded key can both read a
  // clean table and both commit unless something serializes them. Both tests
  // drive the race deliberately rather than hoping to catch it — the first
  // transaction is held open, mid-claim and uncommitted, for exactly as long as
  // it takes the second to park on the advisory lock.
  describe("concurrent alias claims", () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };

    // A writer parked on an advisory lock is an ungranted row in `pg_locks`.
    // Waiting for it is what makes the race deterministic instead of timing
    // luck: the holder does not commit until the challenger is provably blocked,
    // so the outcome is decided by the lock and never by which statement won a
    // scheduling coin flip.
    const waitForBlockedClaim = async (): Promise<boolean> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const parked = await h.deps.db.execute(
          sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        if ((parked.rows as unknown as { n: number }[])[0]!.n > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };

    it(
      "lets exactly one of two racing claims on the same folded key win",
      async () => {
        const claimed = deferred();
        const commit = deferred();

        const holder = h.deps.db.transaction(async (tx) => {
          const result = await createBrandWithinTx(tx, h.deps, curator, { name: "Fóldy" });
          claimed.resolve();
          await commit.promise;
          return result;
        });
        await claimed.promise;

        // `Foldy` slugs differently from `Fóldy`, so the unique index on
        // `brands.slug` would admit it happily. The folded key `foldy` they both
        // derive is the whole conflict — and it is uncommitted, and therefore
        // invisible to any SELECT, for as long as the holder stays open.
        const challenger = createBrand(h.deps, curator, { name: "Foldy" });
        const blocked = await waitForBlockedClaim();
        commit.resolve();
        const [first, second] = await Promise.allSettled([holder, challenger]);

        expect(blocked).toBe(true);
        expect(first.status).toBe("fulfilled");
        expect(second.status).toBe("rejected");
        const error = (second as PromiseRejectedResult).reason as ValidationError;
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.fields[0]!.message).toBe("The matching key 'foldy' is already claimed by 'Fóldy'.");

        // The point of the refusal: one key, one holder. Two would leave the key
        // unresolvable — `anchorByAlias` drops a key claimed by more than one row.
        const holders = await h.deps.db.execute(sql`SELECT name FROM brands WHERE aliases && ARRAY['foldy']::text[]`);
        expect(holders.rows).toHaveLength(1);
      },
      20_000,
    );

    // Per key, not a global mutex: serializing every registry write behind one
    // lock would make a curation batch a queue.
    it(
      "lets claims on different keys proceed side by side",
      async () => {
        const claimed = deferred();
        const commit = deferred();

        const holder = h.deps.db.transaction(async (tx) => {
          await createBrandWithinTx(tx, h.deps, curator, { name: "Lockstep Alpha" });
          claimed.resolve();
          await commit.promise;
        });
        await claimed.promise;

        try {
          await expect(createBrand(h.deps, curator, { name: "Lockstep Beta" })).resolves.toMatchObject({
            slug: "lockstep-beta",
          });
        } finally {
          commit.resolve();
          await holder;
        }
      },
      20_000,
    );
  });

  describe("createLine", () => {
    it("mints a line under its brand, audited", async () => {
      const result = await createLine(h.deps, curator, {
        brandId: padronId,
        name: "1964 Anniversary Series",
        aliases: ["1964 Anniversary"],
      });
      expect(result.slug).toBe("1964-anniversary-series");
      expect(result.aliases).toEqual(["1964-anniversary", "1964-anniversary-series"]);

      const row = (await h.deps.db.select().from(lines).where(eq(lines.id, result.lineId)))[0]!;
      expect(row).toMatchObject({ brandId: padronId, name: "1964 Anniversary Series" });

      const audits = await auditsFor("line.create");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actor: "web", clientId: null });
    });

    it("is curator-only", async () => {
      await expect(createLine(h.deps, user, { brandId: padronId, name: "Denied" })).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });

    // The registry-level form of the ancestry rule: a line whose brand cannot be
    // resolved is exactly as wrong as a cigar claiming a line from another brand.
    it("refuses a brand that does not exist", async () => {
      await expect(
        createLine(h.deps, curator, { brandId: "00000000-0000-0000-0000-000000000000", name: "Orphan" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // Scoped to the brand, not global — two brands may each have a `reserva` and
    // neither has to yield the name (0026's lines_brand_id_slug_key).
    it("scopes slug uniqueness to the brand", async () => {
      await createLine(h.deps, curator, { brandId: padronId, name: "Reserva" });
      await expect(createLine(h.deps, curator, { brandId: padronId, name: "Reserva" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      // The same name under a different marca is fine.
      await expect(createLine(h.deps, curator, { brandId: drewEstateId, name: "Reserva" })).resolves.toMatchObject(
        { slug: "reserva" },
      );
    });

    // An ambiguous key is worth less than a missing one: a missing key lets the
    // matcher fall through to triage, an ambiguous one anchors it on the wrong
    // row. Checked before the write, because a curator can fix the spelling they
    // just typed and a nightly sweep cannot.
    it("refuses an alias another line of the same brand already claims", async () => {
      await createLine(h.deps, curator, { brandId: padronId, name: "Serie 1926", aliases: ["1926"] });
      await expect(
        createLine(h.deps, curator, { brandId: padronId, name: "Nineteen Twenty Six", aliases: ["1926"] }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // The name is legitimate and is kept; only the derived key moves. Refusing
    // would put the catalog's internal vocabulary in front of a curator who never
    // chose it.
    it("mints a line named Unfiled onto the suffixed slug, and keeps the row addressable", async () => {
      const brandId = await seedBrand("Reserved Slug Marca");
      const line = await createLine(h.deps, curator, { brandId, name: "Unfiled" });
      expect(line.slug).toBe(`unfiled${RESERVED_SLUG_SUFFIX}`);
      expect(line.slug).not.toBe("unfiled");

      const row = (await h.deps.db.select().from(lines).where(eq(lines.id, line.lineId)))[0]!;
      expect(row).toMatchObject({ brandId, name: "Unfiled", slug: "unfiled-1" });
      // Retrievable by the key it actually wears, scoped to its brand — which is
      // the whole point of moving the slug rather than the name.
      const bySlug = await h.deps.db
        .select({ id: lines.id })
        .from(lines)
        .where(and(eq(lines.brandId, brandId), eq(lines.slug, "unfiled-1")));
      expect(bySlug).toEqual([{ id: line.lineId }]);

      // A second Unfiled under the same marca is an ordinary slug collision, and
      // is refused where slug collisions belong — not silently re-suffixed.
      await expect(createLine(h.deps, curator, { brandId, name: "Unfiled" })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("refuses a name with no addressable slug", async () => {
      await expect(createLine(h.deps, curator, { brandId: padronId, name: "!!!" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(createLine(h.deps, curator, { brandId: padronId, name: "   " })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe("addLineAliases", () => {
    it("adds derived keys and audits the before/after", async () => {
      const line = await createLine(h.deps, curator, { brandId: drewEstateId, name: "Undercrown" });
      const result = await addLineAliases(h.deps, curator, { id: line.lineId, aliases: ["Under Crown"] });
      expect(result.added).toEqual(["under-crown"]);
      expect(result.aliases).toEqual(["under-crown", "undercrown"]);
      expect(await auditsFor("line.set_aliases")).toHaveLength(1);
    });

    it("is a no-op when the key is already held", async () => {
      const line = await createLine(h.deps, curator, { brandId: drewEstateId, name: "Herrera Esteli" });
      const result = await addLineAliases(h.deps, curator, { id: line.lineId, aliases: ["Herrera Esteli"] });
      expect(result.added).toEqual([]);
    });
  });

  describe("createBlend", () => {
    it("mints a blend under its line and leaves the leaf-role columns null", async () => {
      const line = await createLine(h.deps, curator, { brandId: drewEstateId, name: "Liga Privada" });
      const blend = await createBlend(h.deps, curator, { lineId: line.lineId, name: "No. 9" });
      const row = (await h.deps.db.select().from(blends).where(eq(blends.id, blend.blendId)))[0]!;
      expect(row).toMatchObject({ lineId: line.lineId, name: "No. 9", slug: "no-9" });
      // Wrapper/binder/filler are a required DOCUMENTATION TARGET, not a required
      // argument: enrichment pursues them and NULL keeps meaning "not yet known".
      expect(row.wrapper).toBeNull();
      expect(row.binder).toBeNull();
      expect(row.filler).toBeNull();
      expect(await auditsFor("blend.create")).toHaveLength(1);
    });

    it("stores the tobacco roles when they are actually known", async () => {
      const line = await createLine(h.deps, curator, { brandId: drewEstateId, name: "Nica Rustica" });
      const blend = await createBlend(h.deps, curator, {
        lineId: line.lineId,
        name: "Belly",
        wrapper: "Connecticut Broadleaf",
        binder: "Mexican San Andrés",
        filler: "Nicaraguan",
      });
      const row = (await h.deps.db.select().from(blends).where(eq(blends.id, blend.blendId)))[0]!;
      expect(row.wrapper).toBe("Connecticut Broadleaf");
    });

    it("refuses a line that does not exist", async () => {
      await expect(
        createBlend(h.deps, curator, { lineId: "00000000-0000-0000-0000-000000000000", name: "Orphan" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("scopes slug and alias uniqueness to the line", async () => {
      const a = await createLine(h.deps, curator, { brandId: padronId, name: "Family Reserve" });
      const b = await createLine(h.deps, curator, { brandId: padronId, name: "Damaso" });
      await createBlend(h.deps, curator, { lineId: a.lineId, name: "Maduro" });
      await expect(createBlend(h.deps, curator, { lineId: a.lineId, name: "Maduro" })).rejects.toBeInstanceOf(
        ValidationError,
      );
      // A `maduro` under a different line is a different blend, and must be
      // allowed: wrapper variants exist across the whole catalog.
      await expect(createBlend(h.deps, curator, { lineId: b.lineId, name: "Maduro" })).resolves.toMatchObject({
        slug: "maduro",
      });
    });

    it("adds blend aliases", async () => {
      const line = await createLine(h.deps, curator, { brandId: drewEstateId, name: "Deadwood" });
      const blend = await createBlend(h.deps, curator, { lineId: line.lineId, name: "Fat Bottom Betty" });
      const result = await addBlendAliases(h.deps, curator, { id: blend.blendId, aliases: ["FBB"] });
      expect(result.added).toEqual(["fbb"]);
    });
  });

  describe("blenders", () => {
    // Global rather than per-brand, because a blender's work spans brands and
    // collaborations exist. Credit the BLEND, not the brand.
    it("mints a blender and credits a blend", async () => {
      const blender = await createBlender(h.deps, curator, { name: "Steve Saka" });
      const line = await createLine(h.deps, curator, { brandId: drewEstateId, name: "Sin Compromiso" });
      const blend = await createBlend(h.deps, curator, { lineId: line.lineId, name: "Seleccion No. 5" });

      expect(await creditBlender(h.deps, curator, { blendId: blend.blendId, blenderId: blender.blenderId })).toEqual({
        created: true,
      });
      const edges = await h.deps.db
        .select()
        .from(blendBlenders)
        .where(and(eq(blendBlenders.blendId, blend.blendId), eq(blendBlenders.blenderId, blender.blenderId)));
      expect(edges).toHaveLength(1);

      // The composite PK makes a duplicate credit unrepresentable, so a repeat is
      // a no-op rather than an error — and audits nothing the second time.
      expect(await creditBlender(h.deps, curator, { blendId: blend.blendId, blenderId: blender.blenderId })).toEqual({
        created: false,
      });
      expect(await auditsFor("blend.credit_blender")).toHaveLength(1);
    });

    it("refuses a credit naming a blend or blender that does not exist", async () => {
      const blender = await createBlender(h.deps, curator, { name: "Willy Herrera" });
      await expect(
        creditBlender(h.deps, curator, {
          blendId: "00000000-0000-0000-0000-000000000000",
          blenderId: blender.blenderId,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("keeps blender slugs globally unique", async () => {
      await createBlender(h.deps, curator, { name: "AJ Fernandez" });
      await expect(createBlender(h.deps, curator, { name: "AJ Fernandez" })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("assignCigarParts", () => {
    let lineId: string;
    let blendId: string;
    let foreignLineId: string;

    beforeAll(async () => {
      const line = await createLine(h.deps, curator, { brandId: padronId, name: "1926 Serie" });
      lineId = line.lineId;
      blendId = (await createBlend(h.deps, curator, { lineId, name: "Natural" })).blendId;
      foreignLineId = (await createLine(h.deps, curator, { brandId: drewEstateId, name: "Kentucky Fire Cured" }))
        .lineId;
    });

    it("sets the three FKs together and audits them", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Padron 1926 Natural No. 1" });
      const result = await assignCigarParts(h.deps, curator, { cigarId, brandId: padronId, lineId, blendId });
      expect(result.changedFields).toEqual(expect.arrayContaining(["brandId", "lineId", "blendId"]));
      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row).toMatchObject({ brandId: padronId, lineId, blendId });
      expect(await auditsFor("cigar.assign_parts")).not.toHaveLength(0);
    });

    // THE WIRED ASSERTION. Every path that sets any of the three FKs checks
    // ancestry first, and it checks the ROW SET THAT WOULD RESULT, not the fields
    // supplied.
    it("refuses a line belonging to another brand", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Padron Crossed Ancestry" });
      await expect(
        assignCigarParts(h.deps, curator, { cigarId, brandId: padronId, lineId: foreignLineId }),
      ).rejects.toBeInstanceOf(ValidationError);
      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row.lineId).toBeNull(); // the refused write never landed
    });

    it("refuses a blend without its line", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Padron Blend Without Line" });
      await expect(
        assignCigarParts(h.deps, curator, { cigarId, brandId: padronId, blendId }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses clearing a line while its blend stays", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Padron Clear Line Only" });
      await assignCigarParts(h.deps, curator, { cigarId, brandId: padronId, lineId, blendId });
      await expect(assignCigarParts(h.deps, curator, { cigarId, lineId: null })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    // Flipping to `composed` and setting the parts is ONE write, because doing
    // either alone leaves the row wrong: a flip without right parts produces a
    // wrong name, parts without a flip leave the name stale.
    it("recomposes the name when the row is flipped to composed", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "some vendor phrasing" });
      const result = await assignCigarParts(h.deps, curator, {
        cigarId,
        brandId: padronId,
        lineId,
        blendId,
        vitolaName: "No. 1",
        nameSource: "composed",
      });
      // The registry spellings win, and the line's leading `1926` is not repeated
      // after the brand — the dedupe that makes composition better than
      // concatenation.
      expect(result.canonicalName).toBe("Padrón 1926 Serie Natural No. 1");
      expect(result.nameSource).toBe("composed");
    });

    it("recomposes again when a part later changes", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "placeholder" });
      await assignCigarParts(h.deps, curator, {
        cigarId,
        brandId: padronId,
        lineId,
        blendId,
        vitolaName: "Robusto",
        nameSource: "composed",
      });
      const after = await assignCigarParts(h.deps, curator, { cigarId, vitolaName: "Toro" });
      expect(after.canonicalName).toBe("Padrón 1926 Serie Natural Toro");
    });

    // A composed name needs something to compose from; an empty `canonical_name`
    // is not a name.
    it("refuses to compose from nothing", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Unbranded Thing" });
      await expect(assignCigarParts(h.deps, curator, { cigarId, nameSource: "composed" })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("leaves a freeform row's name completely alone", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "The Owner's Own Phrasing" });
      const result = await assignCigarParts(h.deps, curator, { cigarId, brandId: padronId });
      expect(result.canonicalName).toBe("The Owner's Own Phrasing");
    });

    it("is curator-only", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Padron Denied Parts" });
      await expect(assignCigarParts(h.deps, user, { cigarId, brandId: padronId })).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });

  describe("renameCigar on a composed row", () => {
    // `canonical_name` on a composed row is a projection of the parts. Typing
    // over it would be undone by the next part change and would meanwhile make
    // the row look maintained while disagreeing with itself.
    it("refuses the rename and points at the parts", async () => {
      const line = await createLine(h.deps, curator, { brandId: padronId, name: "Serie 1964" });
      const cigarId = await h.seedCigar({ canonicalName: "placeholder rename" });
      await assignCigarParts(h.deps, curator, {
        cigarId,
        brandId: padronId,
        lineId: line.lineId,
        nameSource: "composed",
      });

      const error = await renameCigar(h.deps, curator, {
        cigarId,
        canonicalName: "Something Else Entirely",
        clientRequestId: newRequestId(),
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("Edit those parts instead");

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row.canonicalName).toBe("Padrón Serie 1964");
    });

    it("still renames a freeform row freely", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Freeform Original" });
      const result = await renameCigar(h.deps, curator, {
        cigarId,
        canonicalName: "Freeform Renamed",
        clientRequestId: newRequestId(),
      });
      expect(result).toMatchObject({ canonicalName: "Freeform Renamed", changed: true });
    });
  });

  describe("setCigarFacts keeps the registry link honest", () => {
    it("re-derives brand_id and recomposes a composed name when the brand text changes", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "placeholder facts", brand: "Drew Estate" });
      await assignCigarParts(h.deps, curator, { cigarId, brandId: drewEstateId, nameSource: "composed" });

      await setCigarFacts(h.deps, curator, {
        cigarId,
        fields: { brand: "Padrón" },
        clientRequestId: newRequestId(),
      });

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row.brandId).toBe(padronId);
      expect(row.canonicalName).toBe("Padrón");
    });

    // Re-spelling the marca on a row that also carries a line would leave that
    // line belonging to the brand the row USED to claim. Refused rather than
    // silently repaired: clearing the line destroys a known fact, picking a new
    // one invents a fact.
    it("refuses a brand change that would orphan the row's line", async () => {
      const line = await createLine(h.deps, curator, { brandId: padronId, name: "Corticena" });
      const cigarId = await h.seedCigar({ canonicalName: "Padron Corticena Robusto", brand: "Padrón" });
      await assignCigarParts(h.deps, curator, { cigarId, brandId: padronId, lineId: line.lineId });

      await expect(
        setCigarFacts(h.deps, curator, {
          cigarId,
          fields: { brand: "Drew Estate" },
          clientRequestId: newRequestId(),
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row.brandId).toBe(padronId);
      expect(row.lineId).toBe(line.lineId);
    });
  });

  describe("the described-cigar write path", () => {
    // Every path that creates a cigar now resolves its registry ancestry, so a
    // row minted from a conversation is findable by the same alias probe the
    // crawler anchors on instead of joining the flat namespace.
    it("links a described cigar to its brand and line on creation", async () => {
      const line = await createLine(h.deps, curator, { brandId: padronId, name: "Delicias" });
      const resolved = await h.deps.db.transaction((tx) =>
        resolveCigar(tx, {
          described: {
            canonicalName: "Padron Delicias Something Distinctive",
            brand: "Padrón",
            line: "Delicias",
          },
        }),
      );
      expect(resolved.created).toBe(true);

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, resolved.cigarId)))[0]!;
      expect(row).toMatchObject({ brandId: padronId, lineId: line.lineId, nameSource: "freeform" });
    });

    // Unknown stays NULL and nothing is invented. An unrecognised marca leaves
    // the row unlinked for Wave 3 curation rather than minting a registry entry
    // from an unaudited write path.
    it("leaves an unknown marca unlinked rather than minting one", async () => {
      const before = (await h.deps.db.select({ id: brands.id }).from(brands)).length;
      const resolved = await h.deps.db.transaction((tx) =>
        resolveCigar(tx, {
          described: { canonicalName: "Totally Unknown Marca Robusto Uno", brand: "Totally Unknown Marca" },
        }),
      );
      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, resolved.cigarId)))[0]!;
      expect(row.brandId).toBeNull();
      expect(row.brand).toBe("Totally Unknown Marca");
      expect((await h.deps.db.select({ id: brands.id }).from(brands)).length).toBe(before);
    });
  });

  describe("the gap-fill write path", () => {
    // `update_cigar` fills nulls from a conversation, and `brand` is one of them —
    // so it owes the registry link the same way every other write of that column
    // does, or a repaired cigar joins the flat namespace the registries replaced.
    it("derives the registry link when a fill supplies the brand", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Gap Fill Robusto", verification: "unverified" });

      const result = await updateCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "Padrón" },
      });
      expect(result.changedFields).toContain("brand");

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row).toMatchObject({ brand: "Padrón", brandId: padronId });
    });

    // The same refusal the curator's fact edit makes: re-pointing the brand under
    // a row that already carries a line would leave that line belonging to the
    // brand the row used to claim.
    it("refuses a brand fill that would orphan the row's line", async () => {
      const line = await createLine(h.deps, curator, { brandId: padronId, name: "Familia Reserva" });
      const cigarId = await h.seedCigar({
        canonicalName: "Padron Familia Reserva Toro",
        verification: "unverified",
        brandId: padronId,
        lineId: line.lineId,
      });

      await expect(
        updateCigar(h.deps, user, {
          clientRequestId: newRequestId(),
          cigarId,
          fields: { brand: "Drew Estate" },
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row).toMatchObject({ brand: null, brandId: padronId, lineId: line.lineId });
    });

    // Every part a composed name is built from is fillable here, so the name is
    // recomputed rather than left describing the row as it was.
    it("recomposes a composed row's name after a fill touches its parts", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "some vendor phrasing", verification: "unverified" });
      await assignCigarParts(h.deps, curator, { cigarId, brandId: padronId, nameSource: "composed" });

      await updateCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { vitola: { name: "Robusto" } },
      });

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row.canonicalName).toBe("Padrón Robusto");
    });

    it("leaves a freeform row's name alone", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "The Owner's Own Gap Fill", verification: "unverified" });
      await updateCigar(h.deps, user, {
        clientRequestId: newRequestId(),
        cigarId,
        fields: { brand: "Padrón", vitola: { name: "Robusto" } },
      });

      const row = (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;
      expect(row.canonicalName).toBe("The Owner's Own Gap Fill");
      expect(row.brandId).toBe(padronId);
    });
  });

  // #206. Every id below is caller-supplied and lands in a `uuid` column, so a
  // non-uuid string used to raise an untyped 22P02 — a 500 — instead of the
  // refusal each of these functions already had for an id it cannot find. The
  // assertion is always the same shape, because the equality is the contract:
  // malformed must be INDISTINGUISHABLE from unknown-but-valid.
  describe("a malformed id is answered exactly as an unknown one", () => {
    const bad = "not-a-uuid";

    it("editRegistryAliases answers a malformed id exactly as it answers an unknown one", async () => {
      const malformed = await editRegistryAliases(h.deps, curator, {
        level: "brand",
        id: bad,
        add: ["Sweep Spelling"],
      }).catch((e: unknown) => e);
      const unknown = await editRegistryAliases(h.deps, curator, {
        level: "brand",
        id: newRequestId(),
        add: ["Sweep Spelling"],
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      expect((malformed as ValidationError).fields).toEqual([{ path: "id", message: "No such brand." }]);
    });

    // The alias delegates all go through that one editor, so guarding the core
    // guarded every one of them — including the level in the message.
    it("addLineAliases inherits the editor's answer", async () => {
      const malformed = await addLineAliases(h.deps, curator, { id: bad, aliases: ["Sweep Spelling"] }).catch(
        (e: unknown) => e,
      );
      const unknown = await addLineAliases(h.deps, curator, {
        id: newRequestId(),
        aliases: ["Sweep Spelling"],
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      expect((malformed as ValidationError).fields).toEqual([{ path: "id", message: "No such line." }]);
    });

    it("createLine answers a malformed brandId exactly as it answers an unknown one", async () => {
      const malformed = await createLine(h.deps, curator, { brandId: bad, name: "Sweep Orphan" }).catch(
        (e: unknown) => e,
      );
      const unknown = await createLine(h.deps, curator, { brandId: newRequestId(), name: "Sweep Orphan" }).catch(
        (e: unknown) => e,
      );
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      expect((malformed as ValidationError).fields).toEqual([{ path: "brandId", message: "No such brand." }]);
    });

    it("createBlend answers a malformed lineId exactly as it answers an unknown one", async () => {
      const malformed = await createBlend(h.deps, curator, { lineId: bad, name: "Sweep Orphan Blend" }).catch(
        (e: unknown) => e,
      );
      const unknown = await createBlend(h.deps, curator, {
        lineId: newRequestId(),
        name: "Sweep Orphan Blend",
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      expect((malformed as ValidationError).fields).toEqual([{ path: "lineId", message: "No such line." }]);
    });

    // Both ends of the credit, and their ORDER: a credit naming an unresolvable
    // blend is told about the blend whether or not the blender is resolvable
    // either, so the guards must not answer out of turn.
    it("creditBlender answers a malformed blendId or blenderId exactly as it answers an unknown one", async () => {
      const line = await createLine(h.deps, curator, { brandId: padronId, name: "Sweep Credit Series" });
      const blend = await createBlend(h.deps, curator, { lineId: line.lineId, name: "Sweep Credit Blend" });
      const blender = await createBlender(h.deps, curator, { name: "Sweep Credit Blender" });

      const malformedBlend = await creditBlender(h.deps, curator, {
        blendId: bad,
        blenderId: blender.blenderId,
      }).catch((e: unknown) => e);
      const unknownBlend = await creditBlender(h.deps, curator, {
        blendId: newRequestId(),
        blenderId: blender.blenderId,
      }).catch((e: unknown) => e);
      expect(malformedBlend).toBeInstanceOf(ValidationError);
      expect((malformedBlend as ValidationError).toPayload()).toEqual(
        (unknownBlend as ValidationError).toPayload(),
      );
      expect((malformedBlend as ValidationError).fields).toEqual([
        { path: "blendId", message: "No such blend." },
      ]);

      const malformedBlender = await creditBlender(h.deps, curator, {
        blendId: blend.blendId,
        blenderId: bad,
      }).catch((e: unknown) => e);
      const unknownBlender = await creditBlender(h.deps, curator, {
        blendId: blend.blendId,
        blenderId: newRequestId(),
      }).catch((e: unknown) => e);
      expect(malformedBlender).toBeInstanceOf(ValidationError);
      expect((malformedBlender as ValidationError).toPayload()).toEqual(
        (unknownBlender as ValidationError).toPayload(),
      );
      expect((malformedBlender as ValidationError).fields).toEqual([
        { path: "blenderId", message: "No such blender." },
      ]);
    });

    it("loadCigarNameParts answers a malformed id exactly as it answers an unknown one", async () => {
      const malformed = await loadCigarNameParts(h.deps.db, bad);
      const unknown = await loadCigarNameParts(h.deps.db, newRequestId());
      expect(malformed).toEqual(unknown);
      expect(malformed).toBeNull();
    });

    // Recomposition runs on a CALLER'S transaction, which is the reason the guard
    // replaces the query instead of wrapping it: a 22P02 aborts the transaction,
    // taking down work that has nothing to do with the bad id.
    it("recomposeCigarName answers a malformed id as an unknown one, leaving the transaction usable", async () => {
      const outcome = await h.deps.db.transaction(async (tx) => {
        const malformed = await recomposeCigarName(tx, bad, h.deps.now());
        const unknown = await recomposeCigarName(tx, newRequestId(), h.deps.now());
        const stillQueryable = await tx.select({ id: brands.id }).from(brands).limit(1);
        return { malformed, unknown, stillQueryable: stillQueryable.length };
      });
      expect(outcome.malformed).toEqual(outcome.unknown);
      expect(outcome.malformed).toEqual({ changed: false, canonicalName: null });
      expect(outcome.stillQueryable).toBe(1);
    });

    it("assignCigarParts answers a malformed cigarId exactly as it answers an unknown one", async () => {
      const malformed = await assignCigarParts(h.deps, curator, { cigarId: bad, vitolaName: "Robusto" }).catch(
        (e: unknown) => e,
      );
      const unknown = await assignCigarParts(h.deps, curator, {
        cigarId: newRequestId(),
        vitolaName: "Robusto",
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(CigarNotFoundError);
      expect((malformed as CigarNotFoundError).toPayload()).toEqual(
        (unknown as CigarNotFoundError).toPayload(),
      );
    });

    // The ancestry levels are guarded once, in `loadAncestryContext`. This is that
    // guard arriving at a caller: a malformed lineId is the line that could not be
    // resolved, which is what an unknown one has always been.
    it("assignCigarParts answers a malformed lineId as the unresolvable line it is", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Sweep Ancestry Row" });
      const malformed = await assignCigarParts(h.deps, curator, {
        cigarId,
        brandId: padronId,
        lineId: bad,
      }).catch((e: unknown) => e);
      const unknown = await assignCigarParts(h.deps, curator, {
        cigarId,
        brandId: padronId,
        lineId: newRequestId(),
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      expect((malformed as ValidationError).fields).toEqual([
        { path: "lineId", message: "The referenced line could not be resolved." },
      ]);
    });

    // #230. `brandId` was the sibling the guard did not cover, because nothing
    // resolved it at all: a well-formed but unknown marca rode into the cigar
    // UPDATE and came back as FK 23503 on `cigars_brand_id_fkey` — untyped, so a
    // 500. It is now the same refusal `createLine` makes, and the malformed id
    // is indistinguishable from it.
    it("assignCigarParts answers an unknown brandId as no such brand, and a malformed one the same", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Sweep Unknown Brand Row" });
      const malformed = await assignCigarParts(h.deps, curator, { cigarId, brandId: bad }).catch(
        (e: unknown) => e,
      );
      const unknown = await assignCigarParts(h.deps, curator, {
        cigarId,
        brandId: newRequestId(),
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      expect((malformed as ValidationError).fields).toEqual([
        { path: "brandId", message: "No such brand." },
      ]);

      // Refused BEFORE the write: the row is untouched, where it used to be the
      // UPDATE itself that failed.
      const row = (
        await h.deps.db.select({ brandId: cigars.brandId }).from(cigars).where(eq(cigars.id, cigarId))
      )[0]!;
      expect(row.brandId).toBeNull();
    });

    // The marca a brand ACTUALLY owns still passes, so the new check refuses
    // only what it is meant to.
    it("assignCigarParts still accepts a brandId the registry knows", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Sweep Known Brand Row" });
      const result = await assignCigarParts(h.deps, curator, { cigarId, brandId: padronId });
      expect(result.changedFields).toEqual(["brandId"]);
    });
  });
});
