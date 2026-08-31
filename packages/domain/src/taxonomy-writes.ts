import { eq, sql } from "drizzle-orm";
import { auditLog, blendBlenders, blenders, blends, brands, cigars, lines } from "@cj/db";
import type { Deps, Principal, Queryer, Tx } from "./deps.js";
import { CigarNotFoundError, UnauthorizedError, ValidationError } from "./errors.js";
import { auditActor } from "./audit-attribution.js";
import { HIERARCHY_UNFILED } from "./types.js";
import { brandSlug } from "./catalog-browse.js";
import { composeCanonicalName, fold } from "./taxonomy-keys.js";
import { assertCigarAncestry, type CigarAncestry } from "./cigar-ancestry.js";
import { loadAncestryContext } from "./taxonomy-resolve.js";

// Registry writes and name recomposition (ADR-012, issue #196 Wave 2).
//
// DOMAIN ONLY THIS WAVE. There is no MCP tool behind any of these — the curation
// surfaces that call them are Wave 3 and the tool contract they would need is
// Wave 4. They exist now because matching v2 and its tests need a way to put a
// line or a blend into the registries that goes through the same validation a
// curator eventually will, rather than a raw INSERT that could seed an alias
// convention the matcher cannot read.
//
// They are audited but they carry NO idempotency envelope: the envelope is keyed
// on an MCP `clientRequestId`, and inventing one for a caller that has none would
// bake a fake request identity into the audit trail. Wave 3 adds the envelope
// with the tool.

export interface RegistryAttribution {
  actor?: "web" | "agent";
  runId?: string;
  confidence?: number;
  correlationId?: string;
}

function assertCurator(principal: Principal): void {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Registry curation is restricted to catalog curators.");
  }
}

function auditAttribution(principal: Principal, given: RegistryAttribution | undefined) {
  const actor = given?.actor ?? "web";
  return {
    ...auditActor(principal, actor),
    actor,
    runId: given?.runId ?? null,
    confidence: given?.confidence ?? null,
  };
}

// The alias convention, in one place, exactly as migration 0026 seeds it:
// MATCHING KEYS ONLY. Every entry is fold() output — the output of the same
// normalization the matcher runs over an incoming vendor string — so the anchor
// probe is one exact-match GIN lookup. A display spelling stored here would
// simply never be probed for, which is a silent failure rather than a loud one,
// so the keys are derived rather than accepted from the caller.
//
// The row's own slug rides along for the same reason 0026 includes it on brands:
// the probe alone then resolves every spelling the row answers to, with no second
// lookup against `slug`. For an ASCII name the two collapse to one key.
export function aliasKeysFor(name: string, extra: readonly string[] = []): string[] {
  const keys = [brandSlug(name.trim()), fold(name), ...extra.map((value) => fold(value))];
  return [...new Set(keys)].filter((key) => key !== "").sort();
}

function requireName(value: string, path: string): string {
  const name = value.trim();
  if (name === "") throw new ValidationError([{ path, message: "A name is required." }]);
  return name;
}

// `unfiled` is not available as a registry slug (DESIGN-004 D-05). At every
// level that value means IS NULL — the population with NO row here — so a row
// wearing it would be permanently unreachable: `?line=unfiled` would select the
// cigars that have no line, never the line called Unfiled, and the group card
// for it would link to a screen excluding all of its own members.
//
// The suffix, not a refusal: "Unfiled" is a legitimate name and the catalog's
// internal vocabulary has no business vetoing it. The slug is a derived
// addressing key, so deriving a different one costs the row nothing — while
// refusing would put the reserved word in front of a curator who never chose it.
// `-1` is the conventional disambiguation suffix and cannot itself fold onto the
// reserved word; a second row that genuinely wants `unfiled-1` still hits the
// per-parent unique pre-check below, which is where slug collisions belong.
export const RESERVED_SLUG_SUFFIX = "-1";

export function mintRegistrySlug(name: string): string {
  const slug = brandSlug(name.trim());
  return slug === HIERARCHY_UNFILED ? `${slug}${RESERVED_SLUG_SUFFIX}` : slug;
}

