import { sql, type SQL } from "drizzle-orm";
import { smokes } from "@cj/db";
import { isUuid } from "./uuid.js";

// Keyset cursor for the journal lists (web infinite scroll), shared by the
// owner-scoped queryMySmokes and the anonymous queryPublicSmokes. Both order by
// (smokedAt DESC NULLS LAST, createdAt DESC, id DESC), so the cursor carries all
// three keys — smokedAt is nullable, hence the null tail below. Mirrors the
// opaque base64url cursor in catalog-browse.ts; the MCP tool never issues one.
export interface SmokeCursor {
  smokedAt: string | null; // ISO instant, or null for the never-timestamped tail
  createdAt: string; // ISO instant
  id: string; // uuid, the final tie-breaker
}

export function encodeSmokeCursor(c: SmokeCursor): string {
  return Buffer.from(JSON.stringify([c.smokedAt, c.createdAt, c.id]), "utf8").toString("base64url");
}

// A malformed cursor is treated as absent (first page) rather than an error — a
// stale link degrades gracefully, exactly as catalog-browse decodes its cursor.
//
// "Malformed" has to mean every cursor we could not have issued, not merely one
// that fails to parse as JSON. The three fields are spent unquoted downstream —
// `id` reaches `${c.id}::uuid` in afterSmokeCursor, and the two instants are
// handed to `new Date()`, whose Invalid Date the pg driver throws on while
// serializing. So a well-formed base64 envelope carrying junk in any of the three
// used to reach the database and 500, and the promise this comment makes was
// untrue precisely where it mattered: queryPublicSmokes takes its cursor from an
// ANONYMOUS request, which made this the one unauthenticated cast in the domain
// (#206; see ./uuid.ts for why malformed is answered as absent rather than
// rejected). Shape-checking here keeps both call sites free of the concern.
export function decodeSmokeCursor(raw: string | null | undefined): SmokeCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      (parsed[0] === null || isInstant(parsed[0])) &&
      isInstant(parsed[1]) &&
      typeof parsed[2] === "string" &&
      isUuid(parsed[2])
    ) {
      return { smokedAt: parsed[0], createdAt: parsed[1], id: parsed[2] };
    }
    return null;
  } catch {
    return null;
  }
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

// The "rows strictly after the cursor" predicate for the list's compound order
// (smokedAt DESC NULLS LAST, createdAt DESC, id DESC). NULLS LAST means a null
// smokedAt sorts after every timestamped row, so a non-null cursor also admits
// the null tail; a null cursor is already inside that tail and only walks it.
export function afterSmokeCursor(c: SmokeCursor): SQL {
  const created = new Date(c.createdAt);
  if (c.smokedAt !== null) {
    const smoked = new Date(c.smokedAt);
    return sql`(
      ${smokes.smokedAt} IS NULL
      OR ${smokes.smokedAt} < ${smoked}
      OR (${smokes.smokedAt} = ${smoked} AND ${smokes.createdAt} < ${created})
      OR (${smokes.smokedAt} = ${smoked} AND ${smokes.createdAt} = ${created} AND ${smokes.id} < ${c.id}::uuid)
    )`;
  }
  return sql`(
    ${smokes.smokedAt} IS NULL
    AND (
      ${smokes.createdAt} < ${created}
      OR (${smokes.createdAt} = ${created} AND ${smokes.id} < ${c.id}::uuid)
    )
  )`;
}
