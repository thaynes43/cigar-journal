import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLog, blenders, blends, brands, cigars, lines, listingMatches } from "@cj/db";
import type { ListingMatchRow } from "@cj/db";
import type { Deps, Principal, Queryer, Tx } from "./deps.js";
import { CigarNotFoundError, ValidationError } from "./errors.js";
import { fingerprint } from "./fingerprint.js";
import { assertReplayable, isUniqueViolation, loadIdempotency, recordIdempotency } from "./idempotency.js";
import { auditActor } from "./audit-attribution.js";
import { brandSlug } from "./catalog-browse.js";
import { composeCanonicalName } from "./taxonomy-keys.js";
import { assertCigarAncestry, type CigarAncestry } from "./cigar-ancestry.js";
import { deriveBrandId, loadAncestryContext } from "./taxonomy-resolve.js";
import {
  assertComposable,
  assertCurator,
  assignCigarPartsWithinTx,
  createBlendWithinTx,
  createBlenderWithinTx,
  createBrandWithinTx,
  createLineWithinTx,
  creditBlenderWithinTx,
  editRegistryAliasesWithinTx,
  recomposeCigarName,
  type EditAliasesResult,
  type RegistryAttribution,
  type RegistryLevel,
} from "./taxonomy-writes.js";

// THE CURATION SURFACE FOR THE TAXONOMY (ADR-012, issue #196 Wave 3).
//
// Wave 2 built the registry primitives; this is the layer the curation lane
// actually calls, and everything it adds over those primitives is about being
// safe to run unattended, thousands of rows deep:
//
//   the idempotency envelope — every service here is enveloped on an MCP
//   `clientRequestId`, so a lane that loses its connection mid-batch retries the
//   same intent instead of minting a second `Liga Privada`.
//
//   get-or-create — the lane does not know, and should not have to ask, whether
//   the line it needs already exists. Minting one is the same call as finding
//   one, and the result says which happened.
//
//   whole paths in one call — a row needs its brand, its line and its blend
//   before it can be assigned, and three round-trips with two ids threaded
//   between them is three chances to half-apply a structure.
//
// Nothing here relaxes a Wave 2 rule. The alias-collision refusal, the ancestry
// assertion and the slug-uniqueness checks are the same code, reached through
// the `*WithinTx` cores, because a curation surface that validated differently
// from the crawler's write path would be a second definition of a valid catalog.

// --------------------------------------------------------------------------
// registerTaxonomy — get-or-create a brand → line → blend path
// --------------------------------------------------------------------------

export interface RegisterBrandInput {
  name: string;
  aliases?: string[];
  country?: string | null;
  website?: string | null;
}

export interface RegisterLineInput {
  name: string;
  aliases?: string[];
  description?: string | null;
}

export interface RegisterBlendInput {
  name: string;
  aliases?: string[];
  wrapper?: string | null;
  binder?: string | null;
  filler?: string | null;
  strength?: string | null;
  blendNotes?: string | null;
  // Blender NAMES, not ids — the lane reads a name off a press release, and
  // making it resolve that to an id first would mean a lookup tool whose only
  // purpose is to feed this one. Each is get-or-created globally and credited.
  blenders?: string[];
}

export interface RegisterTaxonomyInput {
  clientRequestId: string;
  // The marca, by id when it is known and by name when it is not. Exactly one.
  brandId?: string;
  brand?: RegisterBrandInput;
  line?: RegisterLineInput;
  blend?: RegisterBlendInput;
  attribution?: RegistryAttribution;
  correlationId?: string;
}

export interface RegisteredEntity {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  // Whether THIS call minted it. The lane reports mints and skips finds, so the
  // flag is the difference between "structured an existing row" and "grew the
  // registry", which is the number a curation run is judged on.
  created: boolean;
}

export interface RegisteredBlender {
  id: string;
  name: string;
  created: boolean;
  credited: boolean;
}

export interface RegisterTaxonomyResult {
  brand: RegisteredEntity;
  line: RegisteredEntity | null;
  blend: RegisteredEntity | null;
  blenders: RegisteredBlender[];
  replayed: boolean;
}

interface RegistryRow {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
}

async function findBrandBySlug(tx: Tx, slug: string): Promise<RegistryRow | undefined> {
  const rows = await tx
    .select({ id: brands.id, name: brands.name, slug: brands.slug, aliases: brands.aliases })
    .from(brands)
    .where(eq(brands.slug, slug))
    .limit(1);
  return rows[0];
}