// The refusal that backs the mint. `mintRegistrySlug` never produces the
// reserved slug, so on today's paths this is unreachable — deliberately. It is
// the second line: the create paths refuse the value rather than trusting that
// every future caller reached them through the minter, and a path that accepts a
// curator-supplied slug (none does yet) must call it.
//
// Exported for that reason and for its own test. An unreachable guard that
// nothing can exercise is a guard nobody can trust, and this one protects an
// invariant — a registry row must never wear a slug that means "the rows with no
// registry row" — whose violation is silent: the row simply becomes unreachable.
//
// The database CHECK constraint that would make this true for every writer,
// including raw SQL, rides the next migration; until then these two functions are
// the whole enforcement (noted as debt in PR #215).
export function assertSlugMintable(slug: string, path: string): void {
  if (slug === HIERARCHY_UNFILED) {
    throw new ValidationError([
      {
        path,
        message: `The slug '${HIERARCHY_UNFILED}' is reserved for the catalog's unfiled population.`,
      },
    ]);
  }
}

function requireSlug(name: string, path: string): string {
  const slug = mintRegistrySlug(name);
  if (slug === "") {
    throw new ValidationError([
      { path, message: "This name has no addressable slug — it is punctuation only." },
    ]);
  }
  assertSlugMintable(slug, path);
  return slug;
}

// An alias must resolve to exactly ONE row within its scope, or the anchor probe
// it exists to serve is worse than no index at all (0026's collision pass makes
// the same argument for brands). Checked before the write rather than repaired
// after, because a curator can fix the spelling they just typed and a nightly
// collision sweep cannot.
async function assertAliasesFree(
  tx: Tx,
  table: "lines" | "blends" | "blenders",
  scope: { column: "brand_id" | "line_id"; value: string } | null,
  keys: string[],
  path: string,
): Promise<void> {
  if (keys.length === 0) return;
  const scoped =
    scope === null
      ? sql``
      : scope.column === "brand_id"
        ? sql`brand_id = ${scope.value} AND `
        : sql`line_id = ${scope.value} AND `;
  const table_ = table === "lines" ? sql`lines` : table === "blends" ? sql`blends` : sql`blenders`;
  const result = await tx.execute(sql`
    SELECT name, aliases FROM ${table_} WHERE ${scoped}aliases && ${sql.param(keys)}::text[] LIMIT 1
  `);
  const clash = (result.rows as unknown as { name: string; aliases: string[] }[])[0];
  if (clash) {
    const key = keys.find((candidate) => clash.aliases.includes(candidate)) ?? keys[0]!;
    throw new ValidationError([
      { path, message: `The matching key '${key}' is already claimed by '${clash.name}'.` },
    ]);
  }
}

// --------------------------------------------------------------------------
// Lines
// --------------------------------------------------------------------------

export interface CreateLineInput {
  brandId: string;
  name: string;
  aliases?: string[];
  description?: string | null;
  attribution?: RegistryAttribution;
}

export interface CreateLineResult {
  lineId: string;
  slug: string;
  aliases: string[];
}

export async function createLine(
  deps: Deps,
  principal: Principal,
  input: CreateLineInput,
): Promise<CreateLineResult> {
  assertCurator(principal);
  const name = requireName(input.name, "name");
  const slug = requireSlug(name, "name");
  const aliases = aliasKeysFor(name, input.aliases ?? []);

  return deps.db.transaction(async (tx) => {
    const brand = await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, input.brandId)).limit(1);
    if (!brand[0]) throw new ValidationError([{ path: "brandId", message: "No such brand." }]);

    // Scoped to the brand, not global: two brands may both have a `reserva` and
    // neither has to yield the name (0026's `lines_brand_id_slug_key`).
    const existing = await tx.execute(sql`
      SELECT name FROM lines WHERE brand_id = ${input.brandId} AND slug = ${slug} LIMIT 1
    `);
    if (existing.rows.length > 0) {
      throw new ValidationError([{ path: "name", message: "This brand already has a line with that slug." }]);
    }
    await assertAliasesFree(tx, "lines", { column: "brand_id", value: input.brandId }, aliases, "aliases");

    const inserted = await tx
      .insert(lines)
      .values({
        brandId: input.brandId,
        name,
        slug,
        aliases,
        description: input.description ?? null,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      })
      .returning({ id: lines.id });
    const lineId = inserted[0]!.id;

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "line.create",
      smokeId: null,
      before: null,
      after: { id: lineId, brandId: input.brandId, name, slug, aliases },
      correlationId: input.attribution?.correlationId ?? null,
    });

    return { lineId, slug, aliases };
  });
}

