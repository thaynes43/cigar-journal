import { and, eq } from "drizzle-orm";
import { idempotencyKeys, type IdempotencyKeyRow } from "@cj/db";
import type { Tx, Queryer } from "./deps.js";
import { IdempotencyConflictError } from "./errors.js";

// Shared mutation-envelope handling (ADR-003 / flow 004). The key row lands in
// the same transaction as the effect, so there is never an effect without its
// key. Replay is decided by fingerprint equality.

export async function loadIdempotency(
  tx: Queryer,
  userId: string,
  clientRequestId: string,
): Promise<IdempotencyKeyRow | undefined> {
  const rows = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.clientRequestId, clientRequestId)))
    .limit(1);
  return rows[0];
}

export function assertReplayable(existing: IdempotencyKeyRow, requestFingerprint: string): void {
  if (existing.requestFingerprint !== requestFingerprint) throw new IdempotencyConflictError();
}

export async function recordIdempotency(
  tx: Tx,
  args: {
    userId: string;
    clientRequestId: string;
    tool: string;
    requestFingerprint: string;
    smokeId: string | null;
    result: unknown;
  },
): Promise<void> {
  await tx.insert(idempotencyKeys).values({
    userId: args.userId,
    clientRequestId: args.clientRequestId,
    tool: args.tool,
    requestFingerprint: args.requestFingerprint,
    smokeId: args.smokeId,
    result: args.result,
  });
}

// Postgres unique_violation — the concurrent-first-writer backstop for the key.
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}
