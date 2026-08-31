import { eq, sql } from "drizzle-orm";
import { auditLog, blendBlenders, blenders, blends, brands, cigars, lines } from "@cj/db";
import type { Deps, Principal, Queryer, Tx } from "./deps.js";
import { CigarNotFoundError, UnauthorizedError, ValidationError } from "./errors.js";
import { auditActor } from "./audit-attribution.js";
import { brandSlug } from "./catalog-browse.js";
import { composeCanonicalName, fold } from "./taxonomy-keys.js";
import { assertCigarAncestry, type CigarAncestry } from "./cigar-ancestry.js";
import { deriveBrandId, loadAncestryContext } from "./taxonomy-resolve.js";

// Registry writes and name recomposition (ADR-012, issue #196 Wave 2).
//
// These are the PRIMITIVES: one audited registry write each, no idempotency
// envelope. The envelope is keyed on an MCP `clientRequestId`, and inventing one
// for a caller that has none would bake a fake request identity into the audit
// trail — so it belongs to the tool, not to the write.
//
// WAVE 3 ADDED THE TOOLS (taxonomy-curation.ts) and, with them, that envelope.
// Rather than fork a second implementation of each write, every primitive below
// is split in two: a `*WithinTx` core that does the work on a caller's
// transaction, and the thin exported function that opens one. The enveloped
// curation services call the cores, so a rule fixed here is fixed for both
// surfaces and the two can never drift on what a valid registry write is.
//
// Direct callers of the thin wrappers (matching-v2 tests, the crawler's seed
// fixtures) are unchanged and still get exactly one transaction per call.

export interface RegistryAttribution {
  actor?: "web" | "agent";
  runId?: string;
  confidence?: number;
  correlationId?: string;
}