export interface AddAliasesInput {
  id: string;
  aliases: string[];
  attribution?: RegistryAttribution;
}

export interface AddAliasesResult {
  aliases: string[];
  added: string[];
}

// Add matching keys to a line. The caller passes SPELLINGS; this derives the keys,
// because a caller that passed a display string would create an alias nothing can
// ever probe for.
export async function addLineAliases(
  deps: Deps,
  principal: Principal,
  input: AddAliasesInput,
): Promise<AddAliasesResult> {
  assertCurator(principal);
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: lines.id, brandId: lines.brandId, name: lines.name, aliases: lines.aliases })
      .from(lines)
      .where(eq(lines.id, input.id))
      .limit(1);
    const line = rows[0];
    if (!line) throw new ValidationError([{ path: "id", message: "No such line." }]);

    const requested = aliasKeysFor("", input.aliases);
    const added = requested.filter((key) => !line.aliases.includes(key));
    if (added.length === 0) return { aliases: line.aliases, added: [] };

    await assertAliasesFree(tx, "lines", { column: "brand_id", value: line.brandId }, added, "aliases");

    const next = [...new Set([...line.aliases, ...added])].sort();
    await tx.update(lines).set({ aliases: next, updatedAt: deps.now() }).where(eq(lines.id, line.id));
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "line.add_aliases",
      smokeId: null,
      before: { id: line.id, aliases: line.aliases },
      after: { id: line.id, aliases: next },
      correlationId: input.attribution?.correlationId ?? null,
    });
    return { aliases: next, added };
  });
}

// --------------------------------------------------------------------------
// Blends
// --------------------------------------------------------------------------

export interface CreateBlendInput {
  lineId: string;
  name: string;
  aliases?: string[];
  wrapper?: string | null;
  binder?: string | null;
  filler?: string | null;
  strength?: string | null;
  blendNotes?: string | null;
  attribution?: RegistryAttribution;
}

export interface CreateBlendResult {
  blendId: string;
  slug: string;
  aliases: string[];
}

export async function createBlend(
  deps: Deps,
  principal: Principal,
  input: CreateBlendInput,
): Promise<CreateBlendResult> {
  assertCurator(principal);
  const name = requireName(input.name, "name");
  const slug = requireSlug(name, "name");
  const aliases = aliasKeysFor(name, input.aliases ?? []);

  return deps.db.transaction(async (tx) => {
    // The ancestry check for a registry write: the parent must exist. A blend
    // whose line is unresolvable is the registry-level form of the violation
    // `assertCigarAncestry` refuses on the leaf.
    const line = await tx.select({ id: lines.id }).from(lines).where(eq(lines.id, input.lineId)).limit(1);
    if (!line[0]) throw new ValidationError([{ path: "lineId", message: "No such line." }]);

    const existing = await tx.execute(sql`
      SELECT name FROM blends WHERE line_id = ${input.lineId} AND slug = ${slug} LIMIT 1
    `);
    if (existing.rows.length > 0) {
      throw new ValidationError([{ path: "name", message: "This line already has a blend with that slug." }]);
    }
    await assertAliasesFree(tx, "blends", { column: "line_id", value: input.lineId }, aliases, "aliases");

    const inserted = await tx
      .insert(blends)
      .values({
        lineId: input.lineId,
        name,
        slug,
        aliases,
        // Wrapper/binder/filler are a required DOCUMENTATION TARGET, not a
        // required argument (ADR-012, owner ruling 2026-08-31): enrichment
        // pursues them and a worklist tracks the gaps. NULL keeps meaning "not
        // yet known" and is never filled to satisfy the target.
        wrapper: input.wrapper ?? null,
        binder: input.binder ?? null,
        filler: input.filler ?? null,
        strength: input.strength ?? null,
        blendNotes: input.blendNotes ?? null,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      })
      .returning({ id: blends.id });
    const blendId = inserted[0]!.id;

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "blend.create",
      smokeId: null,
      before: null,
      after: { id: blendId, lineId: input.lineId, name, slug, aliases },
      correlationId: input.attribution?.correlationId ?? null,
    });

    return { blendId, slug, aliases };
  });
}

