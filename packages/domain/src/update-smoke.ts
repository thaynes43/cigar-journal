import { eq, sql } from "drizzle-orm";
import { auditLog, cigars, smokes, smokeProgression, type SmokeRow, type NewSmokeRow } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { UpdateSmokeInput, UpdateSmokeResult, UpdateSmokeChanges } from "./types.js";
import { validateUpdateInput } from "./validation.js";
import { fingerprint } from "./fingerprint.js";
import { normalizeDescriptors, verbatimDescriptors } from "./descriptors.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { CigarNotFoundError, SmokeNotFoundError, VersionConflictError } from "./errors.js";
import { provenanceToActor, stampSmokedAt, smokeSnapshot } from "./mapping.js";
import { applyConsumptionChange } from "./consumption.js";
import { isUuid } from "./uuid.js";

// Correct an existing Smoke via explicit, field-scoped change ops — never a
// generic patch (ADR-002). Append-only progression; original_markdown is never
// touched (no op targets it). Version bump + audit row in the same transaction;
// same idempotency envelope as save.
export async function updateSmoke(
  deps: Deps,
  principal: Principal,
  input: UpdateSmokeInput,
): Promise<UpdateSmokeResult> {
  validateUpdateInput(input);

  // Both ids are refused before the transaction opens, not inside it: a 22P02
  // does not merely escape as a 500, it aborts the surrounding transaction, so a
  // guard placed at either query site would still leave a poisoned tx to unwind.
  // A malformed smokeId is the same refusal as an unowned or unknown one, and a
  // malformed resolveTo the same as a cigar that does not exist (./uuid.ts).
  if (!isUuid(input.smokeId)) throw new SmokeNotFoundError();
  if (input.changes.cigar && !isUuid(input.changes.cigar.resolveTo)) throw new CigarNotFoundError();

  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => updateWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as UpdateSmokeResult), replayed: true };
      }
    }
    throw error;
  }
}

async function updateWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: UpdateSmokeInput,
  requestFingerprint: string,
): Promise<UpdateSmokeResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as UpdateSmokeResult), replayed: true };
  }

  const rows = await tx.select().from(smokes).where(eq(smokes.id, input.smokeId)).limit(1);
  const current = rows[0];
  // Cross-user access is reported as not-found so a smoke's existence never
  // leaks to a non-owner (tool-contract error principle).
  if (!current || current.userId !== principal.userId) throw new SmokeNotFoundError();

  if (input.expectedVersion != null && input.expectedVersion !== current.version) {
    throw new VersionConflictError(input.expectedVersion, current.version);
  }

  const before = smokeSnapshot(current);
  const { patch, changedFields } = await buildPatch(tx, current, input.changes);

  patch.version = current.version + 1;
  patch.updatedAt = deps.now();
  await tx.update(smokes).set(patch).where(eq(smokes.id, current.id));

  // Explicit consumption (ADR-008): set/clear/re-attribute the humidor link, and
  // clear a now-foreign lot when the smoke was re-pointed to another cigar. In
  // the same transaction; its movement rides the single update audit row.
  const newCigarId = (patch.cigarId as string | undefined) ?? current.cigarId;
  const consumption = await applyConsumptionChange(
    tx,
    {
      smokeId: current.id,
      newCigarId,
      userId: principal.userId,
      cigarRepointed: Boolean(input.changes.cigar),
    },
    input.changes.consumption,
  );
  const changedWithConsumption = [...changedFields, ...consumption.changedFields];
  const auditedConsumption = consumption.changedFields.length > 0;

  const provenanceSource = input.provenance?.source ?? "manual";
  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditActor(principal, provenanceToActor(provenanceSource)),
    action: "smoke.updated",
    smokeId: current.id,
    before: auditedConsumption ? { ...before, consumption: consumption.before } : before,
    after: auditedConsumption
      ? { ...smokeSnapshot({ ...current, ...patch } as SmokeRow), consumption: consumption.after }
      : smokeSnapshot({ ...current, ...patch } as SmokeRow),
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: UpdateSmokeResult = {
    smoke: { smokeId: current.id, version: current.version + 1 },
    changedFields: changedWithConsumption,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "update_smoke",
    requestFingerprint,
    smokeId: current.id,
    result,
  });

  return result;
}