export function assertCurator(principal: Principal): void {
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

function requireSlug(name: string, path: string): string {
  const slug = brandSlug(name);
  if (slug === "") {
    throw new ValidationError([
      { path, message: "This name has no addressable slug — it is punctuation only." },
    ]);
  }
  return slug;
}

export type RegistryLevel = "brand" | "line" | "blend" | "blender";

// The table each level lives in, as one map rather than a chain of ternaries.
// Every generic path below (alias edits, collision checks) reads this, so a level
// added here is a level the whole surface handles.
const LEVEL_TABLE: Record<RegistryLevel, ReturnType<typeof sql>> = {
  brand: sql`brands`,
  line: sql`lines`,
  blend: sql`blends`,
  blender: sql`blenders`,
};

// The scope an alias must be unique WITHIN, per level. Brands and blenders are
// global — a key that resolves to two marcas is unresolvable no matter which page
// you are on — while a line is unique within its brand and a blend within its
// line, which is what lets two marcas each own a `reserva`.
export type AliasScope = { column: "brand_id" | "line_id"; value: string } | null;

// An alias must resolve to exactly ONE row within its scope, or the anchor probe
// it exists to serve is worse than no index at all (0026's collision pass makes
// the same argument for brands). Checked before the write rather than repaired
// after, because a curator can fix the spelling they just typed and a nightly
// collision sweep cannot.
export async function assertAliasesFree(
  tx: Tx,
  level: RegistryLevel,
  scope: AliasScope,
  keys: string[],
  path: string,
  exceptId?: string,
): Promise<void> {
  if (keys.length === 0) return;

  // THE CHECK IS A READ AND THE CLAIM IS A WRITE, and nothing in the schema
  // joins them: `aliases` is a plain text[] with a GIN index and no unique
  // constraint, so two transactions minting `Fóldy` and `Foldy` in the same
  // moment — different slugs, one folded key `foldy` — both read a clean table,
  // both pass this check, and both commit. The result is a matching key claimed
  // by two rows, which is exactly the ambiguity this function exists to refuse,
  // and it fails SILENTLY: `anchorByAlias` drops a key that resolves to more
  // than one candidate, so the pair simply stops being findable by the spelling
  // they fought over.
  //
  // So take a transaction-scoped advisory lock on every key being claimed before
  // reading. The second writer parks here until the first COMMITs, then reads
  // the row it would have collided with and refuses it by name — a curator sees
  // "already claimed by 'Fóldy'" instead of forking the marca. Three properties
  // make that safe: the keys are locked in SORTED order, so two callers claiming
  // overlapping sets acquire in the same sequence and cannot deadlock each other
  // (sorted HERE, not trusted from the caller — `aliasKeysFor` sorts but
  // `editRegistryAliasesWithinTx` passes a filtered `added`); the namespace is
  // `level:key`, so a brand's `padron` never contends with a line's; and
  // `pg_advisory_xact_lock` releases at COMMIT or ROLLBACK, so the refusal path
  // above leaks no lock and needs no unlock. Two keys that share a `hashtext`
  // value, or two brands both claiming a line key `reserva`, serialize when they
  // need not — extra waiting, never a missed guarantee.
  //
  // THIS ONLY SERIALIZES WRITERS THAT COME THROUGH HERE. An advisory lock is
  // invisible to a writer that never takes it, so the durable form of this
  // guarantee is a unique side-table keyed on (level, scope, key) with the alias
  // claim as an insert into it — the database refusing the second claim rather
  // than this function doing it. Reach for that the day aliases start being
  // written outside the domain layer: a backfill script, a migration, a second
  // service.
  for (const key of [...keys].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${level}:${key}`}::text))`);
  }

  const scoped =
    scope === null
      ? sql``
      : scope.column === "brand_id"
        ? sql`brand_id = ${scope.value} AND `
        : sql`line_id = ${scope.value} AND `;
  // A row never collides with ITSELF. Re-asserting a key a row already holds is
  // how an idempotent replay and a get-or-create both arrive here, and refusing
  // those would make the safe operations the unsafe ones.
  const notSelf = exceptId === undefined ? sql`` : sql`id <> ${exceptId}::uuid AND `;
  const result = await tx.execute(sql`
    SELECT name, aliases FROM ${LEVEL_TABLE[level]}
    WHERE ${scoped}${notSelf}aliases && ${sql.param(keys)}::text[] LIMIT 1
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
// Brands
// --------------------------------------------------------------------------

export interface CreateBrandInput {
  name: string;
  aliases?: string[];
  country?: string | null;
  website?: string | null;
  attribution?: RegistryAttribution;
}

export interface CreateBrandResult {
  brandId: string;
  slug: string;
  aliases: string[];
}

// Mint a marca. Wave 1 seeded the registry mechanically from the 36 distinct
// free-text brand strings the catalog already carried; this is the path for the
// 37th — a marca that appears only on rows whose `brand` column was never filled,
// which is most of what Wave 3's 565 unbranded rows turn out to be.
//
// THE ALIAS COLLISION CHECK IS THE SAFETY RAIL, and it is why minting here is not
// the duplicate-brand hazard it looks like. `brands.slug` is unique but does NOT
// fold accents, so `Padron` and `Padrón` slug differently and the unique index
// would happily admit both. Their FOLDED keys are identical, so the global alias
// check refuses the second one and names the first — the curator learns the brand
// exists under another spelling instead of forking the marca.
export async function createBrandWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: CreateBrandInput,
): Promise<CreateBrandResult> {
  const name = requireName(input.name, "name");
  const slug = requireSlug(name, "name");
  const aliases = aliasKeysFor(name, input.aliases ?? []);

  const existing = await tx.select({ id: brands.id }).from(brands).where(eq(brands.slug, slug)).limit(1);
  if (existing[0]) throw new ValidationError([{ path: "name", message: "A brand with that slug exists." }]);
  await assertAliasesFree(tx, "brand", null, aliases, "aliases");

  const inserted = await tx
    .insert(brands)
    .values({
      name,
      slug,
      aliases,
      country: input.country ?? null,
      website: input.website ?? null,
      createdAt: deps.now(),
      updatedAt: deps.now(),
    })
    .returning({ id: brands.id });
  const brandId = inserted[0]!.id;

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(principal, input.attribution),
    action: "brand.create",
    smokeId: null,
    before: null,
    after: { id: brandId, name, slug, aliases },
    correlationId: input.attribution?.correlationId ?? null,
  });

  return { brandId, slug, aliases };
}

export async function createBrand(
  deps: Deps,
  principal: Principal,
  input: CreateBrandInput,
): Promise<CreateBrandResult> {
  assertCurator(principal);
  return deps.db.transaction((tx) => createBrandWithinTx(tx, deps, principal, input));
}

// --------------------------------------------------------------------------
// Aliases — one editor for all four levels
// --------------------------------------------------------------------------

export interface EditAliasesInput {
  level: RegistryLevel;
  id: string;
  // SPELLINGS, not keys. Both lists are folded before anything is compared, so a
  // caller may pass `Padrón`, `Padron` or `padron` and mean the same key — which
  // matters most on `remove`, where guessing the stored form of a key you cannot
  // see would otherwise be the caller's problem.
  add?: string[];
  remove?: string[];
  attribution?: RegistryAttribution;
}

export interface EditAliasesResult {
  level: RegistryLevel;
  id: string;
  name: string;
  aliases: string[];
  added: string[];
  removed: string[];
}

interface AliasRow {
  id: string;
  name: string;
  aliases: string[];
  scope_value: string | null;
}

// The scope column whose value bounds this level's alias uniqueness, or null for
// the two global levels.
function aliasScopeColumn(level: RegistryLevel): "brand_id" | "line_id" | null {
  if (level === "line") return "brand_id";
  if (level === "blend") return "line_id";
  return null;
}

// Add and remove matching keys on one registry row. ONE editor for all four
// levels, because the rule is identical at every level and three copies of it
// were already two too many — the levels differ only in which table they read and
// what their alias uniqueness is scoped to, both of which are data.
//
// TWO REFUSALS, and both protect findability rather than tidiness:
//
//   an identity key cannot be removed — `aliasKeysFor(name)` is the key set the
//   row's own name derives, the one the anchor probe reaches it by. Dropping it
//   leaves a row that exists and cannot be found by its own name, which is a
//   worse state than the alias the curator was trying to fix. Rename the row (a
//   different, audited act) instead.
//
//   the last key cannot be removed — same argument at the limit. An empty
//   `aliases` array is a row no probe can ever return.
//
// A key already present is not re-added and a key already absent is not removed:
// the write is a target-state edit over a set, so replaying it is a no-op rather
// than an error, and `added`/`removed` report what actually moved.
export async function editRegistryAliasesWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: EditAliasesInput,
): Promise<EditAliasesResult> {
  const scopeColumn = aliasScopeColumn(input.level);
  const scopeSelect = scopeColumn === null ? sql`NULL` : sql`${sql.identifier(scopeColumn)}::text`;
  const found = await tx.execute(sql`
    SELECT id::text AS id, name, aliases, ${scopeSelect} AS scope_value
    FROM ${LEVEL_TABLE[input.level]} WHERE id = ${input.id}::uuid LIMIT 1
  `);
  const row = (found.rows as unknown as AliasRow[])[0];
  if (!row) throw new ValidationError([{ path: "id", message: `No such ${input.level}.` }]);

  const scope: AliasScope =
    scopeColumn === null || row.scope_value === null ? null : { column: scopeColumn, value: row.scope_value };

  const requestedAdd = aliasKeysFor("", input.add ?? []);
  const requestedRemove = aliasKeysFor("", input.remove ?? []);
  const identity = new Set(aliasKeysFor(row.name));

  const protectedKey = requestedRemove.find((key) => identity.has(key));
  if (protectedKey !== undefined) {
    throw new ValidationError([
      {
        path: "remove",
        message: `The matching key '${protectedKey}' is derived from this ${input.level}'s own name and cannot be removed — rename it instead.`,
      },
    ]);
  }

  const added = requestedAdd.filter((key) => !row.aliases.includes(key));
  const removed = requestedRemove.filter((key) => row.aliases.includes(key));

  if (added.length === 0 && removed.length === 0) {
    return { level: input.level, id: row.id, name: row.name, aliases: row.aliases, added: [], removed: [] };
  }

  await assertAliasesFree(tx, input.level, scope, added, "add", row.id);

  const next = [...new Set([...row.aliases, ...added])].filter((key) => !removed.includes(key)).sort();
  if (next.length === 0) {
    throw new ValidationError([
      { path: "remove", message: `That would leave this ${input.level} with no matching keys at all.` },
    ]);
  }

  await tx.execute(sql`
    UPDATE ${LEVEL_TABLE[input.level]}
    SET aliases = ${sql.param(next)}::text[], updated_at = ${deps.now()}
    WHERE id = ${row.id}::uuid
  `);

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(principal, input.attribution),
    action: `${input.level}.set_aliases`,
    smokeId: null,
    before: { id: row.id, name: row.name, aliases: row.aliases },
    after: { id: row.id, name: row.name, aliases: next, added, removed },
    correlationId: input.attribution?.correlationId ?? null,
  });

  return { level: input.level, id: row.id, name: row.name, aliases: next, added, removed };
}

