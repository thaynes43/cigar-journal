import { asc, eq, sql } from "drizzle-orm";
import {
  auditLog,
  cigars,
  duplicateDismissals,
  smokes,
  purchases,
  listingMatches,
  productPhotos,
  enrichmentRequests,
  type CigarRow,
} from "@cj/db";
import type { Deps, Principal, Queryer, Tx } from "./deps.js";
import type {
  MergeCigarsInput,
  MergeCigarsResult,
  VerifyCigarInput,
  VerifyCigarResult,
  DismissDuplicateInput,
  DismissDuplicateResult,
  CurationQueueResult,
  CurationQueueCigar,
} from "./types.js";
import { fingerprint } from "./fingerprint.js";
import { numbersCompatible } from "./cigar-resolution.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { CigarNotFoundError, UnauthorizedError, ValidationError } from "./errors.js";

// Catalog hygiene — the curator's toolkit (ADR-006). Merge re-points every
// reference off a duplicate and deletes it; verify flips the lifecycle flag; the
// queue surfaces the unverified backlog and near-duplicate candidates. All three
// are curator-only: verification and duplicate-merge are curator-only per ADR-006
// and the DDD contexts doc, and the queue reveals the whole catalog's hygiene
// state, so it is gated too. Mutations audit in-transaction and are idempotent
// through the ADR-003 envelope (house pattern, mirrors save/update).

// Trigram similarity at or above this counts two canonical names as a
// near-duplicate candidate — the same STRONG_MATCH bar cigar-resolution links
// at, so the queue surfaces exactly the pairs the resolver would have hesitated
// over. The `%` operator prefilters against the GIN index; this threshold decides.
const DUPLICATE_THRESHOLD = 0.6;

// Caps so an admin page over a large seeded catalog (a vendor crawl can land
// ~1,900 rows) stays a bounded read. Oldest/most-similar first, so the highest-
// priority hygiene work is always in view.
const DUPLICATE_PAIR_CAP = 50;
const UNVERIFIED_CAP = 200;

function assertCurator(principal: Principal): void {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Curation is restricted to catalog curators.");
  }
}

// JSON-safe audit snapshot of a catalog row — dates as ISO strings.
function cigarSnapshot(row: CigarRow): Record<string, unknown> {
  return {
    id: row.id,
    canonicalName: row.canonicalName,
    brand: row.brand,
    line: row.line,
    edition: row.edition,
    vitolaName: row.vitolaName,
    type: row.type,
    manufacturer: row.manufacturer,
    verification: row.verification,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadCigar(tx: Queryer, cigarId: string): Promise<CigarRow | undefined> {
  const rows = await tx.select().from(cigars).where(eq(cigars.id, cigarId)).limit(1);
  return rows[0];
}

// --------------------------------------------------------------------------
// mergeCigars — fold a duplicate into the surviving entry (curator-only).
// --------------------------------------------------------------------------

export async function mergeCigars(
  deps: Deps,
  principal: Principal,
  input: MergeCigarsInput,
): Promise<MergeCigarsResult> {
  assertCurator(principal);
  if (input.sourceCigarId === input.targetCigarId) {
    throw new ValidationError([{ path: "targetCigarId", message: "Source and target must differ." }]);
  }
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => mergeWithinTx(tx, principal, input, requestFingerprint));
  } catch (error) {
    // Concurrent first-writer committed the key between our check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as MergeCigarsResult), replayed: true };
      }
    }
    throw error;
  }
}