async function loadBrand(tx: Tx, brandId: string): Promise<RegistryRow> {
  const rows = await tx
    .select({ id: brands.id, name: brands.name, slug: brands.slug, aliases: brands.aliases })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ValidationError([{ path: "brandId", message: "No such brand." }]);
  return row;
}

// The slug a name would take, refused early when the name is punctuation only —
// the same rule `requireSlug` applies inside the primitives, run here so a
// get-or-create reports the bad name rather than a confusing miss.
function slugForLookup(name: string, path: string): string {
  const slug = brandSlug(name.trim());
  if (slug === "") {
    throw new ValidationError([{ path, message: "This name has no addressable slug — it is punctuation only." }]);
  }
  return slug;
}

async function registerTaxonomyWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: RegisterTaxonomyInput,
  requestFingerprint: string,
): Promise<RegisterTaxonomyResult> {
  const existingKey = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existingKey) {
    assertReplayable(existingKey, requestFingerprint);
    return { ...(existingKey.result as RegisterTaxonomyResult), replayed: true };
  }

  if ((input.brandId == null) === (input.brand == null)) {
    throw new ValidationError([
      { path: "brandId", message: "Name the marca exactly once — by brandId, or by brand.name to find or mint it." },
    ]);
  }
  if (input.blend != null && input.line == null) {
    throw new ValidationError([
      { path: "line", message: "A blend hangs off a line — name the line this blend belongs to." },
    ]);
  }
  const attribution = { ...input.attribution, correlationId: input.correlationId ?? input.clientRequestId };

  // ---- brand -------------------------------------------------------------
  let brand: RegisteredEntity;
  if (input.brandId != null) {
    const row = await loadBrand(tx, input.brandId);
    brand = { ...row, created: false };
  } else {
    const spec = input.brand!;
    const slug = slugForLookup(spec.name, "brand.name");
    const found = await findBrandBySlug(tx, slug);
    if (found) {
      brand = { ...found, created: false };
    } else {
      const minted = await createBrandWithinTx(tx, deps, principal, {
        name: spec.name,
        aliases: spec.aliases,
        country: spec.country,
        website: spec.website,
        attribution,
      });
      brand = {
        id: minted.brandId,
        name: spec.name.trim(),
        slug: minted.slug,
        aliases: minted.aliases,
        created: true,
      };
    }
  }

  // ---- line --------------------------------------------------------------
  let line: RegisteredEntity | null = null;
  if (input.line != null) {
    const slug = slugForLookup(input.line.name, "line.name");
    const found = await tx
      .select({ id: lines.id, name: lines.name, slug: lines.slug, aliases: lines.aliases })
      .from(lines)
      .where(and(eq(lines.brandId, brand.id), eq(lines.slug, slug)))
      .limit(1);
    if (found[0]) {
      line = { ...found[0], created: false };
    } else {
      const minted = await createLineWithinTx(tx, deps, principal, {
        brandId: brand.id,
        name: input.line.name,
        aliases: input.line.aliases,
        description: input.line.description,
        attribution,
      });
      line = {
        id: minted.lineId,
        name: input.line.name.trim(),
        slug: minted.slug,
        aliases: minted.aliases,
        created: true,
      };
    }
  }

  // ---- blend -------------------------------------------------------------
  let blend: RegisteredEntity | null = null;
  if (input.blend != null && line != null) {
    const slug = slugForLookup(input.blend.name, "blend.name");
    const found = await tx
      .select({ id: blends.id, name: blends.name, slug: blends.slug, aliases: blends.aliases })
      .from(blends)
      .where(and(eq(blends.lineId, line.id), eq(blends.slug, slug)))
      .limit(1);
    if (found[0]) {
      blend = { ...found[0], created: false };
    } else {
      const minted = await createBlendWithinTx(tx, deps, principal, {
        lineId: line.id,
        name: input.blend.name,
        aliases: input.blend.aliases,
        wrapper: input.blend.wrapper,
        binder: input.blend.binder,
        filler: input.blend.filler,
        strength: input.blend.strength,
        blendNotes: input.blend.blendNotes,
        attribution,
      });
      blend = {
        id: minted.blendId,
        name: input.blend.name.trim(),
        slug: minted.slug,
        aliases: minted.aliases,
        created: true,
      };
    }
  }

  // ---- blenders ----------------------------------------------------------
  // Credited on the BLEND, never on the brand: Willy Herrera has been Drew
  // Estate's master blender since 2011, but Liga Privada was Steve Saka's. A
  // blend with no credit is the normal Cuban case, not a gap to fill, so an
  // absent list writes nothing at all.
  const credited: RegisteredBlender[] = [];
  if (blend != null && input.blend?.blenders != null) {
    for (const rawName of input.blend.blenders) {
      const name = rawName.trim();
      if (name === "") continue;
      const slug = slugForLookup(name, "blend.blenders");
      const found = await tx.select({ id: blenders.id, name: blenders.name }).from(blenders).where(eq(blenders.slug, slug)).limit(1);
      let blenderId: string;
      let created = false;
      if (found[0]) {
        blenderId = found[0].id;
      } else {
        const minted = await createBlenderWithinTx(tx, deps, principal, { name, attribution });
        blenderId = minted.blenderId;
        created = true;
      }
      const credit = await creditBlenderWithinTx(tx, deps, principal, {
        blendId: blend.id,
        blenderId,
        attribution,
      });
      credited.push({ id: blenderId, name: found[0]?.name ?? name, created, credited: credit.created });
    }
  }

  const result: RegisterTaxonomyResult = { brand, line, blend, blenders: credited, replayed: false };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "register_taxonomy",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// Find or mint a brand → line → blend path in one audited, retry-safe call.
