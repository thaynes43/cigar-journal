import { eq } from "drizzle-orm";
import { auditLog, idempotencyKeys, smokes, smokeProgression } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import type { DeleteSmokeInput, DeleteSmokeResult } from "./types.js";
import { SmokeNotFoundError } from "./errors.js";
import { smokeSnapshot } from "./mapping.js";

// Owner-scoped hard delete of a Smoke — web-only (ADR-002 / flow 005; MCP has no
// delete tool). The smoke, its progression, and its retry keys go; one audit
// tombstone (actor "web") preserves the full before-snapshot. @cj/domain is the
// single writer, so no other surface reaches this.
export async function deleteSmoke(
  deps: Deps,
  principal: Principal,
  input: DeleteSmokeInput,
): Promise<DeleteSmokeResult> {
  return deps.db.transaction((tx) => deleteWithinTx(tx, principal, input));
}

async function deleteWithinTx(
  tx: Tx,
  principal: Principal,
  input: DeleteSmokeInput,
): Promise<DeleteSmokeResult> {
  const rows = await tx.select().from(smokes).where(eq(smokes.id, input.smokeId)).limit(1);
  const current = rows[0];
  // Cross-user access is reported as not-found so a smoke's existence never
  // leaks to a non-owner (tool-contract error principle).
  if (!current || current.userId !== principal.userId) throw new SmokeNotFoundError();

  const progression = await tx
    .select()
    .from(smokeProgression)
    .where(eq(smokeProgression.smokeId, current.id))
    .orderBy(smokeProgression.ordinal);
  const before = smokeSnapshot(current, progression);

  // smoke_id on audit_log and idempotency_keys is a RESTRICT reference, so both
  // must be cleared before the smoke row can go. Prior audit rows are detached
  // (smoke_id → null) to keep the history; their JSON snapshots retain the id.
  // Retry keys are specific to this now-deleted aggregate, so they are removed.
  await tx.update(auditLog).set({ smokeId: null }).where(eq(auditLog.smokeId, current.id));
  await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.smokeId, current.id));
  await tx.delete(smokes).where(eq(smokes.id, current.id)); // cascades progression

  await tx.insert(auditLog).values({
    userId: principal.userId,
    actor: "web",
    action: "smoke.deleted",
    smokeId: null,
    before,
    after: null,
    correlationId: input.correlationId ?? null,
  });

  return { smokeId: current.id };
}