async function mergeWithinTx(
  tx: Tx,
  principal: Principal,
  input: MergeCigarsInput,
  requestFingerprint: string,
): Promise<MergeCigarsResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as MergeCigarsResult), replayed: true };
  }

  // Cigars carry no version column; existence + distinct-id are the safety net,
  // and the whole re-point + delete runs in one transaction so a concurrent
  // merge that removed either row loses the FK re-point atomically.
  const source = await loadCigar(tx, input.sourceCigarId);
  const target = await loadCigar(tx, input.targetCigarId);
  if (!source || !target) throw new CigarNotFoundError();

  const before = { source: cigarSnapshot(source), target: cigarSnapshot(target) };

  // Re-point the owned references (Smokes, Purchases, Listing Matches — ADR-006).
  const smokeRows = await tx
    .update(smokes)
    .set({ cigarId: target.id })
    .where(eq(smokes.cigarId, source.id))
    .returning({ id: smokes.id });
  const purchaseRows = await tx
    .update(purchases)
    .set({ cigarId: target.id })
    .where(eq(purchases.cigarId, source.id))
    .returning({ id: purchases.id });
  const listingRows = await tx
    .update(listingMatches)
    .set({ cigarId: target.id })
    .where(eq(listingMatches.cigarId, source.id))
    .returning({ id: listingMatches.id });

  // Product photo: at most one per cigar (unique constraint). The target keeps
  // its own when it has one; otherwise it adopts the source's. When the target
  // already has a photo the source's is discarded — the cigar-delete cascade
  // (product_photos.cigar_id ON DELETE CASCADE) removes it.
  const targetPhoto = await tx
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, target.id))
    .limit(1);
  const sourcePhoto = await tx
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, source.id))
    .limit(1);
  let productPhotosRepointed = 0;
  if (sourcePhoto[0] && !targetPhoto[0]) {
    await tx.update(productPhotos).set({ cigarId: target.id }).where(eq(productPhotos.cigarId, source.id));
    productPhotosRepointed = 1;
  }

  // Enrichment requests re-point too, so an open gap-fill for the duplicate keeps
  // working against the survivor (no unique constraint, so duplicates are benign).
  const enrichmentRows = await tx
    .update(enrichmentRequests)
    .set({ cigarId: target.id })
    .where(eq(enrichmentRequests.cigarId, source.id))
    .returning({ id: enrichmentRequests.id });

  // Everything is off the source now; delete it (any leftover source photo goes
  // via cascade).
  await tx.delete(cigars).where(eq(cigars.id, source.id));

  const repointed = {
    smokes: smokeRows.length,
    purchases: purchaseRows.length,
    listingMatches: listingRows.length,
    productPhotos: productPhotosRepointed,
    enrichmentRequests: enrichmentRows.length,
  };

  await tx.insert(auditLog).values({
    userId: principal.userId,
    actor: "web",
    action: "cigar.merge",
    smokeId: null,
    before,
    after: { target: cigarSnapshot(target), deletedSourceId: source.id, repointed },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: MergeCigarsResult = {
    sourceCigarId: source.id,
    targetCigarId: target.id,
    repointed,
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "merge_cigars",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// verifyCigar — flip the catalog lifecycle flag to verified (curator-only).
// --------------------------------------------------------------------------

export async function verifyCigar(
  deps: Deps,
  principal: Principal,
  input: VerifyCigarInput,
): Promise<VerifyCigarResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => verifyWithinTx(tx, deps, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as VerifyCigarResult), replayed: true };
      }
    }
    throw error;
  }
}

async function verifyWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: VerifyCigarInput,
  requestFingerprint: string,
): Promise<VerifyCigarResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as VerifyCigarResult), replayed: true };
  }

  const current = await loadCigar(tx, input.cigarId);
  if (!current) throw new CigarNotFoundError();

  const before = cigarSnapshot(current);
  await tx
    .update(cigars)
    .set({ verification: "verified", updatedAt: deps.now() })
    .where(eq(cigars.id, current.id));

  await tx.insert(auditLog).values({
    userId: principal.userId,
    actor: "web",
    action: "cigar.verify",
    smokeId: null,
    before,
    after: { ...before, verification: "verified" },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: VerifyCigarResult = {
    cigarId: current.id,
    verification: "verified",
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "verify_cigar",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// dismissDuplicate — record that a candidate pair is not a duplicate
// (curator-only).
// --------------------------------------------------------------------------

export async function dismissDuplicate(
  deps: Deps,
  principal: Principal,
  input: DismissDuplicateInput,
): Promise<DismissDuplicateResult> {
  assertCurator(principal);
  if (input.cigarAId === input.cigarBId) {
    throw new ValidationError([{ path: "cigarBId", message: "A pair needs two distinct cigars." }]);
  }
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction((tx) => dismissWithinTx(tx, principal, input, requestFingerprint));
  } catch (error) {
    // Concurrent first-writer committed the key between our check and insert.
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as DismissDuplicateResult), replayed: true };
      }
    }
    throw error;
  }
}

async function dismissWithinTx(
  tx: Tx,
  principal: Principal,
  input: DismissDuplicateInput,
  requestFingerprint: string,
): Promise<DismissDuplicateResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as DismissDuplicateResult), replayed: true };
  }

  // Normalize to the queue's id-ordering (c1.id < c2.id) so a dismissal filed
  // from either direction matches the surfaced pair. Lexicographic comparison
  // of canonical lowercase UUID strings agrees with Postgres uuid ordering, so
  // this also satisfies the table's CHECK (cigar_a_id < cigar_b_id).
  const [aId, bId] =
    input.cigarAId < input.cigarBId ? [input.cigarAId, input.cigarBId] : [input.cigarBId, input.cigarAId];

  const a = await loadCigar(tx, aId);
  const b = await loadCigar(tx, bId);
  if (!a || !b) throw new CigarNotFoundError();

  // Naturally idempotent: a pair dismissed by an earlier request (or another
  // curator) stays dismissed; the conflict is not an error.
  await tx
    .insert(duplicateDismissals)
    .values({ cigarAId: aId, cigarBId: bId, dismissedBy: principal.userId })
    .onConflictDoNothing();

  await tx.insert(auditLog).values({
    userId: principal.userId,
    actor: "web",
    action: "cigar.dismiss_duplicate",
    smokeId: null,
    before: { a: cigarSnapshot(a), b: cigarSnapshot(b) },
    after: { dismissed: { cigarAId: aId, cigarBId: bId } },
    correlationId: input.correlationId ?? input.clientRequestId,
  });

  const result: DismissDuplicateResult = { cigarAId: aId, cigarBId: bId, replayed: false };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "dismiss_duplicate",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}