//
// GET-OR-CREATE, NOT CREATE. Structuring 971 rows top-down means naming the same
// line for the fifty-two Arturo Fuente rows under it; a create-only verb would
// make forty-one of those calls errors the lane has to distinguish from real
// ones, and a lane that learns to ignore "already exists" is a lane that ignores
// the collision refusal too. Finding is the same call as minting, and `created`
// says which happened.
export async function registerTaxonomy(
  deps: Deps,
  principal: Principal,
  input: RegisterTaxonomyInput,
): Promise<RegisterTaxonomyResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);
  try {
    return await deps.db.transaction((tx) =>
      registerTaxonomyWithinTx(tx, deps, principal, input, requestFingerprint),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as RegisterTaxonomyResult), replayed: true };
      }
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// updateRegistryAliases — the enveloped alias editor
// --------------------------------------------------------------------------

export interface UpdateRegistryAliasesInput {
  clientRequestId: string;
  level: RegistryLevel;
  id: string;
  add?: string[];
  remove?: string[];
  attribution?: RegistryAttribution;
  correlationId?: string;
}

export type UpdateRegistryAliasesResult = EditAliasesResult & { replayed: boolean };

// Add or drop the spellings a registry row answers to. This is the tool that
// closes a `no_anchor` triage row: the title named the marca in a spelling the
// registry does not know, and the fix is a key here, never a looser matcher.
export async function updateRegistryAliases(
  deps: Deps,
  principal: Principal,
  input: UpdateRegistryAliasesInput,
): Promise<UpdateRegistryAliasesResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  const run = async (tx: Tx): Promise<UpdateRegistryAliasesResult> => {
    const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
    if (existing) {
      assertReplayable(existing, requestFingerprint);
      return { ...(existing.result as UpdateRegistryAliasesResult), replayed: true };
    }
    const result = await editRegistryAliasesWithinTx(tx, deps, principal, {
      level: input.level,
      id: input.id,
      add: input.add,
      remove: input.remove,
      attribution: { ...input.attribution, correlationId: input.correlationId ?? input.clientRequestId },
    });
    const payload: UpdateRegistryAliasesResult = { ...result, replayed: false };
    await recordIdempotency(tx, {
      userId: principal.userId,
      clientRequestId: input.clientRequestId,
      tool: "update_registry_aliases",
      requestFingerprint,
      smokeId: null,
      result: payload,
    });
    return payload;
  };

  try {
    return await deps.db.transaction(run);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as UpdateRegistryAliasesResult), replayed: true };
      }
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// assignCigarTaxonomy — structure one leaf, with a dry run
// --------------------------------------------------------------------------

export interface AssignCigarTaxonomyInput {
  clientRequestId: string;
  cigarId: string;
  brandId?: string | null;
  brand?: string | null;
  lineId?: string | null;
  blendId?: string | null;
  vitolaName?: string | null;
  edition?: string | null;
  nameSource?: "freeform" | "composed";
  // Compute and validate, write nothing. See the note on the exported function.
  preview?: boolean;
  attribution?: RegistryAttribution;
  correlationId?: string;
}

