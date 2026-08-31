import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, blendBlenders, blends, brands, cigars, lines } from "@cj/db";
import { createHarness, newRequestId, type DomainHarness } from "./testing/harness.js";
import { brandSlug } from "./catalog-browse.js";
import { fold } from "./taxonomy-keys.js";
import {
  createLine,
  addLineAliases,
  createBlend,
  addBlendAliases,
  createBlender,
  creditBlender,
  assignCigarParts,
  aliasKeysFor,
} from "./taxonomy-writes.js";
import { renameCigar, setCigarFacts } from "./curation.js";
import { resolveCigar } from "./cigar-resolution.js";
import { updateCigar } from "./update-cigar.js";
import { ValidationError, UnauthorizedError } from "./errors.js";
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
    it("derives folded keys and keeps the row's own slug", () => {
      expect(aliasKeysFor("Padrón")).toEqual(["padr-n", "padron"]);
      expect(aliasKeysFor("Liga Privada")).toEqual(["liga-privada"]);
      expect(aliasKeysFor("No. 9", ["Number 9"])).toEqual(["no-9", "number-9"]);
    });
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
      expect(await auditsFor("line.add_aliases")).toHaveLength(1);
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
});