async function buildPatch(
  tx: Tx,
  current: SmokeRow,
  changes: UpdateSmokeChanges,
): Promise<{ patch: Partial<NewSmokeRow>; changedFields: string[] }> {
  const patch: Partial<NewSmokeRow> = {};
  const changedFields: string[] = [];

  if (changes.cigar) {
    const target = await tx.select({ id: cigars.id }).from(cigars).where(eq(cigars.id, changes.cigar.resolveTo)).limit(1);
    if (!target[0]) throw new CigarNotFoundError();
    patch.cigarId = changes.cigar.resolveTo;
    changedFields.push("cigar");
  }

  if (changes.smokedAt) {
    const smokedAt = stampSmokedAt(changes.smokedAt, "manual", () => new Date());
    patch.smokedAt = smokedAt.value ? new Date(smokedAt.value) : null;
    patch.smokedAtSource = smokedAt.source;
    patch.smokedAtPrecision = smokedAt.precision;
    changedFields.push("smokedAt");
  }

  if ("context" in changes) {
    patch.context = changes.context ?? null;
    changedFields.push("context");
  }

  if (changes.assessment) {
    const a = changes.assessment;
    if ("strength" in a) patch.strength = a.strength ?? null;
    if ("body" in a) patch.body = a.body ?? null;
    if ("liked" in a) patch.liked = a.liked ?? null;
    if ("rating" in a) patch.rating = a.rating ?? null;
    if ("impression" in a) patch.impression = a.impression ?? null;
    for (const key of Object.keys(a)) changedFields.push(`assessment.${key}`);
  }

  if (changes.construction) {
    const c = changes.construction;
    if ("draw" in c) patch.draw = c.draw ?? null;
    if ("burn" in c) patch.burn = c.burn ?? null;
    if ("smokeOutput" in c) patch.smokeOutput = c.smokeOutput ?? null;
    if ("notes" in c) patch.constructionNotes = c.notes ?? null;
    for (const key of Object.keys(c)) changedFields.push(`construction.${key}`);
  }

  if (changes.journal) {
    const j = changes.journal;
    if ("title" in j) patch.journalTitle = j.title ?? null;
    if ("narrative" in j) patch.journalNarrative = j.narrative ?? null;
    for (const key of Object.keys(j)) changedFields.push(`journal.${key}`);
  }

  if (changes.overallDescriptors) {
    const add = normalizeDescriptors(changes.overallDescriptors.add);
    const remove = new Set(normalizeDescriptors(changes.overallDescriptors.remove));
    const next = [...current.overallDescriptors];
    for (const descriptor of add) if (!next.includes(descriptor)) next.push(descriptor);
    patch.overallDescriptors = next.filter((descriptor) => !remove.has(descriptor));
    changedFields.push("overallDescriptors");
  }

  if (changes.progression?.append && changes.progression.append.length > 0) {
    const maxRow = await tx
      .select({ max: sql<number | null>`max(${smokeProgression.ordinal})` })
      .from(smokeProgression)
      .where(eq(smokeProgression.smokeId, current.id));
    let ordinal = (maxRow[0]?.max ?? -1) + 1;
    await tx.insert(smokeProgression).values(
      changes.progression.append.map((entry) => ({
        smokeId: current.id,
        ordinal: ordinal++,
        stage: entry.stage ?? null,
        approximatePosition: entry.approximatePosition != null ? String(entry.approximatePosition) : null,
        descriptors: normalizeDescriptors(entry.descriptors),
        specificDescriptors: verbatimDescriptors(entry.specificDescriptors),
        verbatim: entry.verbatim ?? null,
      })),
    );
    changedFields.push("progression");
  }

  return { patch, changedFields };
}