export interface AssignCigarTaxonomyResult {
  cigarId: string;
  canonicalName: string;
  // What the parts compose to, reported whether or not the row is `composed`.
  // On a freeform row that is the name it WOULD take, which is the whole
  // question a curator is asking before they flip it.
  composedName: string;
  nameSource: "freeform" | "composed";
  changedFields: string[];
  preview: boolean;
  replayed: boolean;
}

interface PartNames {
  brand: string | null;
  line: string | null;
  blend: string | null;
}

// The DISPLAY names behind an ancestry, over a PROPOSED ancestry rather than the
// stored one.
//
// IT MUST MIRROR `loadCigarNameParts` EXACTLY, because that is the function the
// actual write recomposes through: registry spelling where a level has one,
// FALLING BACK to the row's free-text column where it does not. Getting that
// fallback wrong is not a cosmetic difference — a row carrying a free-text `line`
// and no `lineId` would preview a name with the line missing and then commit one
// with it present, which is precisely the divergence a dry run exists to rule out.
// Blend has no free-text column to fall back to, so it is registry-or-nothing.
async function namesForAncestry(
  tx: Queryer,
  ancestry: CigarAncestry,
  brandText: string | null,
  lineText: string | null,
): Promise<PartNames> {
  const names: PartNames = { brand: brandText, line: lineText, blend: null };
  if (ancestry.brandId != null) {
    const rows = await tx.select({ name: brands.name }).from(brands).where(eq(brands.id, ancestry.brandId)).limit(1);
    names.brand = rows[0]?.name ?? brandText;
  }
  if (ancestry.lineId != null) {
    const rows = await tx.select({ name: lines.name }).from(lines).where(eq(lines.id, ancestry.lineId)).limit(1);
    names.line = rows[0]?.name ?? lineText;
  }
  if (ancestry.blendId != null) {
    const rows = await tx.select({ name: blends.name }).from(blends).where(eq(blends.id, ancestry.blendId)).limit(1);
    names.blend = rows[0]?.name ?? null;
  }
  return names;
}

