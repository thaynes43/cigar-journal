import { sql, eq } from "drizzle-orm";
import { cigars } from "@cj/db";
import type { Tx } from "./deps.js";
import type { CigarRef, Verification } from "./types.js";
import { CigarNotFoundError, CigarAmbiguousError, ValidationError } from "./errors.js";

// Similarity at or above this counts as a strong catalog match — link rather
// than create. Tuned against pg_trgm on canonical names; the `%` prefilter
// (default 0.3) narrows candidates, this threshold decides linking.
const STRONG_MATCH = 0.6;

export interface ResolvedCigar {
  cigarId: string;
  canonicalName: string;
  verification: Verification;
  created: boolean;
}

interface CandidateRow {
  id: string;
  canonical_name: string;
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
      .select({ id: cigars.id, canonicalName: cigars.canonicalName, verification: cigars.verification })
      .from(cigars)
      .where(eq(cigars.id, ref.cigarId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new CigarNotFoundError();
    return { cigarId: row.id, canonicalName: row.canonicalName, verification: row.verification, created: false };
  }

  const described = ref.described;
  const name = described.canonicalName?.trim();
  if (!name) {
    throw new ValidationError([{ path: "cigar.described.canonicalName", message: "Required." }]);
  }

  const result = await tx.execute(sql`
    SELECT id, canonical_name, verification, similarity(canonical_name, ${name}) AS sim
    FROM cigars
    WHERE canonical_name % ${name}
    ORDER BY sim DESC
    LIMIT 10
  `);
  const candidates = result.rows as unknown as CandidateRow[];
  const strong = candidates.filter((c) => Number(c.sim) >= STRONG_MATCH);

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
      strong.map((c) => ({ cigarId: c.id, canonicalName: c.canonical_name })),
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
      lengthInches: described.vitola?.lengthInches != null ? String(described.vitola.lengthInches) : null,
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
    .returning({ id: cigars.id, canonicalName: cigars.canonicalName, verification: cigars.verification });
  const created = inserted[0]!;
  return {
    cigarId: created.id,
    canonicalName: created.canonicalName,
    verification: created.verification,
    created: true,
  };
}
