import { and, eq, inArray } from "drizzle-orm";
import { auditLog, cigars, enrichmentRequests, productPhotos, type CigarRow } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import type { CigarRef, ProvenanceInput, Verification } from "./types.js";
import { resolveCigar, type ResolvedCigar } from "./cigar-resolution.js";
import { CigarNotFoundError } from "./errors.js";
import { provenanceToActor } from "./mapping.js";

// The conversational gap-fill path (owner, 2026-08-28): resolve-or-create the
// described cigar through the SAME logic save_smoke uses (resolveCigar — the
// single catalog-invariant resolver, ADR-002), then queue background enrichment
// so the crawler can fill the missing specs and a product photo. add_cigar and
// record_purchase both go through here; the resolve step never forks. ADR-009's
// request_cigar_enrichment repairs an EXISTING sparse cigar through the same
// queue and the same completeness gate.

export interface ResolveAndEnrichResult {
  cigar: ResolvedCigar;
  enrichmentQueued: boolean;
}

// What the crawler enrich flow can still fill for a cigar, and whether the entry
// is complete enough that queuing gains nothing. `complete` is the enqueue gate
// (a product photo AND full vitola dimensions — nothing the targeted lookup adds);
// `missingFields` is the fuller catalog-gap list surfaced to the model on
// get_cigar and request_cigar_enrichment. A pure function over already-loaded
// data so get_cigar reuses its own reads.
export interface EnrichmentAssessment {
  missingFields: string[];
  complete: boolean;
}

export function assessEnrichmentFields(cigar: CigarRow, hasProductPhoto: boolean): EnrichmentAssessment {
  const missingFields: string[] = [];
  if (cigar.brand == null) missingFields.push("brand");
  if (cigar.line == null) missingFields.push("line");
  if (cigar.vitolaName == null) missingFields.push("vitolaName");
  if (cigar.lengthInches == null || cigar.ringGauge == null) missingFields.push("dimensions");
  if (cigar.type == null) missingFields.push("type");
  if (cigar.productionCountry == null) missingFields.push("productionCountry");
  if (cigar.tobacco == null) missingFields.push("tobacco");
  if (cigar.blendNotes == null) missingFields.push("blendNotes");
  if (cigar.releaseYear == null) missingFields.push("releaseYear");
  if (!hasProductPhoto) missingFields.push("productPhoto");

  const hasDims = cigar.lengthInches != null && cigar.ringGauge != null;
  return { missingFields, complete: hasProductPhoto && hasDims };
}

async function loadAssessment(tx: Tx, cigarId: string): Promise<{ cigar: CigarRow; assessment: EnrichmentAssessment }> {
  const cigarRows = await tx.select().from(cigars).where(eq(cigars.id, cigarId)).limit(1);
  const cigar = cigarRows[0];
  if (!cigar) throw new CigarNotFoundError();
  const photoRows = await tx
    .select({ id: productPhotos.id })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, cigarId))
    .limit(1);
  return { cigar, assessment: assessEnrichmentFields(cigar, photoRows.length > 0) };
}

// Queue an enrichment_request for a cigar unless nothing is gained. Skipped when
// a fulfilled or still-pending request already exists (append-once — no dupes on
// a second add), or when the entry is already complete (photo + full dims —
// nothing left to fill). Returns whether a row was inserted.
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

  const { assessment } = await loadAssessment(tx, cigarId);
  // Already complete → the targeted lookup adds nothing; don't enqueue.
  if (assessment.complete) return false;

  await tx.insert(enrichmentRequests).values({ cigarId, requestedBy });
  return true;
}

// Resolve (or lazily create) the cigar, then optionally queue enrichment. The
// enrichment gate is evaluated on both create AND resolve, so a described name
// that links to an existing but under-documented catalog row still gets filled.
// `confirmedDistinct` is add_cigar's escape hatch, forwarded to the resolver (the
// record_purchase path never sets it — its resolve keeps default behavior).
export async function resolveAndEnrich(
  tx: Tx,
  ref: CigarRef,
  requestedBy: string,
  requestEnrichment: boolean,
  options?: { confirmedDistinct?: boolean },
): Promise<ResolveAndEnrichResult> {
  const cigar = await resolveCigar(tx, ref, options);
  const enrichmentQueued = requestEnrichment
    ? await maybeQueueEnrichment(tx, cigar.cigarId, requestedBy)
    : false;
  return { cigar, enrichmentQueued };
}

// ---- request_cigar_enrichment (ADR-009) ------------------------------------

// Conversational repair for an EXISTING sparse cigar (add_cigar covers only
// missing ones). Operates on a cigarId, reuses the enrichment_requests queue and
// its pending/fulfilled dedupe, and reports why it did (or didn't) queue. Never
// creates a cigar and never touches the journal. Target-state / idempotent (the
// queue dedupe is the whole retry-safety story) — no clientRequestId envelope,
// mirroring set_want.

export type EnrichmentRequestStatus = "queued" | "already_queued" | "recently_enriched" | "not_needed";

export interface RequestCigarEnrichmentInput {
  cigarId: string;
  note?: string | null;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface RequestCigarEnrichmentResult {
  cigarId: string;
  status: EnrichmentRequestStatus;
  missingFields: string[];
  verification: Verification;
  // Whether a request row was inserted — false for already_queued /
  // recently_enriched / not_needed (mirrors set_want's `changed`).
  queued: boolean;
}

const MAX_NOTE_LENGTH = 2000;

function normalizeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_NOTE_LENGTH ? trimmed.slice(0, MAX_NOTE_LENGTH) : trimmed;
}

export async function requestCigarEnrichment(
  deps: Deps,
  principal: Principal,
  input: RequestCigarEnrichmentInput,
): Promise<RequestCigarEnrichmentResult> {
  return deps.db.transaction(async (tx) => {
    const { cigar, assessment } = await loadAssessment(tx, input.cigarId);

    const open = await tx
      .select({ id: enrichmentRequests.id })
      .from(enrichmentRequests)
      .where(
        and(
          eq(enrichmentRequests.cigarId, input.cigarId),
          inArray(enrichmentRequests.status, ["pending", "in_progress"]),
        ),
      )
      .limit(1);
    const fulfilled = await tx
      .select({ id: enrichmentRequests.id })
      .from(enrichmentRequests)
      .where(and(eq(enrichmentRequests.cigarId, input.cigarId), eq(enrichmentRequests.status, "fulfilled")))
      .limit(1);

    let status: EnrichmentRequestStatus;
    if (assessment.complete) status = "not_needed";
    else if (open.length > 0) status = "already_queued";
    else if (fulfilled.length > 0) status = "recently_enriched";
    else status = "queued";

    if (status === "queued") {
      await tx.insert(enrichmentRequests).values({
        cigarId: input.cigarId,
        requestedBy: principal.userId,
        note: normalizeNote(input.note),
      });
      await tx.insert(auditLog).values({
        userId: principal.userId,
        actor: provenanceToActor(input.provenance?.source ?? "llm-conversation"),
        action: "cigar.enrichment_request",
        smokeId: null,
        before: null,
        after: { cigarId: input.cigarId, missingFields: assessment.missingFields },
        correlationId: input.correlationId ?? null,
      });
    }

    return {
      cigarId: input.cigarId,
      status,
      missingFields: assessment.missingFields,
      verification: cigar.verification,
      queued: status === "queued",
    };
  });
}