export async function addBlendAliases(
  deps: Deps,
  principal: Principal,
  input: AddAliasesInput,
): Promise<AddAliasesResult> {
  assertCurator(principal);
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: blends.id, lineId: blends.lineId, aliases: blends.aliases })
      .from(blends)
      .where(eq(blends.id, input.id))
      .limit(1);
    const blend = rows[0];
    if (!blend) throw new ValidationError([{ path: "id", message: "No such blend." }]);

    const requested = aliasKeysFor("", input.aliases);
    const added = requested.filter((key) => !blend.aliases.includes(key));
    if (added.length === 0) return { aliases: blend.aliases, added: [] };

    await assertAliasesFree(tx, "blends", { column: "line_id", value: blend.lineId }, added, "aliases");

    const next = [...new Set([...blend.aliases, ...added])].sort();
    await tx.update(blends).set({ aliases: next, updatedAt: deps.now() }).where(eq(blends.id, blend.id));
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "blend.add_aliases",
      smokeId: null,
      before: { id: blend.id, aliases: blend.aliases },
      after: { id: blend.id, aliases: next },
      correlationId: input.attribution?.correlationId ?? null,
    });
    return { aliases: next, added };
  });
}

// --------------------------------------------------------------------------
// Blenders
// --------------------------------------------------------------------------

export interface CreateBlenderInput {
  name: string;
  aliases?: string[];
  attribution?: RegistryAttribution;
}

export interface CreateBlenderResult {
  blenderId: string;
  slug: string;
  aliases: string[];
}

// Global rather than per-brand, because a blender's work spans brands and
// collaborations exist (ADR-012 amendment). Cuban blends credit no individual;
// that is a fact about the industry, so no row and no credit edge is the normal
// case there, never a gap to fill.
export async function createBlender(
  deps: Deps,
  principal: Principal,
  input: CreateBlenderInput,
): Promise<CreateBlenderResult> {
  assertCurator(principal);
  const name = requireName(input.name, "name");
  const slug = requireSlug(name, "name");
  const aliases = aliasKeysFor(name, input.aliases ?? []);

  return deps.db.transaction(async (tx) => {
    const existing = await tx.select({ id: blenders.id }).from(blenders).where(eq(blenders.slug, slug)).limit(1);
    if (existing[0]) throw new ValidationError([{ path: "name", message: "A blender with that slug exists." }]);
    await assertAliasesFree(tx, "blenders", null, aliases, "aliases");

    const inserted = await tx
      .insert(blenders)
      .values({ name, slug, aliases, createdAt: deps.now(), updatedAt: deps.now() })
      .returning({ id: blenders.id });
    const blenderId = inserted[0]!.id;

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "blender.create",
      smokeId: null,
      before: null,
      after: { id: blenderId, name, slug, aliases },
      correlationId: input.attribution?.correlationId ?? null,
    });

    return { blenderId, slug, aliases };
  });
}

export async function addBlenderAliases(
  deps: Deps,
  principal: Principal,
  input: AddAliasesInput,
): Promise<AddAliasesResult> {
  assertCurator(principal);
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: blenders.id, aliases: blenders.aliases })
      .from(blenders)
      .where(eq(blenders.id, input.id))
      .limit(1);
    const blender = rows[0];
    if (!blender) throw new ValidationError([{ path: "id", message: "No such blender." }]);

    const requested = aliasKeysFor("", input.aliases);
    const added = requested.filter((key) => !blender.aliases.includes(key));
    if (added.length === 0) return { aliases: blender.aliases, added: [] };

    await assertAliasesFree(tx, "blenders", null, added, "aliases");

    const next = [...new Set([...blender.aliases, ...added])].sort();
    await tx.update(blenders).set({ aliases: next, updatedAt: deps.now() }).where(eq(blenders.id, blender.id));
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "blender.add_aliases",
      smokeId: null,
      before: { id: blender.id, aliases: blender.aliases },
      after: { id: blender.id, aliases: next },
      correlationId: input.attribution?.correlationId ?? null,
    });
    return { aliases: next, added };
  });
}

export interface CreditBlenderInput {
  blendId: string;
  blenderId: string;
  attribution?: RegistryAttribution;
}

