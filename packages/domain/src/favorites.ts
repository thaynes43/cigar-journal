import { and, eq, sql } from "drizzle-orm";
import { auditLog, cigars, favorites } from "@cj/db";
import type { Deps, Principal, Queryer, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { SetFavoriteInput, SetFavoriteResult } from "./types.js";
import { CigarNotFoundError } from "./errors.js";
import { provenanceToActor } from "./mapping.js";

// The single favorite mark (PRD-003, DESIGN-002) — the second cigar-level mark,
// mirroring setWant. Favorite = a cigar the user LOVES, distinct from Want (a
// cigar to try/own). Independent of holdings, smokes, and want: smoking never
// sets or clears it, acquisition does not touch it, and it is never inferred from
// a smoke's `liked` field (that stays explicit-only per the contract). One writer
// for both surfaces; principal is always passed explicitly (ADR-002).
//
// A target-state write, not an append: `favorited: true` upserts the (user, cigar)
// row, `false` deletes it. Both are idempotent by nature — repeating a call lands
// on the same state — so there is no clientRequestId/replay envelope (the
// UNIQUE(user_id, cigar_id) constraint is the whole retry-safety story). An audit
// row is written in the same transaction, but only when the effective state
// actually changed, mirroring how the append writers skip a duplicate audit on an
// idempotent replay.

const MAX_NOTE_LENGTH = 2000;

// Empty/whitespace notes collapse to null; anything longer than the cap is
// trimmed to fit rather than rejected — the note is a personal aide, not a
// validated field, and a favorite should never fail to set over its "why".
function normalizeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_NOTE_LENGTH ? trimmed.slice(0, MAX_NOTE_LENGTH) : trimmed;
}

export async function setFavorite(
  deps: Deps,
  principal: Principal,
  input: SetFavoriteInput,
): Promise<SetFavoriteResult> {
  // The cigar must exist — a bogus id is cigar_not_found, never a silent no-op
  // (and the FK would otherwise reject the insert as an opaque fault).
  const exists = await deps.db
    .select({ id: cigars.id })
    .from(cigars)
    .where(eq(cigars.id, input.cigarId))
    .limit(1);
  if (!exists[0]) throw new CigarNotFoundError();

  return deps.db.transaction((tx) => setWithinTx(tx, principal, input));
}

async function setWithinTx(
  tx: Tx,
  principal: Principal,
  input: SetFavoriteInput,
): Promise<SetFavoriteResult> {
  const note = normalizeNote(input.note);
  const prior = (
    await tx
      .select({ note: favorites.note })
      .from(favorites)
      .where(and(eq(favorites.userId, principal.userId), eq(favorites.cigarId, input.cigarId)))
      .limit(1)
  )[0];
  const wasFavorited = prior != null;
  const priorNote = prior?.note ?? null;

  let resultNote: string | null;
  let changed: boolean;

  if (input.favorited) {
    // Set: upsert. An omitted note keeps any existing one (COALESCE); a provided
    // note updates it. So a bare re-set never wipes a "why" the model recorded.
    resultNote = note ?? priorNote;
    changed = !wasFavorited || resultNote !== priorNote;
    if (changed) {
      await tx
        .insert(favorites)
        .values({ userId: principal.userId, cigarId: input.cigarId, note: resultNote })
        .onConflictDoUpdate({
          target: [favorites.userId, favorites.cigarId],
          set: { note: sql`COALESCE(EXCLUDED.note, ${favorites.note})` },
        });
    }
  } else {
    // Clear: delete the mark. Clearing an absent one is a no-op.
    resultNote = null;
    changed = wasFavorited;
    if (changed) {
      await tx
        .delete(favorites)
        .where(and(eq(favorites.userId, principal.userId), eq(favorites.cigarId, input.cigarId)));
    }
  }

  // Audit only real changes (ADR-002/003) — an idempotent no-op writes nothing,
  // exactly as an append writer's replay does not re-audit.
  if (changed) {
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, provenanceToActor(input.provenance?.source ?? "llm-conversation")),
      action: input.favorited ? "favorite.set" : "favorite.clear",
      smokeId: null,
      before: { cigarId: input.cigarId, favorited: wasFavorited, note: priorNote },
      after: { cigarId: input.cigarId, favorited: input.favorited, note: resultNote },
      correlationId: input.correlationId ?? null,
    });
  }

  return { cigarId: input.cigarId, favorited: input.favorited, note: resultNote, changed };
}

// Whether the caller currently favorites a given cigar — the scalar overlay
// reused by any single-cigar read. Principal-scoped, so it only ever reflects the
// caller's own mark.
export async function isFavorited(
  db: Queryer,
  userId: string,
  cigarId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: favorites.id })
    .from(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.cigarId, cigarId)))
    .limit(1);
  return rows.length > 0;
}
