import { sql, eq } from "drizzle-orm";
import { cigars } from "@cj/db";
import type { Tx } from "./deps.js";
import type { CigarRef, Verification } from "./types.js";
import { CigarNotFoundError, CigarAmbiguousError, ValidationError } from "./errors.js";

// Similarity at or above this counts as a strong catalog match — link rather
// than create. Tuned against pg_trgm on canonical names; the `%` prefilter
// (default 0.3) narrows candidates, this threshold decides linking.
const STRONG_MATCH = 0.6;

// Model tokens are name tokens carrying a digit — product numbers ("1926",
// "1964") or alphanumeric model codes ("T52"). Trigram similarity is blind to
// these: "1964 Maduro" and "1926 Maduro" score 0.6 purely on shared letters, so
// a strong score alone once linked number-distinct products in production
// ("1964 Maduro"→"Padron 1926 Maduro", "Liga Privada T52"→"...No. 9"). Two names
// are number-INCOMPATIBLE when each carries a distinct digit-bearing token the
// other lacks; such a pair is disqualified from strong-linking (it may still
// surface as an ordinary candidate). Names with no digit token on either side
// are unaffected.
function modelTokens(name: string): Set<string> {
  const tokens = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens.filter((t) => /[0-9]/.test(t)));
}

function hasExtra(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (!b.has(token)) return true;
  return false;
}

// Exported for the curation queue (ADR-006), which applies the same guard to
// near-duplicate candidate pairs: number-distinct siblings are different
// products by definition, never merge candidates.
export function numbersCompatible(query: string, candidate: string): boolean {
  const q = modelTokens(query);
  const c = modelTokens(candidate);
  if (q.size === 0 || c.size === 0) return true;
  // Incompatible only when each side has a digit-bearing token the other lacks —
  // i.e. the names name genuinely different product numbers.
  return !(hasExtra(q, c) && hasExtra(c, q));
}

export interface ResolvedCigar {
  cigarId: string;
  canonicalName: string;
  verification: Verification;
  created: boolean;
}

interface CandidateRow {
  id: string;
  canonical_name: string;
  brand: string | null;
  vitola_name: string | null;
  verification: Verification;
  sim: number;
}

// Resolve a Smoke's cigar reference to a catalog id, upholding the catalog
// invariant (ADR-002): a resolved id links; `described` links on a single
// strong match, errors `cigar_ambiguous` when it can't decide, and otherwise
// creates an `unverified` entry — all inside the caller's transaction.
export async function resolveCigar(tx: Tx, ref: CigarRef): Promise<ResolvedCigar> {
  if ("cigarId" in ref) {
    const rows = await tx
      .select({
        id: cigars.id,
        canonicalName: cigars.canonicalName,
        verification: cigars.verification,
      })
      .from(cigars)
      .where(eq(cigars.id, ref.cigarId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new CigarNotFoundError();
    return {
      cigarId: row.id,
      canonicalName: row.canonicalName,
      verification: row.verification,
      created: false,
    };
  }

  const described = ref.described;
  const name = described.canonicalName?.trim();
  if (!name) {
    throw new ValidationError([{ path: "cigar.described.canonicalName", message: "Required." }]);
  }

  const result = await tx.execute(sql`
    SELECT id, canonical_name, brand, vitola_name, verification, similarity(canonical_name, ${name}) AS sim
    FROM cigars
    WHERE canonical_name % ${name}
    ORDER BY sim DESC
    LIMIT 10
  `);
  const candidates = result.rows as unknown as CandidateRow[];
  const strong = candidates.filter(
    (c) => Number(c.sim) >= STRONG_MATCH && numbersCompatible(name, c.canonical_name),
  );

  if (strong.length === 1) {
    const match = strong[0]!;
    return {
      cigarId: match.id,
      canonicalName: match.canonical_name,
      verification: match.verification,
      created: false,
    };
  }
  if (strong.length > 1) {
    throw new CigarAmbiguousError(
      name,
      strong.map((c) => ({
        cigarId: c.id,
        canonicalName: c.canonical_name,
        brand: c.brand,
        vitola: c.vitola_name,
        verification: c.verification,
      })),
    );
  }

  const inserted = await tx
    .insert(cigars)
    .values({
      canonicalName: name,
      brand: described.brand ?? null,
      line: described.line ?? null,
      edition: described.edition ?? null,
      vitolaName: described.vitola?.name ?? null,
      lengthInches:
        described.vitola?.lengthInches != null ? String(described.vitola.lengthInches) : null,
      ringGauge: described.vitola?.ringGauge ?? null,
      type: described.type ?? null,
      manufacturer: described.manufacturer ?? null,
      factory: described.factory ?? null,
      productionCountry: described.productionCountry ?? null,
      tobacco: described.tobacco ?? null,
      blendNotes: described.blendNotes ?? null,
      releaseYear: described.releaseYear ?? null,
      verification: "unverified",
    })
    .returning({
      id: cigars.id,
      canonicalName: cigars.canonicalName,
      verification: cigars.verification,
    });
  const created = inserted[0]!;
  return {
    cigarId: created.id,
    canonicalName: created.canonicalName,
    verification: created.verification,
    created: true,
  };
}