// Credit the blend, not the brand: Willy Herrera has been Drew Estate's master
// blender since 2011, but Liga Privada (2007) was Steve Saka's, with Jonathan
// Drew and Nicholas Melillo (docs/ddd/cigar-industry-vocabulary.md).
export async function creditBlender(
  deps: Deps,
  principal: Principal,
  input: CreditBlenderInput,
): Promise<{ created: boolean }> {
  assertCurator(principal);
  return deps.db.transaction(async (tx) => {
    const blend = await tx.select({ id: blends.id }).from(blends).where(eq(blends.id, input.blendId)).limit(1);
    if (!blend[0]) throw new ValidationError([{ path: "blendId", message: "No such blend." }]);
    const blender = await tx
      .select({ id: blenders.id })
      .from(blenders)
      .where(eq(blenders.id, input.blenderId))
      .limit(1);
    if (!blender[0]) throw new ValidationError([{ path: "blenderId", message: "No such blender." }]);

    const inserted = await tx
      .insert(blendBlenders)
      .values({ blendId: input.blendId, blenderId: input.blenderId, createdAt: deps.now() })
      .onConflictDoNothing()
      .returning({ blendId: blendBlenders.blendId });
    if (inserted.length === 0) return { created: false };

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "blend.credit_blender",
      smokeId: null,
      before: null,
      after: { blendId: input.blendId, blenderId: input.blenderId },
      correlationId: input.attribution?.correlationId ?? null,
    });
    return { created: true };
  });
}

// --------------------------------------------------------------------------
// Name recomposition — the `composed` half of `cigars.name_source`.
// --------------------------------------------------------------------------

export interface CigarNameParts {
  brand: string | null;
  line: string | null;
  blend: string | null;
  vitola: string | null;
  edition: string | null;
}

// Read a leaf's name parts, preferring the REGISTRY spelling over the free-text
// column at every level that has one. That preference is the point of composing:
// the registry is the single spelling the whole catalog agrees on, so a composed
// name cannot drift the way 36 independently-typed brand strings did.
export async function loadCigarNameParts(db: Queryer, cigarId: string): Promise<CigarNameParts | null> {
  const result = await db.execute(sql`
    SELECT c.brand, c.line, c.vitola_name, c.edition,
           b.name AS brand_name, l.name AS line_name, bl.name AS blend_name
    FROM cigars c
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN lines l ON l.id = c.line_id
    LEFT JOIN blends bl ON bl.id = c.blend_id
    WHERE c.id = ${cigarId}
    LIMIT 1
  `);
  const row = (
    result.rows as unknown as {
      brand: string | null;
      line: string | null;
      vitola_name: string | null;
      edition: string | null;
      brand_name: string | null;
      line_name: string | null;
      blend_name: string | null;
    }[]
  )[0];
  if (!row) return null;
  return {
    brand: row.brand_name ?? row.brand,
    line: row.line_name ?? row.line,
    blend: row.blend_name,
    vitola: row.vitola_name,
    edition: row.edition,
  };
}

// Recompose a `composed` row's `canonical_name` from its parts. Call this from
// EVERY path that changes a part — a composed name that no longer reflects its
// parts is worse than a freeform one, because it looks maintained.
//
// A no-op on a `freeform` row: that string is authoritative and nothing may
// rewrite it behind the owner's back. A composed row whose parts compose to
// nothing is also left alone rather than blanked — `canonical_name` is NOT NULL
// and a nameless catalog row helps no one.
export async function recomposeCigarName(
  tx: Tx,
  cigarId: string,
  now: Date,
): Promise<{ changed: boolean; canonicalName: string | null }> {
  const rows = await tx
    .select({ canonicalName: cigars.canonicalName, nameSource: cigars.nameSource })
    .from(cigars)
    .where(eq(cigars.id, cigarId))
    .limit(1);
  const current = rows[0];
  if (!current || current.nameSource !== "composed") return { changed: false, canonicalName: null };

  const parts = await loadCigarNameParts(tx, cigarId);
  if (!parts) return { changed: false, canonicalName: null };

  const composed = composeCanonicalName(parts);
  if (composed === "" || composed === current.canonicalName) {
    return { changed: false, canonicalName: current.canonicalName };
  }

  await tx.update(cigars).set({ canonicalName: composed, updatedAt: now }).where(eq(cigars.id, cigarId));
  return { changed: true, canonicalName: composed };
}