async function assignCigarTaxonomyWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: AssignCigarTaxonomyInput,
  requestFingerprint: string,
): Promise<AssignCigarTaxonomyResult> {
  // THE REPLAY CHECK COMES FIRST on a real write, and the order matters: a stored
  // result must come back even if the world has moved since. Validating first
  // would let a retry of a call that already succeeded fail on an ancestry the
  // registry has changed underneath it — turning a safe retry into a hard error
  // for work that is already done.
  //
  // A preview skips it entirely. It writes nothing, so it has no replay to detect,
  // and consuming the key here would stop the same clientRequestId from committing
  // what was just previewed.
  if (input.preview !== true) {
    const existingKey = await loadIdempotency(tx, principal.userId, input.clientRequestId);
    if (existingKey) {
      assertReplayable(existingKey, requestFingerprint);
      return { ...(existingKey.result as AssignCigarTaxonomyResult), replayed: true };
    }
  }

  const rows = await tx
    .select({
      id: cigars.id,
      canonicalName: cigars.canonicalName,
      brand: cigars.brand,
      line: cigars.line,
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

  const brandText = input.brand === undefined ? current.brand : input.brand;
  const derived = input.brand === undefined ? undefined : await deriveBrandId(tx, input.brand);
  const next: CigarAncestry = {
    brandId: derived !== undefined ? derived : input.brandId === undefined ? current.brandId : input.brandId,
    lineId: input.lineId === undefined ? current.lineId : input.lineId,
    blendId: input.blendId === undefined ? current.blendId : input.blendId,
  };

  // VALIDATED ON THE PREVIEW TOO. A dry run that skipped the ancestry check
  // would answer the easy half of the question ("what would it be called?") and
  // hide the half that refuses the write, which is exactly the surprise a
  // preview exists to remove.
  assertCigarAncestry(next, await loadAncestryContext(tx, next));

  const names = await namesForAncestry(tx, next, brandText, current.line);
  const composedName = composeCanonicalName({
    ...names,
    vitola: input.vitolaName === undefined ? current.vitolaName : input.vitolaName,
    edition: input.edition === undefined ? current.edition : input.edition,
  });
  const nameSource = input.nameSource ?? current.nameSource;

  // BEFORE the preview returns, not inside the write. The primitive enforces this
  // too, but only on the commit — so checking it only there let a preview approve
  // a flip the commit would refuse, and an agent that previews a batch before
  // flipping it would meet the refusal once per row instead of once.
  assertComposable(nameSource, next.brandId);

  if (input.preview === true) {
    // The fields this call WOULD change, computed the same way the write path
    // computes them so the two lists cannot disagree.
    const changed: string[] = [];
    const compare: [string, unknown, unknown][] = [
      ["brand", current.brand, brandText],
      ["brandId", current.brandId, next.brandId],
      ["lineId", current.lineId, next.lineId],
      ["blendId", current.blendId, next.blendId],
      ["vitolaName", current.vitolaName, input.vitolaName === undefined ? current.vitolaName : input.vitolaName],
      ["edition", current.edition, input.edition === undefined ? current.edition : input.edition],
      ["nameSource", current.nameSource, nameSource],
    ];
    for (const [key, from, to] of compare) if (from !== to) changed.push(key);
    return {
      cigarId: current.id,
      // On a preview of a flip to `composed`, the name the row would carry.
      canonicalName: nameSource === "composed" && composedName !== "" ? composedName : current.canonicalName,
      composedName,
      nameSource,
      changedFields: changed,
      preview: true,
      replayed: false,
    };
  }

  const written = await assignCigarPartsWithinTx(tx, deps, principal, {
    cigarId: input.cigarId,
    ...(input.brand === undefined ? {} : { brand: input.brand }),
    ...(input.brandId === undefined ? {} : { brandId: input.brandId }),
    ...(input.lineId === undefined ? {} : { lineId: input.lineId }),
    ...(input.blendId === undefined ? {} : { blendId: input.blendId }),
    ...(input.vitolaName === undefined ? {} : { vitolaName: input.vitolaName }),
    ...(input.edition === undefined ? {} : { edition: input.edition }),
    ...(input.nameSource === undefined ? {} : { nameSource: input.nameSource }),
    attribution: { ...input.attribution, correlationId: input.correlationId ?? input.clientRequestId },
  });

  const result: AssignCigarTaxonomyResult = {
    cigarId: written.cigarId,
    canonicalName: written.canonicalName,
    composedName,
    nameSource: written.nameSource,
    changedFields: written.changedFields,
    preview: false,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "assign_cigar_taxonomy",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// Set a leaf's structural parts, and optionally flip its name to the composition
// of them.
//
// THE PREVIEW IS A DRY RUN OF THIS EXACT CALL, not a separate name calculator.
// It loads the same row, applies the same overlay, runs the same ancestry
// assertion and composes through the same function — then returns instead of
// writing. A second tool taking a second copy of these arguments would drift
// from the write path on the first rule either one gained, and the answer a
// curator trusts before flipping 971 rows has to be the answer they get.
//
// A preview writes nothing, and so records no idempotency key: the same
// `clientRequestId` may be reused to commit what was just previewed.
export async function assignCigarTaxonomy(
  deps: Deps,
  principal: Principal,
  input: AssignCigarTaxonomyInput,
): Promise<AssignCigarTaxonomyResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);
  try {
    return await deps.db.transaction((tx) =>
      assignCigarTaxonomyWithinTx(tx, deps, principal, input, requestFingerprint),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as AssignCigarTaxonomyResult), replayed: true };
      }
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// splitCigar — break a collapse bucket into its real leaves
// --------------------------------------------------------------------------

export interface SplitTargetInput {
  // The bucket's listings that belong to THIS product. Every id must currently
  // point at the bucket.
  listingIds: string[];
  // Where they go: an existing sibling leaf...
  targetCigarId?: string;
  // ...or a new leaf minted from these parts, under the bucket's own brand.
  lineId?: string | null;
  blendId?: string | null;
  vitolaName?: string | null;
  edition?: string | null;
  // Overrides the composed name. Omit it and the leaf is `composed`, which is
  // what a split should almost always produce — the parts are exactly what the
  // curator just established.
  canonicalName?: string | null;
}

export interface SplitCigarInput {
  clientRequestId: string;
  cigarId: string;
  splits: SplitTargetInput[];
  attribution?: RegistryAttribution;
  correlationId?: string;
}

export interface SplitOutcome {
  cigarId: string;
  canonicalName: string;
  created: boolean;
  listingIds: string[];
}

export interface SplitCigarResult {
  cigarId: string;
  splits: SplitOutcome[];
  // Listings still on the bucket afterwards. Zero means the bucket has been
  // fully dispersed and is itself a merge candidate; non-zero is the normal,
  // conservative outcome — only the listings with unambiguous evidence moved.
  remainingListings: number;
  replayed: boolean;
}

// The audit `before`/`after` shape `applyInverse` reads for a listing-match undo:
// it takes `before.id`, `before.status` and `before.cigarId`. Matching it exactly
// is what makes each re-point individually reversible from the review console
// with no new undo case.
function listingMatchSnapshot(row: ListingMatchRow): Record<string, unknown> {
  return {
    id: row.id,
    vendorId: row.vendorId,
    listingKey: row.listingKey,
    cigarId: row.cigarId,
    status: row.status,
    decidedBy: row.decidedBy,
  };
}

async function splitCigarWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: SplitCigarInput,
  requestFingerprint: string,
): Promise<SplitCigarResult> {
  const existingKey = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existingKey) {
    assertReplayable(existingKey, requestFingerprint);
    return { ...(existingKey.result as SplitCigarResult), replayed: true };
  }

  if (input.splits.length === 0) {
    throw new ValidationError([{ path: "splits", message: "A split needs at least one target." }]);
  }

  const bucketRows = await tx
    .select({
      id: cigars.id,
      canonicalName: cigars.canonicalName,
      brand: cigars.brand,
      brandId: cigars.brandId,
      lineId: cigars.lineId,
      blendId: cigars.blendId,
      type: cigars.type,
      manufacturer: cigars.manufacturer,
      catalogStatus: cigars.catalogStatus,
    })
    .from(cigars)
    .where(eq(cigars.id, input.cigarId))
    .limit(1);
  const bucket = bucketRows[0];
  if (!bucket) throw new CigarNotFoundError();
  if (bucket.catalogStatus !== "active") {
    throw new ValidationError([
      { path: "cigarId", message: `This cigar is ${bucket.catalogStatus}, not active — restore it before splitting it.` },
    ]);
  }

  // Every named listing, read once. A split is judged as a whole: one bad id
  // refuses the call rather than half-applying it, because a bucket left with
  // some listings moved and others refused is harder to reason about than one
  // that was never touched.
  const allIds = input.splits.flatMap((split) => split.listingIds);
  if (allIds.length === 0) {
    throw new ValidationError([{ path: "splits", message: "Name the listings each target takes." }]);
  }
  const seen = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) {
      throw new ValidationError([
        { path: "splits", message: `Listing ${id} is claimed by two targets — a listing names one product.` },
      ]);
    }
    seen.add(id);
  }

  const matches = await tx.select().from(listingMatches).where(inArray(listingMatches.id, allIds));
  const byId = new Map(matches.map((row) => [row.id, row]));
  for (const id of allIds) {
    const match = byId.get(id);
    if (!match) throw new ValidationError([{ path: "splits", message: `No listing match matches id ${id}.` }]);
    if (match.cigarId !== bucket.id) {
      throw new ValidationError([
        { path: "splits", message: `Listing ${id} does not point at this cigar — a split only re-points its own listings.` },
      ]);
    }
    // THE HUMAN-DECIDED REFUSAL. `decided_by` of curator or agent, or a
    // `confirmed` status, means somebody already ruled on this link — the same
    // predicate the crawler honours before re-deciding one (ADR-006, migration
    // 0017). A split is evidence-driven bulk work and must not silently overturn
    // a verdict; the curator re-points it deliberately or leaves it alone.
    if (match.decidedBy !== "crawler" || match.status === "confirmed") {
      throw new ValidationError([
        {
          path: "splits",
          message: `Listing ${id} was already decided by ${match.decidedBy} (${match.status}) — a split does not overturn a settled link.`,
        },
      ]);
    }
  }

  const decidedBy = input.attribution?.actor === "agent" ? "agent" : "curator";
  const correlationId = input.correlationId ?? input.clientRequestId;
  const outcomes: SplitOutcome[] = [];

  for (const [index, split] of input.splits.entries()) {
    if (split.listingIds.length === 0) {
      throw new ValidationError([
        { path: `splits.${index}.listingIds`, message: "Name at least one listing for this target." },
      ]);
    }

    let targetId: string;
    let targetName: string;
    let created = false;

    if (split.targetCigarId != null) {
      if (split.targetCigarId === bucket.id) {
        throw new ValidationError([
          { path: `splits.${index}.targetCigarId`, message: "A split target must differ from the cigar being split." },
        ]);
      }
      const rows = await tx
        .select({ id: cigars.id, canonicalName: cigars.canonicalName, catalogStatus: cigars.catalogStatus })
        .from(cigars)
        .where(eq(cigars.id, split.targetCigarId))
        .limit(1);
      const target = rows[0];
      if (!target) {
        throw new ValidationError([{ path: `splits.${index}.targetCigarId`, message: "No such cigar." }]);
      }
      if (target.catalogStatus !== "active") {
        throw new ValidationError([
          { path: `splits.${index}.targetCigarId`, message: `That cigar is ${target.catalogStatus}, not active.` },
        ]);
      }
      targetId = target.id;
      targetName = target.canonicalName;
    } else {
      // A MINTED SIBLING MUST DIFFER FROM THE BUCKET IN SOME PART. Splitting a
      // row into a copy of itself moves listings onto a leaf that is the same
      // product under a second id — the duplicate this whole wave exists to end,
      // created by the tool meant to prevent it.
      const distinguishing =
        split.lineId != null || split.blendId != null || split.vitolaName != null || split.edition != null;
      if (!distinguishing) {
        throw new ValidationError([
          {
            path: `splits.${index}`,
            message: "A new leaf needs a line, blend, vitola or edition of its own — otherwise it is the same product.",
          },
        ]);
      }

      const ancestry: CigarAncestry = {
        brandId: bucket.brandId,
        lineId: split.lineId ?? null,
        blendId: split.blendId ?? null,
      };
      assertCigarAncestry(ancestry, await loadAncestryContext(tx, ancestry));

      const names = await namesForAncestry(tx, ancestry, bucket.brand, null);
      const composed = composeCanonicalName({
        ...names,
        vitola: split.vitolaName ?? null,
        edition: split.edition ?? null,
      });
      const explicit = split.canonicalName?.trim();
      const canonicalName = explicit != null && explicit !== "" ? explicit : composed;
      if (canonicalName === "") {
        throw new ValidationError([
          { path: `splits.${index}`, message: "This leaf's parts compose to no name — give it a canonicalName." },
        ]);
      }

      const inserted = await tx
        .insert(cigars)
        .values({
          canonicalName,
          // Identity facts the sibling inherits: it is the same marca, made by
          // the same people, in the same market. Everything the split is ABOUT
          // (line, blend, vitola, edition) comes from the caller instead.
          brand: bucket.brand,
          brandId: bucket.brandId,
          type: bucket.type,
          manufacturer: bucket.manufacturer,
          lineId: ancestry.lineId,
          blendId: ancestry.blendId,
          vitolaName: split.vitolaName ?? null,
          edition: split.edition ?? null,
          nameSource: explicit != null && explicit !== "" ? "freeform" : "composed",
          // Unverified on purpose: a curator asserted the STRUCTURE here, which
          // is a different claim from having reviewed the finished entry.
          verification: "unverified",
          createdAt: deps.now(),
          updatedAt: deps.now(),
        })
        .returning({ id: cigars.id });
      targetId = inserted[0]!.id;
      targetName = canonicalName;
      created = true;

      await tx.insert(auditLog).values({
        userId: principal.userId,
        ...auditAttribution(principal, input.attribution),
        action: "cigar.split_leaf",
        smokeId: null,
        before: { id: bucket.id, canonicalName: bucket.canonicalName },
        after: {
          id: targetId,
          canonicalName,
          splitFrom: bucket.id,
          lineId: ancestry.lineId,
          blendId: ancestry.blendId,
          vitolaName: split.vitolaName ?? null,
          edition: split.edition ?? null,
        },
        correlationId,
      });
    }

    for (const listingId of split.listingIds) {
      const match = byId.get(listingId)!;
      const before = listingMatchSnapshot(match);
      await tx
        .update(listingMatches)
        .set({
          cigarId: targetId,
          status: "confirmed",
          decidedBy,
          // The row is settled now, so the resolver's account of why it was not
          // must go — `upsertListingMatch` writes both on the same always-write
          // terms, and a stale reason on a confirmed link reads as a live doubt.
          unmatchedReason: null,
          suggestedParse: null,
          updatedAt: deps.now(),
        })
        .where(eq(listingMatches.id, listingId));

      await tx.insert(auditLog).values({
        userId: principal.userId,
        ...auditAttribution(principal, input.attribution),
        action: "listing_match.set_status",
        smokeId: null,
        before,
        after: { ...before, cigarId: targetId, status: "confirmed", decidedBy },
        correlationId,
      });
    }

    outcomes.push({ cigarId: targetId, canonicalName: targetName, created, listingIds: split.listingIds });
  }

  const remaining = await tx.execute(sql`
    SELECT count(*)::int AS n FROM listing_matches WHERE cigar_id = ${bucket.id}::uuid
  `);
  const remainingListings = Number((remaining.rows as unknown as { n: number }[])[0]?.n ?? 0);

  // THE OWNER'S OWN HISTORY, COUNTED AND FLAGGED (issue #196 Wave 3). A split
  // moves listings and nothing else: purchase lots and smokes stay on the row
  // they were logged against, because re-attributing somebody's journal entry to
  // a leaf they never chose is a claim about their memory, not about the catalog.
  //
  // But a bucket that carries history is exactly the row where the split matters
  // most and where a mistake is least recoverable, so the counts ride the audit
  // row: a reviewer scanning a run can see which splits touched a cigar the owner
  // actually bought or smoked without joining anything.
  const touched = await tx.execute(sql`
    SELECT (SELECT count(*) FROM purchases p WHERE p.cigar_id = ${bucket.id}::uuid)::int AS lots,
           (SELECT count(*) FROM smokes s WHERE s.cigar_id = ${bucket.id}::uuid)::int AS smokes
  `);
  const history = (touched.rows as unknown as { lots: number; smokes: number }[])[0] ?? { lots: 0, smokes: 0 };

  // The bucket's own name may now be wrong — it was named for the family it
  // served, and it serves one product less. A `composed` bucket recomposes
  // itself; a freeform one is left alone, because that string is the owner's.
  await recomposeCigarName(tx, bucket.id, deps.now());

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditAttribution(principal, input.attribution),
    action: "cigar.split",
    smokeId: null,
    before: {
      id: bucket.id,
      canonicalName: bucket.canonicalName,
      listings: allIds.length + remainingListings,
      // Non-zero means this split touched a row in the owner's own history.
      heldLots: Number(history.lots),
      smokes: Number(history.smokes),
    },
    after: {
      id: bucket.id,
      splits: outcomes.map((outcome) => ({
        cigarId: outcome.cigarId,
        canonicalName: outcome.canonicalName,
        created: outcome.created,
        listings: outcome.listingIds.length,
      })),
      remainingListings,
    },
    correlationId,
  });

  const result: SplitCigarResult = { cigarId: bucket.id, splits: outcomes, remainingListings, replayed: false };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "split_cigar",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// Break one catalog row that has been standing for several products into the