// --------------------------------------------------------------------------
// curationQueue — the admin read: unverified backlog + duplicate candidates.
// --------------------------------------------------------------------------

// Load identity + reference counts for a set of cigars, keyed by id. The counts
// are correlated subqueries (offer counts hop through listing_matches, since an
// Offer references a Cigar only via its match). One round trip regardless of set
// size.
async function queueCigarsByIds(tx: Queryer, ids: string[]): Promise<Map<string, CurationQueueCigar>> {
  if (ids.length === 0) return new Map();
  // Raw SQL with explicit table aliases: the offer count hops offers → matches →
  // cigar, and every subquery reuses `id`/`cigar_id`, so the aliases are what
  // keep the correlation unambiguous.
  const result = await tx.execute(sql`
    SELECT c.id AS cigar_id, c.canonical_name, c.brand, c.created_at,
           (SELECT count(*) FROM smokes s WHERE s.cigar_id = c.id)::int AS smoke_count,
           (SELECT count(*) FROM purchases p WHERE p.cigar_id = c.id)::int AS purchase_count,
           (SELECT count(*) FROM offers o
              JOIN listing_matches lm ON o.listing_match_id = lm.id
              WHERE lm.cigar_id = c.id)::int AS offer_count
    FROM cigars c
    WHERE c.id::text IN (${sql.join(ids, sql`, `)})
  `);
  const rows = result.rows as unknown as {
    cigar_id: string;
    canonical_name: string;
    brand: string | null;
    created_at: Date;
    smoke_count: number;
    purchase_count: number;
    offer_count: number;
  }[];

  return new Map(
    rows.map((r) => [
      r.cigar_id,
      {
        cigarId: r.cigar_id,
        canonicalName: r.canonical_name,
        brand: r.brand,
        createdAt: new Date(r.created_at).toISOString(),
        smokeCount: Number(r.smoke_count),
        purchaseCount: Number(r.purchase_count),
        offerCount: Number(r.offer_count),
      },
    ]),
  );
}

export async function curationQueue(deps: Deps, principal: Principal): Promise<CurationQueueResult> {
  assertCurator(principal);
  const db = deps.db;

  // Unverified backlog, oldest first (the entries that have waited longest).
  const unverifiedIdRows = await db
    .select({ id: cigars.id })
    .from(cigars)
    .where(eq(cigars.verification, "unverified"))
    .orderBy(asc(cigars.createdAt))
    .limit(UNVERIFIED_CAP);
  const unverifiedIds = unverifiedIdRows.map((r) => r.id);

  // Near-duplicate candidate pairs across DISTINCT rows (c1.id < c2.id dedupes
  // the mirror pair). The `%` join prefilters via the trigram GIN index; the
  // explicit similarity filter applies the strong-match bar. Pairs a curator
  // has ruled distinct (duplicate_dismissals, stored with the same id-ordering)
  // stay out of the queue.
  const pairResult = await db.execute(sql`
    SELECT c1.id AS a_id, c2.id AS b_id,
           c1.canonical_name AS a_name, c2.canonical_name AS b_name,
           similarity(c1.canonical_name, c2.canonical_name) AS sim
    FROM cigars c1
    JOIN cigars c2 ON c1.id < c2.id AND c1.canonical_name % c2.canonical_name
    WHERE similarity(c1.canonical_name, c2.canonical_name) > ${DUPLICATE_THRESHOLD}
      AND NOT EXISTS (
        SELECT 1 FROM duplicate_dismissals d
        WHERE d.cigar_a_id = c1.id AND d.cigar_b_id = c2.id
      )
    ORDER BY sim DESC
    LIMIT ${DUPLICATE_PAIR_CAP}
  `);
  const rawPairRows = pairResult.rows as unknown as {
    a_id: string;
    b_id: string;
    a_name: string;
    b_name: string;
    sim: number;
  }[];

  // The resolver's number-token guard, applied to candidates: names carrying
  // mutually distinct digit-bearing tokens ("No. 9" vs "T52", "1964" vs "1926")
  // are different products by definition — never merge candidates, regardless
  // of trigram score. Post-filtering after the LIMIT can under-fill a capped
  // page, which is acceptable for an admin backlog view.
  const pairRows = rawPairRows.filter((p) => numbersCompatible(p.a_name, p.b_name));

  // One metadata+counts fetch for every cigar referenced by either list.
  const allIds = new Set<string>(unverifiedIds);
  for (const p of pairRows) {
    allIds.add(p.a_id);
    allIds.add(p.b_id);
  }
  const meta = await queueCigarsByIds(db, [...allIds]);

  const unverified = unverifiedIds.map((id) => meta.get(id)).filter((c): c is CurationQueueCigar => c != null);
  const duplicates = pairRows
    .map((p) => {
      const a = meta.get(p.a_id);
      const b = meta.get(p.b_id);
      return a && b ? { similarity: Number(p.sim), a, b } : null;
    })
    .filter((p): p is { similarity: number; a: CurationQueueCigar; b: CurationQueueCigar } => p != null);

  return { unverified, duplicates };
}