export async function editRegistryAliases(
  deps: Deps,
  principal: Principal,
  input: EditAliasesInput,
): Promise<EditAliasesResult> {
  assertCurator(principal);
  return deps.db.transaction((tx) => editRegistryAliasesWithinTx(tx, deps, principal, input));
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

export async function createLineWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: CreateLineInput,
): Promise<CreateLineResult> {
  const name = requireName(input.name, "name");
  const slug = requireSlug(name, "name");
  const aliases = aliasKeysFor(name, input.aliases ?? []);

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
  await assertAliasesFree(tx, "line", { column: "brand_id", value: input.brandId }, aliases, "aliases");

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
}

export async function createLine(
  deps: Deps,
  principal: Principal,
  input: CreateLineInput,
): Promise<CreateLineResult> {
  assertCurator(principal);
  return deps.db.transaction((tx) => createLineWithinTx(tx, deps, principal, input));
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

// Add matching keys to a line/blend/blender. The caller passes SPELLINGS; the keys
// are derived, because a caller that passed a display string would create an alias
// nothing can ever probe for. Thin delegates over the one editor above — kept as
// named functions because the crawler fixtures and the Wave 2 tests call them, and
// because "add aliases to a line" reads better at a call site than a level literal.
export async function addLineAliases(
  deps: Deps,
  principal: Principal,
  input: AddAliasesInput,
): Promise<AddAliasesResult> {
  const result = await editRegistryAliases(deps, principal, {
    level: "line",
    id: input.id,
    add: input.aliases,
    attribution: input.attribution,
  });
  return { aliases: result.aliases, added: result.added };
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

export async function createBlendWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: CreateBlendInput,
): Promise<CreateBlendResult> {
  const name = requireName(input.name, "name");
  const slug = requireSlug(name, "name");
  const aliases = aliasKeysFor(name, input.aliases ?? []);

  {
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
    await assertAliasesFree(tx, "blend", { column: "line_id", value: input.lineId }, aliases, "aliases");

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
  }
}

export async function createBlend(
  deps: Deps,
  principal: Principal,
  input: CreateBlendInput,
): Promise<CreateBlendResult> {
  assertCurator(principal);
  return deps.db.transaction((tx) => createBlendWithinTx(tx, deps, principal, input));
}

export async function addBlendAliases(
  deps: Deps,
  principal: Principal,
  input: AddAliasesInput,
): Promise<AddAliasesResult> {
  const result = await editRegistryAliases(deps, principal, {
    level: "blend",
    id: input.id,
    add: input.aliases,
    attribution: input.attribution,
  });
  return { aliases: result.aliases, added: result.added };
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
export async function createBlenderWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: CreateBlenderInput,
): Promise<CreateBlenderResult> {
  const name = requireName(input.name, "name");
  const slug = requireSlug(name, "name");
  const aliases = aliasKeysFor(name, input.aliases ?? []);

  const existing = await tx.select({ id: blenders.id }).from(blenders).where(eq(blenders.slug, slug)).limit(1);
  if (existing[0]) throw new ValidationError([{ path: "name", message: "A blender with that slug exists." }]);
  await assertAliasesFree(tx, "blender", null, aliases, "aliases");

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
}

export async function createBlender(
  deps: Deps,
  principal: Principal,
  input: CreateBlenderInput,
): Promise<CreateBlenderResult> {
  assertCurator(principal);
  return deps.db.transaction((tx) => createBlenderWithinTx(tx, deps, principal, input));
}

export async function addBlenderAliases(
  deps: Deps,
  principal: Principal,
  input: AddAliasesInput,
): Promise<AddAliasesResult> {
  const result = await editRegistryAliases(deps, principal, {
    level: "blender",
    id: input.id,
    add: input.aliases,
    attribution: input.attribution,
  });
  return { aliases: result.aliases, added: result.added };
}

export interface CreditBlenderInput {
  blendId: string;
  blenderId: string;
  attribution?: RegistryAttribution;
}

// Credit the blend, not the brand: Willy Herrera has been Drew Estate's master
// blender since 2011, but Liga Privada (2007) was Steve Saka's, with Jonathan
// Drew and Nicholas Melillo (docs/ddd/cigar-industry-vocabulary.md).
export async function creditBlenderWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: CreditBlenderInput,
): Promise<{ created: boolean }> {
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
}

