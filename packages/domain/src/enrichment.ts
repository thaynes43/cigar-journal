import { and, eq, inArray } from "drizzle-orm";
import { cigars, enrichmentRequests, productPhotos } from "@cj/db";
import type { Tx } from "./deps.js";
import type { CigarRef } from "./types.js";
import { resolveCigar, type ResolvedCigar } from "./cigar-resolution.js";

// The conversational gap-fill path (owner, 2026-08-28): resolve-or-create the
// described cigar through the SAME logic save_smoke uses (resolveCigar — the
// single catalog-invariant resolver, ADR-002), then queue background enrichment
// so the crawler can fill the missing specs and a product photo. add_cigar and
// record_purchase both go through here; the resolve step never forks.

export interface ResolveAndEnrichResult {
  cigar: ResolvedCigar;
  enrichmentQueued: boolean;
}

// Queue an enrichment_request for a cigar unless nothing is gained. Skipped when
// a fulfilled or still-pending request already exists (append-once — no dupes on
// a second add), or when the cigar already carries both a product photo and full
// vitola dimensions (nothing left to fill). Returns whether a row was inserted.
export async function maybeQueueEnrichment(
  tx: Tx,
  cigarId: string,
  requestedBy: string,
): Promise<boolean> {
  const open = await tx
    .select({ id: enrichmentRequests.id })
    .from(enrichmentRequests)
    .where(
      and(
        eq(enrichmentRequests.cigarId, cigarId),
        inArray(enrichmentRequests.status, ["pending", "fulfilled"]),
      ),
    )
    .limit(1);
  if (open.length > 0) return false;

  const cigarRows = await tx
    .select({ lengthInches: cigars.lengthInches, ringGauge: cigars.ringGauge })
    .from(cigars)
    .where(eq(cigars.id, cigarId))
    .limit(1);
  const cigar = cigarRows[0];
  const photoRows = await tx
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, cigarId))
    .limit(1);

  const hasPhoto = photoRows.length > 0;
  const hasDims = cigar != null && cigar.lengthInches != null && cigar.ringGauge != null;
  // Both a photo and full dims → the entry is already complete; don't enqueue.
  if (hasPhoto && hasDims) return false;

  await tx.insert(enrichmentRequests).values({ cigarId, requestedBy });
  return true;
}

// Resolve (or lazily create) the cigar, then optionally queue enrichment. The
// enrichment gate is evaluated on both create AND resolve, so a described name
// that links to an existing but under-documented catalog row still gets filled.
export async function resolveAndEnrich(
  tx: Tx,
  ref: CigarRef,
  requestedBy: string,
  requestEnrichment: boolean,
): Promise<ResolveAndEnrichResult> {
  const cigar = await resolveCigar(tx, ref);
  const enrichmentQueued = requestEnrichment
    ? await maybeQueueEnrichment(tx, cigar.cigarId, requestedBy)
    : false;
  return { cigar, enrichmentQueued };
}
