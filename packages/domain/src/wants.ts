import { and, eq, sql } from "drizzle-orm";
import { auditLog, cigars, wants } from "@cj/db";
import type { Deps, Principal, Queryer, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { SetWantInput, SetWantResult } from "./types.js";
import { CigarNotFoundError } from "./errors.js";
import { provenanceToActor } from "./mapping.js";
import { isUuid } from "./uuid.js";

// The single want mark (PRD-003 R-WANT-1..3, DESIGN-002 §Want). Independent of
// holdings and smokes — smoking never touches it, acquisition only OFFERS the
// clear (record_purchase / the web purchase surfaces carry the flag; the clear
// is a separate, explicit setWant call). One writer for both surfaces; principal
// is always passed explicitly (ADR-002).
//
// A target-state write, not an append: `wanted: true` upserts the (user, cigar)
// row, `false` deletes it. Both are idempotent by nature — repeating a call
// lands on the same state — so there is no clientRequestId/replay envelope (the
// UNIQUE(user_id, cigar_id) constraint is the whole retry-safety story). An audit
// row is written in the same transaction, but only when the effective state
// actually changed, mirroring how the append writers skip a duplicate audit on an
// idempotent replay.

const MAX_NOTE_LENGTH = 2000;

// Empty/whitespace notes collapse to null; anything longer than the cap is
// trimmed to fit rather than rejected — the note is a personal aide, not a
// validated field, and a want should never fail to set over its "why".
function normalizeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_NOTE_LENGTH ? trimmed.slice(0, MAX_NOTE_LENGTH) : trimmed;
}

export async function setWant(
  deps: Deps,
  principal: Principal,
  input: SetWantInput,
): Promise<SetWantResult> {
  // A malformed id is answered as `cigar_not_found` too — the existence probe
  // below would raise 22P02 on it instead of returning no rows, and to the caller
  // the two cases mean the same thing (./uuid.ts).
  if (!isUuid(input.cigarId)) throw new CigarNotFoundError();

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
  input: SetWantInput,
): Promise<SetWantResult> {
  const note = normalizeNote(input.note);
  const prior = (
    await tx
      .select({ note: wants.note })
      .from(wants)
      .where(and(eq(wants.userId, principal.userId), eq(wants.cigarId, input.cigarId)))
      .limit(1)
  )[0];
  const wasWanted = prior != null;
  const priorNote = prior?.note ?? null;

  let resultNote: string | null;
  let changed: boolean;

  if (input.wanted) {
    // Set: upsert. An omitted note keeps any existing one (COALESCE); a provided
    // note updates it. So a bare re-set never wipes a "why" the model recorded.
    resultNote = note ?? priorNote;
    changed = !wasWanted || resultNote !== priorNote;
    if (changed) {
      await tx
        .insert(wants)
        .values({ userId: principal.userId, cigarId: input.cigarId, note: resultNote })
        .onConflictDoUpdate({
          target: [wants.userId, wants.cigarId],
          set: { note: sql`COALESCE(EXCLUDED.note, ${wants.note})` },
        });
    }
  } else {
    // Clear: delete the mark. Clearing an absent one is a no-op.
    resultNote = null;
    changed = wasWanted;
    if (changed) {
      await tx
        .delete(wants)
        .where(and(eq(wants.userId, principal.userId), eq(wants.cigarId, input.cigarId)));
    }
  }

  // Audit only real changes (ADR-002/003) — an idempotent no-op writes nothing,
  // exactly as an append writer's replay does not re-audit.
  if (changed) {
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, provenanceToActor(input.provenance?.source ?? "llm-conversation")),
      action: input.wanted ? "want.set" : "want.clear",
      smokeId: null,
      before: { cigarId: input.cigarId, wanted: wasWanted, note: priorNote },
      after: { cigarId: input.cigarId, wanted: input.wanted, note: resultNote },
      correlationId: input.correlationId ?? null,
    });
  }

  return { cigarId: input.cigarId, wanted: input.wanted, note: resultNote, changed };
}

// Whether the caller currently wants a given cigar — the scalar overlay reused by
// record_purchase (to offer the clear) and any single-cigar read. Principal-
// scoped, so it only ever reflects the caller's own mark.
export async function isWanted(
  db: Queryer,
  userId: string,
  cigarId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: wants.id })
    .from(wants)
    .where(and(eq(wants.userId, userId), eq(wants.cigarId, cigarId)))
    .limit(1);
  return rows.length > 0;
}
