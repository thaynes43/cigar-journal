import { sql } from "drizzle-orm";
import { auditLog, cigars, vendors } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { RecordPriceInput, RecordPriceResult } from "./types.js";
import { fingerprint } from "./fingerprint.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { provenanceToActor } from "./mapping.js";
import { isUuid } from "./uuid.js";
import { CigarNotFoundError, ValidationError } from "./errors.js";
import { recordPriceObservation } from "./price-observations.js";

// Chat-submitted price observation (ADR-009). Writes into the SAME offers model
// and through the SAME 24h dedupe as the crawler — one price store, one duplicate
// rule. Operates on an existing cigar; a source is required (a registry vendor by
// name, else a named ad-hoc source — the CHECK forbids neither). Per-stick is
// computed when the packaging count is known, never guessed, and a bare per-stick
// figure never travels without its packaging. Retry-safe through the envelope.

function centsFromDollars(dollars: number): number {
  return Math.round(dollars * 100);
}

// Resolve the source: a registry vendor by case-insensitive name (the offer is
// then vendor-attributed), else the given name as a named ad-hoc source. An
// unmatched vendor name IS a valid ad-hoc source name, so it is never lost.
async function resolveSource(
  tx: Tx,
  input: RecordPriceInput,
): Promise<{ vendorId: string | null; vendorName: string | null; sourceName: string | null; sourceUrl: string | null }> {
  const vendorName = input.vendorName?.trim() || null;
  const url = input.sourceUrl?.trim() || null;

  if (vendorName) {
    const rows = await tx
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(sql`lower(${vendors.name}) = lower(${vendorName})`)
      .limit(1);
    if (rows[0]) return { vendorId: rows[0].id, vendorName: rows[0].name, sourceName: null, sourceUrl: null };
    // Unmatched vendor name → treat the name itself as the ad-hoc source.
    return { vendorId: null, vendorName: null, sourceName: vendorName, sourceUrl: url };
  }

  const sourceName = input.sourceName?.trim() || null;
  if (sourceName) return { vendorId: null, vendorName: null, sourceName, sourceUrl: url };

  // No registry vendor and no named source — the vendor-or-source rule (ADR-009).
  throw new ValidationError([
    { path: "source", message: "A vendor name or a source name (with optional URL) is required." },
  ]);
}

export async function recordPrice(
  deps: Deps,
  principal: Principal,
  input: RecordPriceInput,
): Promise<RecordPriceResult> {
  validateRecordPrice(input);
  // Before the transaction: the cigar check lives inside it, so a 22P02 there
  // would abort a transaction the idempotency read has already used, and
  // isUniqueViolation would not recognise it to recover (./uuid.ts).
  if (!isUuid(input.cigarId)) throw new CigarNotFoundError();
  const requestFingerprint = fingerprint(input);
  try {
    return await deps.db.transaction((tx) => recordWithinTx(deps, tx, principal, input, requestFingerprint));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as RecordPriceResult), replayed: true };
      }
    }
    throw error;
  }
}

function validateRecordPrice(input: RecordPriceInput): void {
  const fields: { path: string; message: string }[] = [];
  if (!(typeof input.price === "number" && Number.isFinite(input.price) && input.price > 0)) {
    fields.push({ path: "price", message: "Must be a positive number of dollars." });
  }
  if (
    input.sticksPerPackage != null &&
    !(Number.isInteger(input.sticksPerPackage) && input.sticksPerPackage > 0)
  ) {
    fields.push({ path: "sticksPerPackage", message: "Must be a positive integer." });
  }
  if (input.observedAt != null && Number.isNaN(new Date(input.observedAt).getTime())) {
    fields.push({ path: "observedAt", message: "Must be a valid date or date-time." });
  }
  if (fields.length > 0) throw new ValidationError(fields);
}

async function recordWithinTx(
  deps: Deps,
  tx: Tx,
  principal: Principal,
  input: RecordPriceInput,
  requestFingerprint: string,
): Promise<RecordPriceResult> {
  const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as RecordPriceResult), replayed: true };
  }

  const cigarRows = await tx
    .select({ id: cigars.id })
    .from(cigars)
    .where(sql`${cigars.id} = ${input.cigarId}`)
    .limit(1);
  if (!cigarRows[0]) throw new CigarNotFoundError();

  const source = await resolveSource(tx, input);
  const seenAt = input.observedAt ? new Date(input.observedAt) : deps.now();
  const priceCents = centsFromDollars(input.price);
  const currency = input.currency?.trim() || "USD";
  const packaging = input.packaging?.trim() || null;
  const sticksPerPackage = input.sticksPerPackage ?? null;
  const priceType = input.priceType ?? "retail";

  const observation = await recordPriceObservation(tx, {
    cigarId: input.cigarId,
    vendorId: source.vendorId,
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
    listingMatchId: null,
    listingUrl: null,
    packaging,
    sticksPerPackage,
    priceCents,
    currency,
    inStock: input.inStock ?? null,
    priceType,
    raw: { source: "record_price" },
    seenAt,
  });

  // Audit only a real write — a deduped no-op writes nothing, mirroring the
  // append writers skipping a duplicate audit on replay.
  if (observation.inserted) {
    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, provenanceToActor(input.provenance?.source ?? "llm-conversation")),
      action: "price.record",
      smokeId: null,
      before: null,
      after: {
        offerId: observation.offerId,
        cigarId: input.cigarId,
        priceCents,
        currency,
        packaging,
        priceType,
        vendorId: source.vendorId,
        sourceName: source.sourceName,
      },
      correlationId: input.correlationId ?? input.clientRequestId,
    });
  }

  const result: RecordPriceResult = {
    observationId: observation.offerId,
    cigarId: input.cigarId,
    recorded: observation.inserted,
    deduped: !observation.inserted,
    packaging,
    pricePerStick: observation.pricePerStickCents != null ? observation.pricePerStickCents / 100 : null,
    currency,
    priceType,
    observedAt: seenAt.toISOString(),
    source: {
      vendorId: source.vendorId,
      vendorName: source.vendorName,
      name: source.sourceName,
      url: source.sourceUrl,
    },
    replayed: false,
  };

  await recordIdempotency(tx, {
    userId: principal.userId,
    clientRequestId: input.clientRequestId,
    tool: "record_price",
    requestFingerprint,
    smokeId: null,
    result,
  });

  return result;
}
