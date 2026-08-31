import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLog,
  blendBlenders,
  blends,
  brands,
  cigars,
  idempotencyKeys,
  lines,
  listingMatches,
  vendors,
  type SuggestedParse,
} from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { brandSlug } from "./catalog-browse.js";
import { fold } from "./taxonomy-keys.js";
import { createBlend, createLine } from "./taxonomy-writes.js";
import {
  registerTaxonomy,
  updateRegistryAliases,
  assignCigarTaxonomy,
  splitCigar,
} from "./taxonomy-curation.js";
import { undoCurationAction } from "./curation.js";
import {
  CigarNotFoundError,
  IdempotencyConflictError,
  UnauthorizedError,
  ValidationError,
} from "./errors.js";
import type { Principal } from "./deps.js";

// The enveloped curation surface over the Wave 2 registry primitives (ADR-012
// Wave 3): get-or-create paths, alias edits, leaf assignment with a dry run, and
// the bucket split.

describe("taxonomy curation", () => {
  let h: DomainHarness;
  let curator: Principal;
  let member: Principal;
  let padronId: string;
  let drewEstateId: string;

  const seedBrand = async (name: string, aliases?: string[]): Promise<string> => {
    const rows = await h.deps.db
      .insert(brands)
      .values({ name, slug: brandSlug(name), aliases: aliases ?? [...new Set([brandSlug(name), fold(name)])] })
      .returning({ id: brands.id });
    return rows[0]!.id;
  };

  const auditsFor = (action: string) =>
    h.deps.db
      .select({
        action: auditLog.action,
        actor: auditLog.actor,
        clientId: auditLog.clientId,
        runId: auditLog.runId,
        before: auditLog.before,
        after: auditLog.after,
      })
      .from(auditLog)
      .where(eq(auditLog.action, action));

  // The whole ledger's size. A replay that "writes nothing" has to be checked
  // against every action, not the one the call was expected to take.
  const auditCount = async (): Promise<number> =>
    (await h.deps.db.select({ id: auditLog.id }).from(auditLog)).length;

  const keysFor = (clientRequestId: string) =>
    h.deps.db
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.clientRequestId, clientRequestId));

  const cigarRow = async (cigarId: string) =>
    (await h.deps.db.select().from(cigars).where(eq(cigars.id, cigarId)))[0]!;

  beforeAll(async () => {
    h = await createHarness();
    curator = await h.createUser("curation-curator@example.com", "admin");
    member = await h.createUser("curation-member@example.com");
    padronId = await seedBrand("Padrón");
    drewEstateId = await seedBrand("Drew Estate");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  describe("registerTaxonomy", () => {
    it("mints a whole brand → line → blend path in one call", async () => {
      const result = await registerTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        brand: { name: "Tatuaje" },
        line: { name: "Havana VI" },
        blend: { name: "Angeles" },
        attribution: { actor: "agent", runId: "wo-cigar-curate-wave3" },
      });

      expect(result.replayed).toBe(false);
      expect(result.brand).toMatchObject({ name: "Tatuaje", slug: "tatuaje", created: true });
      expect(result.line).toMatchObject({ name: "Havana VI", created: true });
      expect(result.blend).toMatchObject({ name: "Angeles", created: true });

      // The path is really wired, not three unrelated rows returned together.
      const line = (await h.deps.db.select().from(lines).where(eq(lines.id, result.line!.id)))[0]!;
      expect(line.brandId).toBe(result.brand.id);
      const blend = (await h.deps.db.select().from(blends).where(eq(blends.id, result.blend!.id)))[0]!;
      expect(blend.lineId).toBe(result.line!.id);

      // Attribution reaches every level. A curation run is judged on what it grew,
      // and a mint the run cannot be traced from is a mint nobody owns.
      for (const [action, id] of [
        ["brand.create", result.brand.id],
        ["line.create", result.line!.id],
        ["blend.create", result.blend!.id],
      ] as const) {
        const audit = (await auditsFor(action)).find((row) => (row.after as { id: string }).id === id);
        expect(audit).toMatchObject({ actor: "agent", runId: "wo-cigar-curate-wave3" });
      }
    });

    // GET-OR-CREATE, not create: the lane names the same line for every row under
    // it, and a create-only verb would make most of those calls errors it has to
    // tell apart from real ones.
    it("finds an existing path on a fresh request instead of minting a second one", async () => {
      const path = { brand: { name: "Illusione" }, line: { name: "Epernay" }, blend: { name: "Le Ferme" } };
      const first = await registerTaxonomy(h.deps, curator, { clientRequestId: newRequestId(), ...path });
      const second = await registerTaxonomy(h.deps, curator, { clientRequestId: newRequestId(), ...path });

      expect(second.brand).toMatchObject({ id: first.brand.id, created: false });
      expect(second.line).toMatchObject({ id: first.line!.id, created: false });
      expect(second.blend).toMatchObject({ id: first.blend!.id, created: false });
      expect(second.replayed).toBe(false);

      expect(await h.deps.db.select().from(brands).where(eq(brands.slug, "illusione"))).toHaveLength(1);
      expect(await h.deps.db.select().from(lines).where(eq(lines.brandId, first.brand.id))).toHaveLength(1);
      expect(await h.deps.db.select().from(blends).where(eq(blends.lineId, first.line!.id))).toHaveLength(1);
    });

    it("replays an identical retry and writes nothing new", async () => {
      const input = {
        clientRequestId: newRequestId(),
        brand: { name: "Warped" },
        line: { name: "La Colmena" },
      };
      const first = await registerTaxonomy(h.deps, curator, input);
      expect(first.replayed).toBe(false);

      const before = await auditCount();
      const second = await registerTaxonomy(h.deps, curator, input);
      expect(second.replayed).toBe(true);
      expect(second.brand.id).toBe(first.brand.id);
      expect(await auditCount()).toBe(before);
    });

    it("refuses the same request id carrying different work", async () => {
      const clientRequestId = newRequestId();
      await registerTaxonomy(h.deps, curator, { clientRequestId, brand: { name: "Foundation" } });
      await expect(
        registerTaxonomy(h.deps, curator, { clientRequestId, brand: { name: "Foundation Cigar Company" } }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    // The seeded `Padrón` row wears the legacy transcription `padr-n`, so an
    // unaccented `Padron` slugs apart from it under either rule and the unique
    // index would happily admit both. The folded alias check is the rail that
    // keeps a marca from forking under a second spelling — and it is the rail
    // precisely because slug uniqueness cannot see the collision.
    it("refuses a mint whose folded key another spelling of the marca holds", async () => {
      const error = await registerTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        brand: { name: "Padron" },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("Padrón");
    });

    it("refuses a blend with no line to hang off", async () => {
      await expect(
        registerTaxonomy(h.deps, curator, {
          clientRequestId: newRequestId(),
          brandId: padronId,
          blend: { name: "Orphan Blend" },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses the marca named twice, or not at all", async () => {
      await expect(
        registerTaxonomy(h.deps, curator, {
          clientRequestId: newRequestId(),
          brandId: padronId,
          brand: { name: "Padrón" },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        registerTaxonomy(h.deps, curator, { clientRequestId: newRequestId(), line: { name: "Homeless Line" } }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("mints the blender named on a blend and credits it exactly once", async () => {
      const path = {
        brand: { name: "Dunbarton" },
        line: { name: "Sobremesa" },
        blend: { name: "Fundamental", blenders: ["Steve Saka"] },
      };
      const first = await registerTaxonomy(h.deps, curator, { clientRequestId: newRequestId(), ...path });
      expect(first.blenders).toEqual([
        expect.objectContaining({ name: "Steve Saka", created: true, credited: true }),
      ]);
      expect(
        await h.deps.db.select().from(blendBlenders).where(eq(blendBlenders.blendId, first.blend!.id)),
      ).toHaveLength(1);

      // The composite PK makes a duplicate credit unrepresentable, so re-registering
      // the same path reports the existing credit rather than failing on it.
      const again = await registerTaxonomy(h.deps, curator, { clientRequestId: newRequestId(), ...path });
      expect(again.blenders[0]).toMatchObject({ id: first.blenders[0]!.id, created: false, credited: false });
    });

    // Blenders are global — the work spans brands — so a second blend crediting the
    // same person reuses the row rather than forking the person.
    it("reuses the blender row when a second blend credits the same person", async () => {
      const path = { brand: { name: "Crowned Heads" }, line: { name: "Le Careme" } };
      const first = await registerTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        ...path,
        blend: { name: "Corona Gorda", blenders: ["Jon Huber"] },
      });
      expect(first.blenders[0]!.created).toBe(true);

      const second = await registerTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        ...path,
        blend: { name: "Belicoso Fino", blenders: ["Jon Huber"] },
      });
      expect(second.blenders[0]).toMatchObject({ id: first.blenders[0]!.id, created: false, credited: true });
    });

    it("is curator-only", async () => {
      await expect(
        registerTaxonomy(h.deps, member, { clientRequestId: newRequestId(), brand: { name: "Denied Marca" } }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    // #206. Every enveloped service below reads its idempotency key before it
    // touches the id it was given, so a 22P02 there would abort a transaction
    // that had already run work. The guard sits before the transaction, and
    // answers exactly what the miss inside it answers.
    it("answers a malformed brandId exactly as it answers an unknown one", async () => {
      const malformed = await registerTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        brandId: "not-a-uuid",
        line: { name: "Sweep Line" },
      }).catch((e: unknown) => e);
      const unknown = await registerTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        brandId: newRequestId(),
        line: { name: "Sweep Line" },
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      expect((malformed as ValidationError).fields).toEqual([{ path: "brandId", message: "No such brand." }]);
    });

    // Mint-time slugs fold accents; the rows seeded before that change do not.
    // Get-or-create has to span both flavors, and it breaks a DIFFERENT case in
    // each direction if it only probes one — so both directions are pinned.
    describe("accented names, across both slug flavors", () => {
      it("mints a readable slug and then FINDS it again", async () => {
        const name = "Don Pepín García";

        const first = await registerTaxonomy(h.deps, curator, {
          clientRequestId: newRequestId(),
          brand: { name },
          line: { name: "Serie JJ" },
        });
        expect(first.brand.created).toBe(true);
        expect(first.brand.slug).toBe("don-pepin-garcia");
        expect(first.line!.slug).toBe("serie-jj");

        // The half that a fold-only mint would have broken. The lookup derives
        // its candidates from the NAME, so if it probed only the legacy
        // transcription it would miss the row it had just minted, try to mint a
        // second one, and be refused by the alias rail — turning a get-or-create
        // into a hard error for exactly the accented marcas this change is for.
        const second = await registerTaxonomy(h.deps, curator, {
          clientRequestId: newRequestId(),
          brand: { name },
          line: { name: "Serie JJ" },
        });
        expect(second.brand).toMatchObject({ id: first.brand.id, slug: "don-pepin-garcia", created: false });
        expect(second.line).toMatchObject({ id: first.line!.id, created: false });

        const rows = await h.deps.db.select({ id: brands.id }).from(brands).where(eq(brands.name, name));
        expect(rows).toHaveLength(1);
      });

      // The other half. `Padrón` was seeded the old way and still wears slug
      // `padr-n`; the folded key a mint would derive is `padron`. Probing only
      // the folded key would miss the live row and try to fork the marca.
      it("reuses the pre-existing padr-n row rather than forking it", async () => {
        const before = await h.deps.db.select({ id: brands.id }).from(brands).where(eq(brands.id, padronId));
        expect(before).toHaveLength(1);

        const result = await registerTaxonomy(h.deps, curator, {
          clientRequestId: newRequestId(),
          brand: { name: "Padrón" },
        });
        expect(result.brand).toMatchObject({ id: padronId, slug: "padr-n", created: false });

        // Untouched: no rename, no second row, and the Wave 5 redirect still has
        // exactly one slug to move.
        const padronRows = await h.deps.db
          .select({ id: brands.id, slug: brands.slug })
          .from(brands)
          .where(eq(brands.name, "Padrón"));
        expect(padronRows).toEqual([{ id: padronId, slug: "padr-n" }]);
      });
    });
  });

  describe("updateRegistryAliases", () => {
    let romeoId: string;

    beforeAll(async () => {
      romeoId = await seedBrand("Romeo y Julieta");
    });

    // The tool that closes a `no_anchor` triage row: the title named the marca in a
    // spelling the registry does not know, and the fix is a key, never a looser
    // matcher.
    it("adds a spelling as a folded matching key", async () => {
      const result = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "brand",
        id: romeoId,
        add: ["RYJ"],
      });
      expect(result.added).toEqual(["ryj"]);
      expect(result.replayed).toBe(false);

      const row = (await h.deps.db.select().from(brands).where(eq(brands.id, romeoId)))[0]!;
      expect(row.aliases).toContain("ryj");
    });

    // Both lists are folded before anything is compared, so the caller may pass the
    // accented display spelling and mean the key the row already holds.
    it("treats an accented respelling of a held key as a no-op", async () => {
      const result = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "brand",
        id: padronId,
        add: ["Padrón"],
      });
      expect(result.added).toEqual([]);
      expect(result.aliases).toEqual(["padr-n", "padron"]);
    });

    it("refuses a key another row in the same scope claims, and names the holder", async () => {
      const brandId = await seedBrand("La Palina");
      await createLine(h.deps, curator, { brandId, name: "Goldie" });
      const other = await createLine(h.deps, curator, { brandId, name: "Black Label" });

      const error = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "line",
        id: other.lineId,
        add: ["Goldie"],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("Goldie");
    });

    // A line's keys are unique WITHIN its brand, not globally: two marcas may each
    // own a `goldie` and neither has to yield the name (0026's per-brand scope).
    it("allows the same key on a line under a different brand", async () => {
      const brandId = await seedBrand("Quesada");
      const line = await createLine(h.deps, curator, { brandId, name: "Oktoberfest" });
      const result = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "line",
        id: line.lineId,
        add: ["Goldie"],
      });
      expect(result.added).toEqual(["goldie"]);
    });

    it("removes a key the row answers to but is not named for", async () => {
      const line = await createLine(h.deps, curator, { brandId: romeoId, name: "Wide Churchills", aliases: ["WC"] });
      const result = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "line",
        id: line.lineId,
        remove: ["WC"],
      });
      expect(result.removed).toEqual(["wc"]);
      expect(result.aliases).toEqual(["wide-churchills"]);
    });

    // Dropping the key a row's own name derives leaves a row that exists and cannot
    // be found by its own name — worse than the alias the curator was fixing.
    it("refuses to remove the key the row's own name derives", async () => {
      const line = await createLine(h.deps, curator, { brandId: romeoId, name: "Aniversario" });
      const error = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "line",
        id: line.lineId,
        remove: ["Aniversario"],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("rename it instead");
    });

    // The same argument at the limit. A row whose stored keys predate its current
    // name can be emptied without ever naming an identity key, so the floor is
    // checked against the resulting set rather than the request.
    it("refuses a removal that would leave the row unfindable", async () => {
      const rows = await h.deps.db
        .insert(brands)
        .values({ name: "Legacy Keys Marca", slug: "legacy-keys-marca", aliases: ["legacy-only-key"] })
        .returning({ id: brands.id });

      const error = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "brand",
        id: rows[0]!.id,
        remove: ["legacy-only-key"],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("no matching keys");
    });

    it("replays an identical retry", async () => {
      const line = await createLine(h.deps, curator, { brandId: romeoId, name: "Bully" });
      const input = {
        clientRequestId: newRequestId(),
        level: "line" as const,
        id: line.lineId,
        add: ["Short Churchill"],
      };
      expect((await updateRegistryAliases(h.deps, curator, input)).replayed).toBe(false);
      expect((await updateRegistryAliases(h.deps, curator, input)).replayed).toBe(true);
    });

    it("is curator-only", async () => {
      await expect(
        updateRegistryAliases(h.deps, member, {
          clientRequestId: newRequestId(),
          level: "brand",
          id: romeoId,
          add: ["Denied"],
        }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("answers a malformed id exactly as it answers an unknown one", async () => {
      const malformed = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "blend",
        id: "not-a-uuid",
        add: ["Sweep Spelling"],
      }).catch((e: unknown) => e);
      const unknown = await updateRegistryAliases(h.deps, curator, {
        clientRequestId: newRequestId(),
        level: "blend",
        id: newRequestId(),
        add: ["Sweep Spelling"],
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      expect((malformed as ValidationError).fields).toEqual([{ path: "id", message: "No such blend." }]);
    });
  });

  describe("assignCigarTaxonomy", () => {
    let anniversaryLineId: string;
    let maduroBlendId: string;
    let foreignLineId: string;
    let foreignBlendId: string;

    beforeAll(async () => {
      const line = await createLine(h.deps, curator, {
        brandId: padronId,
        name: "Padrón 1964 Anniversary Series",
      });
      anniversaryLineId = line.lineId;
      maduroBlendId = (await createBlend(h.deps, curator, { lineId: anniversaryLineId, name: "Maduro" })).blendId;

      const foreign = await createLine(h.deps, curator, { brandId: drewEstateId, name: "Undercrown" });
      foreignLineId = foreign.lineId;
      foreignBlendId = (await createBlend(h.deps, curator, { lineId: foreignLineId, name: "Shade" })).blendId;
    });

    it("sets the parts, flips to composed and recomposes the name", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "padron 1964 anniv maduro exclusivo" });
      const result = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        brandId: padronId,
        lineId: anniversaryLineId,
        blendId: maduroBlendId,
        vitolaName: "Exclusivo",
        nameSource: "composed",
      });

      // The line repeats its marca, the way trade names do. Composition drops the
      // repeat instead of concatenating `Padrón Padrón` back in.
      expect(result.canonicalName).toBe("Padrón 1964 Anniversary Series Maduro Exclusivo");
      expect(result.composedName).toBe("Padrón 1964 Anniversary Series Maduro Exclusivo");
      expect(result.nameSource).toBe("composed");

      const row = await cigarRow(cigarId);
      expect(row).toMatchObject({
        brandId: padronId,
        lineId: anniversaryLineId,
        blendId: maduroBlendId,
        vitolaName: "Exclusivo",
        nameSource: "composed",
      });
    });

    // A preview records no idempotency key, which is what makes the documented
    // preview-then-commit flow work on one request id.
    it("previews without writing, then commits on the same request id", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Preview Subject Original" });
      const clientRequestId = newRequestId();
      const parts = {
        cigarId,
        brandId: padronId,
        lineId: anniversaryLineId,
        vitolaName: "Principe",
        nameSource: "composed" as const,
      };

      const preview = await assignCigarTaxonomy(h.deps, curator, { clientRequestId, ...parts, preview: true });
      expect(preview.preview).toBe(true);
      expect(preview.composedName).toBe("Padrón 1964 Anniversary Series Principe");
      expect(preview.changedFields).toEqual(
        expect.arrayContaining(["brandId", "lineId", "vitolaName", "nameSource"]),
      );

      const untouched = await cigarRow(cigarId);
      expect(untouched).toMatchObject({
        canonicalName: "Preview Subject Original",
        brandId: null,
        lineId: null,
        nameSource: "freeform",
      });
      expect(await keysFor(clientRequestId)).toHaveLength(0);

      const committed = await assignCigarTaxonomy(h.deps, curator, { clientRequestId, ...parts });
      expect(committed.preview).toBe(false);
      expect(committed.canonicalName).toBe("Padrón 1964 Anniversary Series Principe");
    });

    it("refuses a line belonging to another brand, naming the level at fault", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Crossed Ancestry Subject" });
      const error = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        brandId: padronId,
        lineId: foreignLineId,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields.map((field) => field.path)).toContain("lineId");
      expect((await cigarRow(cigarId)).lineId).toBeNull(); // the refused write never landed
    });

    it("refuses a blend that does not belong to the cigar's line", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Crossed Blend Subject" });
      const error = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        brandId: padronId,
        lineId: anniversaryLineId,
        blendId: foreignBlendId,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields.map((field) => field.path)).toContain("blendId");
    });

    it("re-derives brandId from the free-text marca", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Free Text Marca Subject" });
      await assignCigarTaxonomy(h.deps, curator, { clientRequestId: newRequestId(), cigarId, brand: "Padrón" });
      expect(await cigarRow(cigarId)).toMatchObject({ brand: "Padrón", brandId: padronId });
    });

    // An unrecognised spelling leaves the row unlinked — a worklist item — rather
    // than pointing at the marca the row used to claim.
    it("leaves brandId null for a marca the registry does not know", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: "Unknown Marca Subject",
        brand: "Padrón",
        brandId: padronId,
      });
      await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        brand: "Totally Unknown Marca",
      });
      expect((await cigarRow(cigarId)).brandId).toBeNull();
    });

    // `brandId` is a projection of `brand`, so a caller supplying both is asserting
    // a projection that may not hold.
    it("refuses the marca given both ways", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Double Marca Subject" });
      await expect(
        assignCigarTaxonomy(h.deps, curator, {
          clientRequestId: newRequestId(),
          cigarId,
          brand: "Padrón",
          brandId: padronId,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // THE PREVIEW MUST REFUSE WHAT THE COMMIT REFUSES. Both of these shipped
    // broken in the first cut: the preview returned before the composable check
    // and before the free-text fallback, so a curator dry-running a batch got a
    // clean answer and then a wall of refusals — or a name missing a level the
    // commit would have included. A dry run trusted before 971 rows has to be the
    // answer those rows get.
    it("refuses a preview of a flip the commit would refuse", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Preview Composable Guard", brand: "Nobody" });
      await expect(
        assignCigarTaxonomy(h.deps, curator, {
          clientRequestId: newRequestId(),
          cigarId,
          nameSource: "composed",
          preview: true,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("previews the same name the commit writes when the line is free text", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: "Freetext Line Subject",
        brand: "Padrón",
        line: "Familia Reserva",
      });
      const clientRequestId = newRequestId();
      const parts = { cigarId, brandId: padronId, vitolaName: "No. 46", nameSource: "composed" as const };

      // `lineId` stays null, so both paths must fall back to the `line` column.
      const preview = await assignCigarTaxonomy(h.deps, curator, { clientRequestId, ...parts, preview: true });
      expect(preview.composedName).toBe("Padrón Familia Reserva No. 46");

      const committed = await assignCigarTaxonomy(h.deps, curator, { clientRequestId, ...parts });
      expect(committed.canonicalName).toBe(preview.composedName);
    });

    it("refuses a flip to composed on a row with no marca to compose from", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Nameless Parts Subject" });
      await expect(
        assignCigarTaxonomy(h.deps, curator, { clientRequestId: newRequestId(), cigarId, nameSource: "composed" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("replays an identical retry", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Assign Replay Subject" });
      const input = { clientRequestId: newRequestId(), cigarId, brandId: padronId, lineId: anniversaryLineId };
      expect((await assignCigarTaxonomy(h.deps, curator, input)).replayed).toBe(false);
      expect((await assignCigarTaxonomy(h.deps, curator, input)).replayed).toBe(true);
    });

    // `preview` selects whether the call writes, never what it writes, so it is
    // not part of the intent the fingerprint hashes. A client that sends the flag
    // explicitly on the commit and drops it on the retry is making the same
    // request twice — and meeting an IdempotencyConflictError for it would break
    // exactly the retry the envelope exists to make safe.
    it("replays a retry that omits the preview flag the commit sent as false", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Preview Flag Subject" });
      const clientRequestId = newRequestId();
      const parts = { cigarId, brandId: padronId, lineId: anniversaryLineId, vitolaName: "Exclusivo" };

      const committed = await assignCigarTaxonomy(h.deps, curator, { clientRequestId, ...parts, preview: false });
      expect(committed.replayed).toBe(false);

      const retried = await assignCigarTaxonomy(h.deps, curator, { clientRequestId, ...parts });
      expect(retried.replayed).toBe(true);
      expect(retried.canonicalName).toBe(committed.canonicalName);
      // Replayed, not re-written: one key for the two calls.
      expect(await keysFor(clientRequestId)).toHaveLength(1);
    });

    it("is curator-only", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Assign Denied Subject" });
      await expect(
        assignCigarTaxonomy(h.deps, member, { clientRequestId: newRequestId(), cigarId, brandId: padronId }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("answers a malformed cigarId exactly as it answers an unknown one", async () => {
      const malformed = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId: "not-a-uuid",
        brandId: padronId,
      }).catch((e: unknown) => e);
      const unknown = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId: newRequestId(),
        brandId: padronId,
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(CigarNotFoundError);
      expect((malformed as CigarNotFoundError).toPayload()).toEqual(
        (unknown as CigarNotFoundError).toPayload(),
      );
    });

    // A malformed lineId is answered by the ancestry assertion, through the guard
    // in `loadAncestryContext` — the level could not be resolved, which is what an
    // unknown line has always meant here.
    it("answers a malformed lineId exactly as it answers an unknown one", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Assign Malformed Line Subject" });
      const malformed = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        brandId: padronId,
        lineId: "not-a-uuid",
      }).catch((e: unknown) => e);
      const unknown = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
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

    // The marca is the one level nothing resolves before the write — `brandId` is
    // carried into `namesForAncestry`, which looked it up directly. A preview
    // naming a brand that cannot exist has to behave like one naming a brand that
    // merely does not: no row found, the row's own free text stands in.
    it("previews a malformed brandId exactly as it previews an unknown one", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Preview Malformed Brand Subject" });
      const malformed = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        brandId: "not-a-uuid",
        preview: true,
      });
      const unknown = await assignCigarTaxonomy(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        brandId: newRequestId(),
        preview: true,
      });
      expect(malformed).toEqual(unknown);
      expect(malformed.changedFields).toEqual(["brandId"]);
    });
  });

  describe("splitCigar", () => {
    let vendorId: string;
    let marcaId: string;

    // The evidence a still-linked row carries when the resolver could not re-derive
    // its link. A settled split must not leave it behind reading as a live doubt.
    const staleParse: SuggestedParse = {
      brandId: null,
      brandName: null,
      lineId: null,
      lineName: null,
      blendId: null,
      blendName: null,
      vitolaName: null,
      lengthInches: null,
      ringGauge: null,
      cleanedName: "perdomo bucket listing",
      packaging: null,
      sticksPerPackage: null,
      residue: "",
      notes: [],
      reason: "ambiguous",
    };

    beforeAll(async () => {
      const rows = await h.deps.db
        .insert(vendors)
        .values({ name: "Split Test Vendor" })
        .returning({ id: vendors.id });
      vendorId = rows[0]!.id;
      marcaId = await seedBrand("Perdomo");
    });

    async function seedBucket(name: string, listings: number): Promise<{ cigarId: string; listingIds: string[] }> {
      const cigarId = await h.seedCigar({ canonicalName: name, brand: "Perdomo", brandId: marcaId });
      const listingIds: string[] = [];
      for (let i = 0; i < listings; i++) {
        const rows = await h.deps.db
          .insert(listingMatches)
          .values({
            vendorId,
            listingKey: `split-${newRequestId()}`,
            cigarId,
            status: "auto",
            decidedBy: "crawler",
            suggestedParse: staleParse,
          })
          .returning({ id: listingMatches.id });
        listingIds.push(rows[0]!.id);
      }
      return { cigarId, listingIds };
    }

    const matchRow = async (id: string) =>
      (await h.deps.db.select().from(listingMatches).where(eq(listingMatches.id, id)))[0]!;

    it("re-points the named listings onto minted siblings and leaves the rest alone", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Collapse Bucket", 3);
      const result = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [
          { listingIds: [listingIds[0]!], vitolaName: "Robusto" },
          { listingIds: [listingIds[1]!], vitolaName: "Toro" },
        ],
        attribution: { actor: "agent", runId: "wo-cigar-split" },
      });

      expect(result.splits.map((split) => split.created)).toEqual([true, true]);
      expect(result.splits.map((split) => split.canonicalName)).toEqual(["Perdomo Robusto", "Perdomo Toro"]);
      // Conservative by design: only the listings with unambiguous evidence moved.
      expect(result.remainingListings).toBe(1);

      for (const [index, outcome] of result.splits.entries()) {
        const row = await matchRow(listingIds[index]!);
        expect(row).toMatchObject({ cigarId: outcome.cigarId, status: "confirmed", decidedBy: "agent" });
        expect(row.unmatchedReason).toBeNull();
        expect(row.suggestedParse).toBeNull();
      }

      expect(await matchRow(listingIds[2]!)).toMatchObject({ cigarId, status: "auto", decidedBy: "crawler" });
    });

    it("audits each re-point as an invertible listing_match.set_status", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Audited Bucket", 2);
      const result = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingIds[0]!], vitolaName: "Churchill" }],
      });

      // `applyInverse` reads before.id / before.status / before.cigarId, so carrying
      // the bucket in `before` is what lets a wrong split be walked back listing by
      // listing with no new undo case.
      const repoints = (await auditsFor("listing_match.set_status")).filter(
        (row) => (row.before as { id?: string } | null)?.id === listingIds[0],
      );
      expect(repoints).toHaveLength(1);
      expect(repoints[0]!.before).toMatchObject({ cigarId, status: "auto" });
      expect(repoints[0]!.after).toMatchObject({ cigarId: result.splits[0]!.cigarId, status: "confirmed" });

      const splitAudits = (await auditsFor("cigar.split")).filter(
        (row) => (row.after as { id?: string }).id === cigarId,
      );
      expect(splitAudits).toHaveLength(1);
    });

    it("refuses a listing that does not point at the bucket", async () => {
      const bucket = await seedBucket("Perdomo Foreign Listing Bucket", 1);
      const other = await seedBucket("Perdomo Neighbour Bucket", 1);
      await expect(
        splitCigar(h.deps, curator, {
          clientRequestId: newRequestId(),
          cigarId: bucket.cigarId,
          splits: [{ listingIds: [other.listingIds[0]!], vitolaName: "Robusto" }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // A split is evidence-driven bulk work and must not overturn a verdict somebody
    // already reached — the same predicate the crawler honours on re-crawl.
    it("refuses a listing already decided, naming the decider", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Settled Bucket", 2);
      await h.deps.db
        .update(listingMatches)
        .set({ decidedBy: "curator" })
        .where(eq(listingMatches.id, listingIds[0]!));
      await h.deps.db
        .update(listingMatches)
        .set({ status: "confirmed" })
        .where(eq(listingMatches.id, listingIds[1]!));

      const byCurator = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingIds[0]!], vitolaName: "Robusto" }],
      }).catch((e: unknown) => e);
      expect(byCurator).toBeInstanceOf(ValidationError);
      expect((byCurator as ValidationError).fields[0]!.message).toContain("curator");

      const alreadyConfirmed = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingIds[1]!], vitolaName: "Toro" }],
      }).catch((e: unknown) => e);
      expect(alreadyConfirmed).toBeInstanceOf(ValidationError);
      expect((alreadyConfirmed as ValidationError).fields[0]!.message).toContain("confirmed");
    });

    it("refuses one listing claimed by two targets", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Contested Bucket", 1);
      await expect(
        splitCigar(h.deps, curator, {
          clientRequestId: newRequestId(),
          cigarId,
          splits: [
            { listingIds: [listingIds[0]!], vitolaName: "Robusto" },
            { listingIds: [listingIds[0]!], vitolaName: "Toro" },
          ],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // Splitting a row into a copy of itself would mint the duplicate this wave
    // exists to end, using the tool meant to prevent it.
    it("refuses a new leaf with nothing to distinguish it from the bucket", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Indistinct Bucket", 1);
      await expect(
        splitCigar(h.deps, curator, {
          clientRequestId: newRequestId(),
          cigarId,
          splits: [{ listingIds: [listingIds[0]!] }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses an empty split set, and a target that names no listings", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Empty Bucket", 1);
      await expect(
        splitCigar(h.deps, curator, { clientRequestId: newRequestId(), cigarId, splits: [] }),
      ).rejects.toBeInstanceOf(ValidationError);

      const error = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [
          { listingIds: [listingIds[0]!], vitolaName: "Robusto" },
          { listingIds: [], vitolaName: "Toro" },
        ],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.path).toBe("splits.1.listingIds");
    });

    it("re-points onto an existing sibling without minting one", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Sibling Bucket", 1);
      const siblingId = await h.seedCigar({
        canonicalName: "Perdomo Existing Sibling",
        brand: "Perdomo",
        brandId: marcaId,
      });

      const result = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingIds[0]!], targetCigarId: siblingId }],
      });
      expect(result.splits[0]).toMatchObject({ cigarId: siblingId, created: false });
      expect((await matchRow(listingIds[0]!)).cigarId).toBe(siblingId);
    });

    // All of it lands or none of it does: a bucket with some listings moved and
    // others refused is harder to reason about than one that was never touched.
    it("rolls the whole call back when a later target is invalid", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Atomic Bucket", 2);
      await expect(
        splitCigar(h.deps, curator, {
          clientRequestId: newRequestId(),
          cigarId,
          splits: [
            { listingIds: [listingIds[0]!], vitolaName: "Atomic Robusto" },
            { listingIds: [listingIds[1]!] }, // nothing distinguishes this leaf
          ],
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const stillOnBucket = await h.deps.db
        .select()
        .from(listingMatches)
        .where(eq(listingMatches.cigarId, cigarId));
      expect(stillOnBucket).toHaveLength(2);
      expect(stillOnBucket.every((row) => row.status === "auto")).toBe(true);
      expect(
        await h.deps.db.select().from(cigars).where(eq(cigars.canonicalName, "Perdomo Atomic Robusto")),
      ).toHaveLength(0);
    });

    it("replays an identical retry", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Replay Bucket", 1);
      const input = {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingIds[0]!], vitolaName: "Replay Corona" }],
      };
      const first = await splitCigar(h.deps, curator, input);
      expect(first.replayed).toBe(false);

      const second = await splitCigar(h.deps, curator, input);
      expect(second.replayed).toBe(true);
      expect(second.splits[0]!.cigarId).toBe(first.splits[0]!.cigarId);
      expect(
        await h.deps.db.select().from(cigars).where(eq(cigars.canonicalName, "Perdomo Replay Corona")),
      ).toHaveLength(1);
    });

    it("is curator-only", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Denied Bucket", 1);
      await expect(
        splitCigar(h.deps, member, {
          clientRequestId: newRequestId(),
          cigarId,
          splits: [{ listingIds: [listingIds[0]!], vitolaName: "Robusto" }],
        }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    // ----------------------------------------------------------------------
    // A minted leaf is composable, and at least as structured as its bucket
    // ----------------------------------------------------------------------

    // `Robusto` is a size every marca sells, not a cigar. A leaf named for one is
    // a collapse bucket of a worse kind than the row being split — so the mint
    // path makes the same refusal the assignment path does.
    it("refuses a minted leaf with no marca to compose a name from", async () => {
      const cigarId = await h.seedCigar({ canonicalName: "Unbranded Collapse Bucket" });
      const listing = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `split-${newRequestId()}`, cigarId, status: "auto", decidedBy: "crawler" })
        .returning({ id: listingMatches.id });
      const listingId = listing[0]!.id;

      const error = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingId], vitolaName: "Nameless Robusto" }],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.path).toBe("brandId");
      expect(await h.deps.db.select().from(cigars).where(eq(cigars.canonicalName, "Nameless Robusto"))).toHaveLength(0);

      // The escape hatch, and the only honest one: a curator names the leaf
      // themselves and takes responsibility for the string, which is what
      // `freeform` means.
      const named = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [
          { listingIds: [listingId], vitolaName: "Nameless Robusto", canonicalName: "Nestor Miranda Nameless Robusto" },
        ],
      });
      expect(named.splits[0]).toMatchObject({ canonicalName: "Nestor Miranda Nameless Robusto", created: true });
      expect(await cigarRow(named.splits[0]!.cigarId)).toMatchObject({ nameSource: "freeform" });
    });

    // SPLITTING BY VITOLA SAYS NOTHING ABOUT THE LINE. Reading the omitted level
    // as `null` instead of inheriting it minted a leaf LESS structured than the
    // bucket it came from — a fresh worklist item, made by the tool whose job is
    // to remove them.
    it("gives a minted leaf at least the structure of the bucket it came from", async () => {
      const structuredId = await seedBrand("Structured Marca");
      const reserva = await createLine(h.deps, curator, { brandId: structuredId, name: "Reserva Especial" });
      const cigarId = await h.seedCigar({
        canonicalName: "Structured Marca Reserva Especial",
        brand: "Structured Marca",
        brandId: structuredId,
        lineId: reserva.lineId,
      });
      const rows = await h.deps.db
        .insert(listingMatches)
        .values([
          { vendorId, listingKey: `split-${newRequestId()}`, cigarId, status: "auto" as const, decidedBy: "crawler" as const },
          { vendorId, listingKey: `split-${newRequestId()}`, cigarId, status: "auto" as const, decidedBy: "crawler" as const },
        ])
        .returning({ id: listingMatches.id });

      const result = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [
          { listingIds: [rows[0]!.id], vitolaName: "Torpedo" },
          // An explicit null is the caller saying this one really has no line —
          // the same omitted-vs-null distinction `assign_cigar_taxonomy` draws.
          { listingIds: [rows[1]!.id], lineId: null, vitolaName: "Sin Linea" },
        ],
      });

      expect(result.splits[0]!.canonicalName).toBe("Structured Marca Reserva Especial Torpedo");
      expect(await cigarRow(result.splits[0]!.cigarId)).toMatchObject({
        lineId: reserva.lineId,
        vitolaName: "Torpedo",
        nameSource: "composed",
      });

      expect(result.splits[1]!.canonicalName).toBe("Structured Marca Sin Linea");
      expect(await cigarRow(result.splits[1]!.cigarId)).toMatchObject({ lineId: null, vitolaName: "Sin Linea" });
    });

    // The registry-or-free-text fallback `loadCigarNameParts` reads, mirrored on
    // the mint: a bucket structured only as far as a free-text `line` still knows
    // its line, and the leaf must not be named as though it did not.
    it("carries the bucket's free-text line onto a leaf that has no registry line", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: "Perdomo Champagne",
        brand: "Perdomo",
        brandId: marcaId,
        line: "Champagne",
      });
      const listing = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `split-${newRequestId()}`, cigarId, status: "auto", decidedBy: "crawler" })
        .returning({ id: listingMatches.id });

      const result = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listing[0]!.id], vitolaName: "Epicure" }],
      });

      expect(result.splits[0]!.canonicalName).toBe("Perdomo Champagne Epicure");
      expect(await cigarRow(result.splits[0]!.cigarId)).toMatchObject({ line: "Champagne", lineId: null });
    });

    // ----------------------------------------------------------------------
    // Get-or-create: one identity, one leaf
    // ----------------------------------------------------------------------

    // THE TWIN ROBUSTO. Two arms naming the same product — because the evidence
    // arrived in two batches, or two agents split the same bucket — must converge
    // on one leaf. Minting per arm turns the duplicate-ending tool into a
    // duplicate-making one, and its duplicates are the hardest kind to find: same
    // marca, same parts, same name, differing only in id.
    it("collapses two arms naming the same leaf onto one row", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Twin Bucket", 2);
      const result = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [
          { listingIds: [listingIds[0]!], vitolaName: "Twin Robusto" },
          { listingIds: [listingIds[1]!], vitolaName: "Twin Robusto" },
        ],
      });

      expect(result.splits[0]!.cigarId).toBe(result.splits[1]!.cigarId);
      // One mint, one find — the `register_taxonomy` idiom, so a caller counting
      // new leaves sums `created` and gets 1.
      expect(result.splits.map((split) => split.created)).toEqual([true, false]);
      expect(
        await h.deps.db.select().from(cigars).where(eq(cigars.canonicalName, "Perdomo Twin Robusto")),
      ).toHaveLength(1);

      for (const listingId of listingIds) {
        expect((await matchRow(listingId)).cigarId).toBe(result.splits[0]!.cigarId);
      }
    });

    it("re-points onto an existing leaf rather than minting a second", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Preexisting Bucket", 1);
      const existingId = await h.seedCigar({
        canonicalName: "Perdomo Preexisting Corona",
        brand: "Perdomo",
        brandId: marcaId,
        vitolaName: "Preexisting Corona",
      });

      const result = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingIds[0]!], vitolaName: "Preexisting Corona" }],
      });
      expect(result.splits[0]).toMatchObject({ cigarId: existingId, created: false });
    });

    it("refuses parts that name more than one existing entry, naming them", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Doubled Bucket", 1);
      for (const name of ["Perdomo Doubled Toro A", "Perdomo Doubled Toro B"]) {
        await h.seedCigar({ canonicalName: name, brand: "Perdomo", brandId: marcaId, vitolaName: "Doubled Toro" });
      }

      const error = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingIds[0]!], vitolaName: "Doubled Toro" }],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("Perdomo Doubled Toro A");
      expect((error as ValidationError).fields[0]!.message).toContain("Perdomo Doubled Toro B");
    });

    // Not a get-or-create: re-pointing the bucket's listings at the bucket is a
    // no-op dressed as a split, reported as a leaf that was never made.
    it("refuses an arm that composes to the entry being split", async () => {
      const cigarId = await h.seedCigar({
        canonicalName: "Perdomo Solo Robusto",
        brand: "Perdomo",
        brandId: marcaId,
        vitolaName: "Solo Robusto",
      });
      const listing = await h.deps.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `split-${newRequestId()}`, cigarId, status: "auto", decidedBy: "crawler" })
        .returning({ id: listingMatches.id });

      const error = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listing[0]!.id], vitolaName: "Solo Robusto" }],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.message).toContain("Perdomo Solo Robusto");
    });

    // ----------------------------------------------------------------------
    // A pointed target is a SIBLING, which the tool's own copy already promises
    // ----------------------------------------------------------------------

    // Unbounded, this is a general "move these listings anywhere" verb wearing a
    // split's name — audited as a split and reversible only listing by listing.
    it("refuses a target under another marca, naming both cigars", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Crossed Bucket", 1);
      const foreignId = await h.seedCigar({
        canonicalName: "Undercrown Shade Gordito",
        brand: "Drew Estate",
        brandId: drewEstateId,
      });

      const error = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingIds[0]!], targetCigarId: foreignId }],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields[0]!.path).toBe("splits.0.targetCigarId");
      expect((error as ValidationError).fields[0]!.message).toContain("Undercrown Shade Gordito");
      expect((error as ValidationError).fields[0]!.message).toContain("Perdomo Crossed Bucket");
      expect((await matchRow(listingIds[0]!)).cigarId).toBe(cigarId);
    });

    // An unbranded row is not a sibling of everything; it is a row whose marca
    // nobody has established yet, so a null on either side is refused rather than
    // read as a wildcard.
    it("refuses a target when either side has no marca", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Null Target Bucket", 1);
      const unbrandedId = await h.seedCigar({ canonicalName: "Unbranded Split Target" });
      await expect(
        splitCigar(h.deps, curator, {
          clientRequestId: newRequestId(),
          cigarId,
          splits: [{ listingIds: [listingIds[0]!], targetCigarId: unbrandedId }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // ----------------------------------------------------------------------
    // Undo is a TRUE inverse — the same listing splits again afterwards
    // ----------------------------------------------------------------------

    // A split writes five fields on each listing it re-points: cigar, status,
    // decider, and the two evidence fields it clears because a settled link must
    // not read as a live doubt. An undo restoring only the first two handed the
    // listing back to the bucket stamped `confirmed` by a curator — which the
    // split's own settled-link refusal then reads as somebody's verdict, leaving
    // the bucket unsplittable by the tool that mis-split it.
    it("undoes a re-point completely enough for the same listing to split again", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Undo Bucket", 1);
      const listingId = listingIds[0]!;
      const before = await matchRow(listingId);

      const split = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingId], vitolaName: "Undone Lancero" }],
      });
      const moved = await matchRow(listingId);
      expect(moved).toMatchObject({ cigarId: split.splits[0]!.cigarId, status: "confirmed", decidedBy: "curator" });
      expect(moved.suggestedParse).toBeNull();

      const audits = await h.deps.db
        .select({ id: auditLog.id, before: auditLog.before })
        .from(auditLog)
        .where(eq(auditLog.action, "listing_match.set_status"));
      const repoint = audits.find((row) => (row.before as { id?: string } | null)?.id === listingId);
      expect(repoint).toBeDefined();

      await undoCurationAction(h.deps, curator, { clientRequestId: newRequestId(), auditId: repoint!.id });

      const restored = await matchRow(listingId);
      expect(restored).toMatchObject({ cigarId, status: before.status, decidedBy: before.decidedBy });
      // The resolver's account of why this row was unresolved, back intact —
      // without it the next curator inherits a bare listing and redoes the parse
      // by eye, which is precisely what `suggested_parse` exists to prevent.
      expect(restored.suggestedParse).toEqual(before.suggestedParse);
      expect(restored.unmatchedReason).toBe(before.unmatchedReason);

      // THE ASSERTION THAT MATTERS: the bucket is splittable again. Without the
      // decider restored this call is refused as a settled link.
      const again = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [{ listingIds: [listingId], vitolaName: "Undone Lancero" }],
      });
      // Get-or-create: the leaf minted the first time is found, not duplicated.
      expect(again.splits[0]).toMatchObject({ cigarId: split.splits[0]!.cigarId, created: false });
      expect((await matchRow(listingId)).cigarId).toBe(split.splits[0]!.cigarId);
    });

    it("answers a malformed cigarId exactly as it answers an unknown one", async () => {
      const { listingIds } = await seedBucket("Perdomo Malformed Bucket Id", 1);
      const splits = [{ listingIds: [listingIds[0]!], vitolaName: "Robusto" }];
      const malformed = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId: "not-a-uuid",
        splits,
      }).catch((e: unknown) => e);
      const unknown = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId: newRequestId(),
        splits,
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(CigarNotFoundError);
      expect((malformed as CigarNotFoundError).toPayload()).toEqual(
        (unknown as CigarNotFoundError).toPayload(),
      );
    });

    it("answers a malformed targetCigarId exactly as an unknown one, on the arm that named it", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Malformed Target Bucket", 2);
      const armsWith = (targetCigarId: string) => [
        { listingIds: [listingIds[0]!], vitolaName: "Target Path Robusto" },
        { listingIds: [listingIds[1]!], targetCigarId },
      ];
      const malformed = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: armsWith("not-a-uuid"),
      }).catch((e: unknown) => e);
      const unknown = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: armsWith(newRequestId()),
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).toPayload()).toEqual((unknown as ValidationError).toPayload());
      // The per-index path is the whole value of the message — it points the
      // curator at the arm they got wrong, not at "the split".
      expect((malformed as ValidationError).fields).toEqual([
        { path: "splits.1.targetCigarId", message: "No such cigar." },
      ]);
    });

    // THE ONE THAT WAS COSTING THE MOST. Every named listing is read in a single
    // `inArray(...)` probe, so one malformed id in one arm raised 22P02 for the
    // whole call — a multi-arm split answering a 500 where the code already had a
    // precise, per-id refusal to give.
    it("names the one malformed listing id rather than failing the whole split", async () => {
      const { cigarId, listingIds } = await seedBucket("Perdomo Malformed Listing Bucket", 2);
      const malformed = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [
          { listingIds: [listingIds[0]!], vitolaName: "Listing Path Robusto" },
          { listingIds: ["not-a-uuid"], vitolaName: "Listing Path Toro" },
        ],
      }).catch((e: unknown) => e);
      expect(malformed).toBeInstanceOf(ValidationError);
      expect((malformed as ValidationError).fields).toEqual([
        { path: "splits", message: "No listing match matches id not-a-uuid." },
      ]);

      // Word for word what an unknown-but-valid id is answered with, the id being
      // the only difference — which is the point: the refusal names the offender.
      const ghost = newRequestId();
      const unknown = await splitCigar(h.deps, curator, {
        clientRequestId: newRequestId(),
        cigarId,
        splits: [
          { listingIds: [listingIds[0]!], vitolaName: "Listing Path Robusto" },
          { listingIds: [ghost], vitolaName: "Listing Path Toro" },
        ],
      }).catch((e: unknown) => e);
      expect(unknown).toBeInstanceOf(ValidationError);
      expect((unknown as ValidationError).fields).toEqual([
        { path: "splits", message: `No listing match matches id ${ghost}.` },
      ]);

      // And the good arm did not half-apply: a split lands whole or not at all.
      expect((await matchRow(listingIds[0]!)).cigarId).toBe(cigarId);
      expect(
        await h.deps.db.select().from(cigars).where(eq(cigars.canonicalName, "Perdomo Listing Path Robusto")),
      ).toHaveLength(0);
    });
  });
});
