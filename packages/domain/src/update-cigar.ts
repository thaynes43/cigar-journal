import { eq } from "drizzle-orm";
import { auditLog, cigars, type CigarRow, type NewCigarRow } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { UpdateCigarInput, UpdateCigarResult } from "./types.js";
import { fingerprint } from "./fingerprint.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { provenanceToActor } from "./mapping.js";
import { CigarNotFoundError } from "./errors.js";

// Conversational catalog repair (ADR-009), fill-nulls-only. A factual field is
// writable ONLY while it is null AND the cigar is unverified: chat never
// overwrites a non-null value or a curator-verified entry (trust order, ADR-006;
// verification stays curator-only, #45). Never touches the journal. Per-field
// audited, retry-safe through the mutation envelope like the other write tools.

// One writable field: its dot-path label, the cigar column it fills (null when the
// current value is non-null → not writable), and the coerced DB value.
interface FieldPlan {
  label: string;
  column: keyof NewCigarRow;
  current: unknown;
  next: unknown; // the DB-coerced value to write
}

// Build the per-field plan from the requested fills. A field is a candidate only
// when a non-null value was supplied (fill-nulls-only never clears). Whether it is
// actually written is decided later against the current value + verification.
function planFields(input: UpdateCigarInput): FieldPlan[] {
  const f = input.fields;
  const plans: FieldPlan[] = [];
  const text = (label: string, column: keyof NewCigarRow, value: string | null | undefined): void => {
    if (value != null) plans.push({ label, column, current: null, next: value });
  };

  text("brand", "brand", f.brand);
  text("line", "line", f.line);
  text("edition", "edition", f.edition);
  if (f.vitola?.name != null) plans.push({ label: "vitola.name", column: "vitolaName", current: null, next: f.vitola.name });
  if (f.vitola?.lengthInches != null)
    plans.push({ label: "vitola.lengthInches", column: "lengthInches", current: null, next: String(f.vitola.lengthInches) });
  if (f.vitola?.ringGauge != null)
    plans.push({ label: "vitola.ringGauge", column: "ringGauge", current: null, next: f.vitola.ringGauge });
  text("type", "type", f.type);
  text("manufacturer", "manufacturer", f.manufacturer);
  text("factory", "factory", f.factory);
  text("productionCountry", "productionCountry", f.productionCountry);
  if (f.tobacco != null) plans.push({ label: "tobacco", column: "tobacco", current: null, next: f.tobacco });
  text("blendNotes", "blendNotes", f.blendNotes);
  if (f.releaseYear != null) plans.push({ label: "releaseYear", column: "releaseYear", current: null, next: f.releaseYear });
  return plans;
}

export async function updateCigar(
  deps: Deps,
  principal: Principal,
  input: UpdateCigarInput,
): Promise<UpdateCigarResult> {
  const requestFingerprint = fingerprint(input);
  try {
    return await deps.db.transaction((tx) => updateWithinTx(tx, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as UpdateCigarResult), replayed: true };
      }
    }
    throw error;
  }
}

async function updateWithinTx(
  tx: Tx,
  principal: Principal,
  input: UpdateCigarInput,
  requestFingerprint: string,
): Promise<UpdateCigarResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as UpdateCigarResult), replayed: true };
  }

  const rows = await tx.select().from(cigars).where(eq(cigars.id, input.cigarId)).limit(1);
  const cigar = rows[0];
  if (!cigar) throw new CigarNotFoundError();

  const plans = planFields(input);
  const changedFields: string[] = [];
  const skipped: string[] = [];
  const set: Partial<NewCigarRow> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  // A verified cigar is curator-owned — chat fills nothing (never touches verified
  // values). On an unverified entry a field is written only while it is null.
  for (const plan of plans) {
    const currentValue = (cigar as unknown as Record<string, unknown>)[plan.column as string];
    const writable = cigar.verification === "unverified" && currentValue == null;
    if (!writable) {
      skipped.push(plan.label);
      continue;
    }
    (set as Record<string, unknown>)[plan.column as string] = plan.next;
    before[plan.label] = currentValue ?? null;
    after[plan.label] = plan.next;
    changedFields.push(plan.label);
  }

  if (changedFields.length > 0) {
    await tx
      .update(cigars)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(cigars.id, input.cigarId));

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, provenanceToActor(input.provenance?.source ?? "llm-conversation")),
      action: "cigar.update",
      smokeId: null,
      before,
      after,
      correlationId: input.correlationId ?? input.clientRequestId,
    });
  }

  const result: UpdateCigarResult = {
    cigarId: input.cigarId,
    changedFields,
    skipped,
    verification: cigar.verification as CigarRow["verification"],
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "update_cigar",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}
