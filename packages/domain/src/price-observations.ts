import { sql } from "drizzle-orm";
import { offers } from "@cj/db";
import type { Queryer } from "./deps.js";
import type { PriceType } from "./types.js";

// The single price-observation writer (ADR-009). One append-with-dedupe path for
// BOTH the background crawler and the conversational record_price tool, so the
// two can never diverge on what counts as a duplicate. `offers` is the store; a
// row carries a source (registry vendor OR named ad-hoc source), an optional
// packaging tier, and per-stick economics computed when derivable.

export type { PriceType };

// The 24h identical-observation window (ADR-009). An observation identical to the
// latest one for the same (subject, source, packaging) — same price, currency,
// availability — inside this window is skipped, not inserted. A price/stock change
// always inserts; history is never rewritten.
export const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PriceObservationInput {
  // The catalog cigar. Set directly for an ad-hoc/chat observation (no vendor
  // listing); null for a crawler listing that matched no catalog row yet.
  cigarId: string | null;
  // Source — exactly one is set. A registry vendor, OR a named ad-hoc source.
  vendorId: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  // Crawler linkage — the authoritative, curator-re-pointable cigar link.
  listingMatchId?: string | null;
  listingUrl?: string | null;
  // Packaging tier + count. Each packaging is its own series (owner ruling).
  packaging: string | null;
  sticksPerPackage: number | null;
  // Observed price in integer cents for the packaging unit, currency, availability.
  priceCents: number | null;
  currency: string | null;
  inStock: boolean | null;
  priceType: PriceType;
  raw?: unknown;
  seenAt: Date;
}

export interface RecordObservationResult {
  // Whether a row was written — false when the 24h dedupe skipped an identical obs.
  inserted: boolean;
  offerId: string | null;
  // The per-stick figure stored on the row (price / sticks), null when not derivable.
  pricePerStickCents: number | null;
}

// Per-stick economics, computed only when derivable — never guessed (ADR-009).
// A single (sticksPerPackage 1) yields the packaging price itself.
export function computePricePerStickCents(
  priceCents: number | null,
  sticksPerPackage: number | null,
): number | null {
  if (priceCents == null || sticksPerPackage == null || sticksPerPackage <= 0) return null;
  return Math.round(priceCents / sticksPerPackage);
}

function priceToDecimal(priceCents: number | null): string | null {
  return priceCents != null ? (priceCents / 100).toFixed(2) : null;
}

// The observation series this row belongs to: the crawler keys on its listing
// (per-SKU series), an ad-hoc observation keys on the cigar it names. Source is a
// vendor or the ad-hoc name. Packaging splits a subject into per-tier series.
function seriesPredicate(input: PriceObservationInput) {
  const subject =
    input.listingMatchId != null
      ? sql`o.listing_match_id = ${input.listingMatchId}`
      : sql`o.cigar_id = ${input.cigarId} AND o.listing_match_id IS NULL`;
  const source =
    input.vendorId != null
      ? sql`o.vendor_id = ${input.vendorId}`
      : sql`o.source_name = ${input.sourceName}`;
  return sql`${subject} AND ${source} AND o.packaging IS NOT DISTINCT FROM ${input.packaging}`;
}

interface LatestRow {
  price: string | null;
  currency: string | null;
  in_stock: boolean | null;
  seen_at: string | Date;
}

function sameNumber(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Number(a) === Number(b);
}

// Append a price observation, skipping the write when it is identical to the
// latest observation in the same series within the 24h window. Runs inside the
// caller's transaction (crawler ingest, record_price) so the dedupe read and the
// insert are one atomic step.
export async function recordPriceObservation(
  db: Queryer,
  input: PriceObservationInput,
): Promise<RecordObservationResult> {
  const pricePerStickCents = computePricePerStickCents(input.priceCents, input.sticksPerPackage);
  const priceDecimal = priceToDecimal(input.priceCents);

  const latest = await db.execute(sql`
    SELECT price, currency, in_stock, seen_at
    FROM offers o
    WHERE ${seriesPredicate(input)}
    ORDER BY o.seen_at DESC, o.created_at DESC, o.id DESC
    LIMIT 1
  `);
  const prior = (latest.rows as unknown as LatestRow[])[0];

  if (prior) {
    const identical =
      sameNumber(prior.price, priceDecimal) &&
      prior.currency === input.currency &&
      prior.in_stock === input.inStock;
    const dtMs = input.seenAt.getTime() - new Date(prior.seen_at).getTime();
    if (identical && dtMs >= 0 && dtMs <= DEDUPE_WINDOW_MS) {
      return { inserted: false, offerId: null, pricePerStickCents };
    }
  }

  const inserted = await db
    .insert(offers)
    .values({
      vendorId: input.vendorId,
      cigarId: input.cigarId,
      listingUrl: input.listingUrl ?? null,
      seenAt: input.seenAt,
      price: priceDecimal,
      currency: input.currency,
      inStock: input.inStock,
      packaging: input.packaging,
      sticksPerPackage: input.sticksPerPackage,
      pricePerStickCents,
      priceType: input.priceType,
      sourceName: input.sourceName,
      sourceUrl: input.sourceUrl,
      listingMatchId: input.listingMatchId ?? null,
      raw: input.raw ?? null,
    })
    .returning({ id: offers.id });

  return { inserted: true, offerId: inserted[0]!.id, pricePerStickCents };
}