export async function creditBlender(
  deps: Deps,
  principal: Principal,
  input: CreditBlenderInput,
): Promise<{ created: boolean }> {
  assertCurator(principal);
  return deps.db.transaction((tx) => creditBlenderWithinTx(tx, deps, principal, input));
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
  // The FREE-TEXT marca, and the one argument here that writes two columns.
  // `cigars.brand_id` is a PROJECTION of this string (ADR-012), so setting the
  // text re-derives the link through `deriveBrandId` — the single rule every
  // other writer of that column already uses. Passing both `brand` and `brandId`
  // is refused rather than reconciled: a caller who supplies a pair is asserting
  // a projection that may not hold, and silently preferring one would be the
  // drift the single-rule design exists to prevent.
  brand?: string | null;
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

// A `composed` name needs something to compose from. Exported because the Wave 3
// preview must refuse exactly what the write refuses — a dry run that accepted a
// flip the commit rejects is worse than no dry run, since it is trusted before a
// batch. One definition, both callers.
export function assertComposable(nameSource: "freeform" | "composed", brandId: string | null): void {
  if (nameSource === "composed" && brandId == null) {
    throw new ValidationError([
      { path: "brandId", message: "A composed name needs at least a brand to compose from." },
    ]);
  }
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
export async function assignCigarPartsWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: AssignCigarPartsInput,
): Promise<AssignCigarPartsResult> {
  const rows = await tx
    .select({
      id: cigars.id,
      canonicalName: cigars.canonicalName,
      brand: cigars.brand,
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

  if (input.brand !== undefined && input.brandId !== undefined) {
    throw new ValidationError([
      { path: "brand", message: "Set the marca by name or by brandId, not both — brandId is derived from the name." },
    ]);
  }
  // The projection, re-derived here rather than trusted from the caller. An
  // unknown spelling yields null, which leaves the row unlinked (a worklist item)
  // instead of pointing at the brand it used to claim.
  const derivedBrandId =
    input.brand === undefined ? undefined : await deriveBrandId(tx, input.brand);

  const next: CigarAncestry = {
    brandId:
      derivedBrandId !== undefined
        ? derivedBrandId
        : input.brandId === undefined
          ? current.brandId
          : input.brandId,
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
    ["brand", "brand", current.brand, input.brand === undefined ? current.brand : input.brand],
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
  assertComposable(nameSource, next.brandId);

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
}

export async function assignCigarParts(
  deps: Deps,
  principal: Principal,
  input: AssignCigarPartsInput,
): Promise<AssignCigarPartsResult> {
  assertCurator(principal);
  return deps.db.transaction((tx) => assignCigarPartsWithinTx(tx, deps, principal, input));
}
