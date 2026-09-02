import { and, eq } from "drizzle-orm";
import { auditLog, idempotencyKeys, smokePhotos, smokes, smokeProgression } from "@cj/db";
import type { PhotoStorage } from "@cj/photos";
import type { Deps, Principal, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { DeleteSmokeInput, DeleteSmokeResult } from "./types.js";
import { SmokeNotFoundError } from "./errors.js";
import { isUuid } from "./uuid.js";
import { smokeSnapshot } from "./mapping.js";

// Owner-scoped hard delete of a Smoke — web-only (ADR-002 / flow 005; MCP has no
// delete tool). The smoke, its progression, and its retry keys go; one audit
// tombstone (actor "web") preserves the full before-snapshot. @cj/domain is the
// single writer, so no other surface reaches this.
//
// `storage` is null when photos are unconfigured cluster-wide, which skips the
// object sweep below — as everywhere else, the journal works without a bucket.
export async function deleteSmoke(
  deps: Deps,
  storage: PhotoStorage | null,
  principal: Principal,
  input: DeleteSmokeInput,
): Promise<DeleteSmokeResult> {
  // The web procedure rejects a non-uuid a layer earlier (#204), so this is the
  // domain refusing to depend on its adapter rather than a live 500 — and it
  // refuses before opening a transaction it would only have to unwind
  // (./uuid.ts).
  if (!isUuid(input.smokeId)) throw new SmokeNotFoundError();

  // The keys are read BEFORE the transaction because the rows do not survive it:
  // smoke_photos cascades with the smoke, and the row is the only record of where
  // the bytes live. Owner-scoped exactly as the delete itself is, so a cross-user
  // smoke yields nothing here and is refused below without a sweep ever running.
  const doomed = storage
    ? await deps.db
        .select({ objectKey: smokePhotos.objectKey, thumbKey: smokePhotos.thumbKey })
        .from(smokePhotos)
        .where(and(eq(smokePhotos.smokeId, input.smokeId), eq(smokePhotos.userId, principal.userId)))
    : [];

  const result = await deps.db.transaction((tx) => deleteWithinTx(tx, principal, input));

  // AFTER the commit, best-effort (#264): ADR-007 puts object cleanup in
  // @cj/domain, not the DB, and until now a deleted smoke left every
  // `smoke/<id>/…` and claimed `drop/<dropId>/…` object in the bucket forever.
  // The ordering is removeSmokePhoto's and for its reason — a failed delete must
  // leave the photos servable, and an orphaned object is the cheaper failure.
  if (storage) {
    for (const photo of doomed) {
      await storage.delete(photo.objectKey).catch(() => {});
      await storage.delete(photo.thumbKey).catch(() => {});
    }
  }

  return result;
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
  // Cascades progression, photos and the consumption link. It also CLOSES any
  // photo drop claimed by this smoke, without a line here: `photo_drops.smoke_id`
  // is ON DELETE SET NULL (migration 0033), and claimed-with-no-smoke is exactly
  // how ADR-014 defines a closed drop — its link refuses further uploads and its
  // remainder is swept on the owner's next open.
  await tx.delete(smokes).where(eq(smokes.id, current.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    ...auditActor(principal, "web"),
    action: "smoke.deleted",
    smokeId: null,
    before,
    after: null,
    correlationId: input.correlationId ?? null,
  });

  return { smokeId: current.id };
}