export interface AssignCigarPartsInput {
  cigarId: string;
  // Present keys are written; `null` is a deliberate clear; an omitted key is
  // untouched. The three FKs move together often enough (a re-parent) that they
  // are validated as one ancestry rather than one at a time.
  brandId?: string | null;
  lineId?: string | null;
  blendId?: string | null;
  vitolaName?: string | null;
  edition?: string | null;
  // Flip the name's authority. `composed` recomposes `canonical_name` from the
  // parts on this write and on every later part change; `freeform` hands the
  // string back to `renameCigar`.
  nameSource?: "freeform" | "composed";
  attribution?: RegistryAttribution;
}

export interface AssignCigarPartsResult {
  cigarId: string;
  canonicalName: string;
  nameSource: "freeform" | "composed";
  changedFields: string[];
}

// THE PART-ASSIGNMENT PATH — the one place that writes `line_id` and `blend_id`,
// and therefore the one place `assertCigarAncestry` has real work to do.
//
// This is also where `name_source` flips, folded in rather than given its own
// verb: flipping a row to `composed` without its parts being right produces a
// wrong name, and setting the parts without flipping leaves the row's name stale.
// One audited write does both, so the two can never disagree.
export async function assignCigarParts(
  deps: Deps,
  principal: Principal,
  input: AssignCigarPartsInput,
): Promise<AssignCigarPartsResult> {
  assertCurator(principal);

  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: cigars.id,
        canonicalName: cigars.canonicalName,
        brandId: cigars.brandId,
        lineId: cigars.lineId,
        blendId: cigars.blendId,
        vitolaName: cigars.vitolaName,
        edition: cigars.edition,
        nameSource: cigars.nameSource,
      })
      .from(cigars)
      .where(eq(cigars.id, input.cigarId))
      .limit(1);
    const current = rows[0];
    if (!current) throw new CigarNotFoundError();

    const next: CigarAncestry = {
      brandId: input.brandId === undefined ? current.brandId : input.brandId,
      lineId: input.lineId === undefined ? current.lineId : input.lineId,
      blendId: input.blendId === undefined ? current.blendId : input.blendId,
    };

    // Ancestry is checked against the ROW SET THAT WOULD RESULT, not against the
    // fields supplied: a caller clearing `lineId` while leaving `blendId` in
    // place is describing an inconsistent cigar even though it named only one
    // level.
    assertCigarAncestry(next, await loadAncestryContext(tx, next));

    const set: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const changedFields: string[] = [];

    const candidates: [string, string, unknown, unknown][] = [
      ["brandId", "brandId", current.brandId, next.brandId],
      ["lineId", "lineId", current.lineId, next.lineId],
      ["blendId", "blendId", current.blendId, next.blendId],
      ["vitolaName", "vitolaName", current.vitolaName, input.vitolaName === undefined ? current.vitolaName : input.vitolaName],
      ["edition", "edition", current.edition, input.edition === undefined ? current.edition : input.edition],
      ["nameSource", "nameSource", current.nameSource, input.nameSource ?? current.nameSource],
    ];
    for (const [key, column, from, to] of candidates) {
      if (from === to) continue;
      set[column] = to;
      before[key] = from;
      after[key] = to;
      changedFields.push(key);
    }

    const nameSource = (input.nameSource ?? current.nameSource) as "freeform" | "composed";
    if (nameSource === "composed" && next.brandId == null) {
      throw new ValidationError([
        { path: "brandId", message: "A composed name needs at least a brand to compose from." },
      ]);
    }

    if (changedFields.length === 0) {
      return {
        cigarId: current.id,
        canonicalName: current.canonicalName,
        nameSource: current.nameSource,
        changedFields: [],
      };
    }

    await tx.update(cigars).set({ ...set, updatedAt: deps.now() }).where(eq(cigars.id, current.id));
    const recomposed = await recomposeCigarName(tx, current.id, deps.now());

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditAttribution(principal, input.attribution),
      action: "cigar.assign_parts",
      smokeId: null,
      before: { id: current.id, ...before, canonicalName: current.canonicalName },
      after: { id: current.id, ...after, canonicalName: recomposed.canonicalName ?? current.canonicalName },
      correlationId: input.attribution?.correlationId ?? null,
    });

    return {
      cigarId: current.id,
      canonicalName: recomposed.canonicalName ?? current.canonicalName,
      nameSource,
      changedFields,
    };
  });
}