// leaves it should have been, moving each product's listings onto its own.
//
// COMPOSED, NOT MONOLITHIC, WHERE COMPOSITION WORKS. Every registry row this
// needs comes from `register_taxonomy` and every leaf it does not mint is one
// `assign_cigar_taxonomy` already structured. What could not be composed is the
// last step: `setListingMatchStatus` confirms or clears the link a row already
// has and has no way to give it a different cigar — the resolution verb the
// triage read has been documenting as deferred since #170. This is that verb,
// bounded to the split case, where the destination is a sibling of the row the
// listing is already on and the evidence is the listing itself.
//
// ATOMIC AND REVERSIBLE. All of it lands or none of it does, and each re-point
// is audited as `listing_match.set_status` with the bucket in `before` — the
// action the console's Undo already inverts, so a wrong split is walked back
// listing by listing without a new undo path. A minted leaf that should not
// exist is merged back into the bucket through the existing merge ledger, which
// carries its listings home with it (ADR-012: "reversible via the existing
// merge/unmerge ledger").
export async function splitCigar(
  deps: Deps,
  principal: Principal,
  input: SplitCigarInput,
): Promise<SplitCigarResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);
  try {
    return await deps.db.transaction((tx) => splitCigarWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SplitCigarResult), replayed: true };
      }
    }
    throw error;
  }
}

// The audit actor/attribution triple, matching what the registry writes stamp.
// Local rather than imported because `taxonomy-writes.ts` keeps its copy private.
// The NAME is load-bearing, not incidental: audit-attribution.test.ts scans the
// values body of every audit-log insert in the repo and requires it to spread a
// call named `auditActor(` or `auditAttribution(`, so that no write path can
// quietly stop stamping the credential. A third spelling would be invisible to
// that guard, which is the whole thing it exists to prevent. (Naming the insert
// literally in a comment here would also trip the scanner's brace matcher, which
// is why this sentence describes it instead of quoting it.)
function auditAttribution(principal: Principal, given: RegistryAttribution | undefined) {
  const actor = given?.actor ?? "web";
  return {
    ...auditActor(principal, actor),
    actor,
    runId: given?.runId ?? null,
    confidence: given?.confidence ?? null,
  };
}
