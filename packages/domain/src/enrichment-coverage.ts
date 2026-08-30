import { sql } from "drizzle-orm";
import type { Queryer } from "./deps.js";
import type { CigarType } from "./types.js";

// Vendor coverage for the enrichment queue (ADR-006 amendment 2026-08-30,
// issue #158). ONE definition of eligibility, exhaustion and the attempt ledger,
// shared by the crawler's drain, request_cigar_enrichment's classifier and the
// bulk backlog press — three callers that previously could not have agreed,
// because only the crawler had a notion of "vendor" at all.
//
// The ruling this module encodes: A VENDOR'S CATALOGUE IS PARTIAL. A vendor
// carries some brands and not others; that is the normal case, not a crawl
// failure. `vendors.focus` is a coarse MARKET signal — sound as a negative filter
// (a CC-only vendor will not carry an NC cigar, so never spend a look there) and
// unsound as a positive one (it says which market a vendor trades in, never which
// brands within it). So "no match at vendor V" is evidence about V ONLY, and any
// budget, staleness rule or `exhausted` state that does not NAME A VENDOR is
// meaningless.

// The per-vendor budget. The SAME number the pre-0023 code used per request — the
// change is the denominator, not the constant. Enabling a fourth vendor must
// never require touching a number here again.
export const ATTEMPTS_PER_VENDOR = 2;

// Consecutive looks that could NOT complete before a vendor is retired from this
// request. A failed look is not evidence about the vendor's catalogue, so it
// never burns `attempts` — but it has to be bounded, or a permanently broken
// vendor pins a request open and re-fetches the same 404s every night forever.
export const ERROR_BUDGET = 3;

export type EnrichmentOutcome = "match" | "miss" | "error";

export interface VendorBrief {
  vendorId: string;
  name: string;
}

// One vendor's spend against one ask, aggregated across that cigar's requests
// when read at cigar level.
export interface VendorAttemptSummary extends VendorBrief {
  attempts: number;
  errors: number;
  lastAttemptAt: Date;
}

export interface EnrichmentCoverage {
  // Every vendor that COULD look, right now. The denominator of exhaustion and
  // the honest answer to "who has not been asked?".
  eligible: VendorBrief[];
  // Every vendor that HAS looked — including vendors no longer eligible, because
  // "V did not carry this on 2026-08-30" stays true and is worth having when V
  // comes back.
  tried: VendorAttemptSummary[];
  // At least one non-fulfilled request is retired at every eligible vendor.
  exhausted: boolean;
  // Non-fulfilled requests a drain would STILL select — the honest "already
  // queued". A cached-`exhausted` row that a newly enabled vendor has not looked
  // at counts here, because the drain admits `exhausted` and will pick it up.
  openRequests: number;
}

// The negative filter, and nothing more. It excludes only when BOTH sides are
// known AND they disagree: an unknown vendor focus or an unknown cigar market
// means we cannot rule the vendor out, so it must be asked. That is the same
// reasoning the backlog's untyped-cigar rule already applies — enrichment is what
// would tell us which market the cigar belongs to, and guessing is how a CC row
// gets retired by an NC-only fleet.
export function vendorCoversType(focus: string | null, type: CigarType | null): boolean {
  if (focus == null || focus === "both") return true;
  if (type == null) return true;
  return focus === type;
}

// ELIGIBLE: `crawl_enabled` AND focus covers the market. Deliberately NOT "has
// ever completed an enrich run" — using liveness here is circular, since a
// brand-new lane has never run, so it could never take a request and could never
// become live. Liveness gates the QUEUE (see liveEnrichMarkets); eligibility is
// the exhaustion denominator.
export async function eligibleEnrichVendors(q: Queryer, type: CigarType | null): Promise<VendorBrief[]> {
  const result = await q.execute(sql`
    SELECT v.id, v.name
    FROM vendors v
    WHERE v.crawl_enabled
      AND (${type}::text IS NULL OR v.focus IS NULL OR v.focus = 'both' OR v.focus = ${type}::text)
    ORDER BY v.name
  `);
  return (result.rows as unknown as { id: string; name: string }[]).map((r) => ({
    vendorId: r.id,
    name: r.name,
  }));
}

// LIVE: the markets an enrich pass actually reaches — a crawl-enabled vendor
// whose focus covers the market AND which has completed at least one `enrich`
// run. Moved here verbatim from curation.ts so the crawler and curation cannot
// drift on it. The run is the load-bearing half: Cuban Lou's is `crawl_enabled`
// and has only ever run a `seed`, so `crawl_enabled` alone would claim CC is
// covered while the only enrich CronJob is NC-only. Reading the runs table means
// the gate opens by itself the first night a new enrich lane runs.
export async function liveEnrichMarkets(q: Queryer): Promise<Set<CigarType>> {
  const result = await q.execute(sql`
    SELECT DISTINCT v.focus
    FROM vendors v
    WHERE v.crawl_enabled
      AND v.focus IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM crawl_runs cr
        WHERE cr.vendor_id = v.id AND cr.kind = 'enrich' AND cr.status = 'succeeded'
      )
  `);
  const markets = new Set<CigarType>();
  for (const row of result.rows as unknown as { focus: string }[]) {
    if (row.focus === "both") {
      markets.add("NC");
      markets.add("CC");
    } else if (row.focus === "NC" || row.focus === "CC") {
      markets.add(row.focus);
    }
  }
  return markets;
}

// A vendor is SPENT on an ask once it has completed its looks, or failed to
// complete too many in a row.
function spent(row: { attempts: number; errors: number }): boolean {
  return row.attempts >= ATTEMPTS_PER_VENDOR || row.errors >= ERROR_BUDGET;
}

interface LedgerRow {
  requestId: string;
  vendorId: string;
  name: string;
  attempts: number;
  errors: number;
  lastAttemptAt: Date;
}

async function ledgerRows(q: Queryer, where: ReturnType<typeof sql>): Promise<LedgerRow[]> {
  const result = await q.execute(sql`
    SELECT a.request_id, a.vendor_id, v.name, a.attempts, a.errors, a.last_attempt_at
    FROM enrichment_attempts a
    JOIN enrichment_requests r ON r.id = a.request_id
    JOIN vendors v ON v.id = a.vendor_id
    WHERE ${where}
    ORDER BY v.name
  `);
  return (
    result.rows as unknown as {
      request_id: string;
      vendor_id: string;
      name: string;
      attempts: number;
      errors: number;
      last_attempt_at: string | Date;
    }[]
  ).map((r) => ({
    requestId: r.request_id,
    vendorId: r.vendor_id,
    name: r.name,
    attempts: Number(r.attempts),
    errors: Number(r.errors),
    lastAttemptAt: r.last_attempt_at instanceof Date ? r.last_attempt_at : new Date(r.last_attempt_at),
  }));
}

// The rollup. A request is exhausted when EVERY eligible vendor has spent its own
// budget on it — and there is at least one such vendor.
//
// Zero eligible vendors is NOT exhausted, and the distinction is the whole point:
// "nobody could look" is a different fact from "we looked and found nothing", and
// laundering one into the other is precisely what the ADR forbids. Such a request
// stays open and self-heals the moment a vendor becomes eligible.
//
// Eligibility is evaluated HERE, at rollup time, never at write time. That is
// what makes every state transition automatic: enabling a vendor adds an unspent
// row to the denominator and reopens the request with no cron and no backfill;
// disabling one drops it from both numerator and denominator while its verdict
// stays on the books.
function exhaustedRequestIds(
  eligible: VendorBrief[],
  rows: LedgerRow[],
  requestIds: string[],
): Set<string> {
  if (eligible.length === 0) return new Set();
  const byRequest = new Map<string, Map<string, LedgerRow>>();
  for (const row of rows) {
    let perVendor = byRequest.get(row.requestId);
    if (!perVendor) {
      perVendor = new Map();
      byRequest.set(row.requestId, perVendor);
    }
    perVendor.set(row.vendorId, row);
  }
  const exhausted = new Set<string>();
  for (const requestId of requestIds) {
    const perVendor = byRequest.get(requestId);
    if (!perVendor) continue;
    const allSpent = eligible.every((vendor) => {
      const row = perVendor.get(vendor.vendorId);
      return row != null && spent(row);
    });
    if (allSpent) exhausted.add(requestId);
  }
  return exhausted;
}

// Sum a vendor's spend across however many requests were rolled up, so a cigar
// with a re-queued history still reports one line per vendor.
function summarize(rows: LedgerRow[]): VendorAttemptSummary[] {
  const byVendor = new Map<string, VendorAttemptSummary>();
  for (const row of rows) {
    const existing = byVendor.get(row.vendorId);
    if (existing) {
      existing.attempts += row.attempts;
      existing.errors += row.errors;
      if (row.lastAttemptAt > existing.lastAttemptAt) existing.lastAttemptAt = row.lastAttemptAt;
    } else {
      byVendor.set(row.vendorId, {
        vendorId: row.vendorId,
        name: row.name,
        attempts: row.attempts,
        errors: row.errors,
        lastAttemptAt: row.lastAttemptAt,
      });
    }
  }
  return [...byVendor.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Coverage for ONE ask — the crawler's question after a look.
export async function enrichmentCoverageForRequest(
  q: Queryer,
  requestId: string,
  type: CigarType | null,
): Promise<EnrichmentCoverage> {
  const eligible = await eligibleEnrichVendors(q, type);
  const rows = await ledgerRows(q, sql`a.request_id = ${requestId}`);
  const exhausted = exhaustedRequestIds(eligible, rows, [requestId]);
  return {
    eligible,
    tried: summarize(rows),
    exhausted: exhausted.size > 0,
    openRequests: 1 - exhausted.size,
  };
}

// Coverage for a CIGAR — the classifier's question, which spans however many
// requests the cigar accumulated. `fulfilled` requests are excluded: one
// catalogue photo per cigar means that ask is answered, and rolling a fulfilled
// row into the verdict would report a satisfied cigar as retired.
export async function enrichmentCoverageForCigar(
  q: Queryer,
  cigarId: string,
  type: CigarType | null,
): Promise<EnrichmentCoverage> {
  const eligible = await eligibleEnrichVendors(q, type);
  const open = await q.execute(sql`
    SELECT id FROM enrichment_requests WHERE cigar_id = ${cigarId} AND status <> 'fulfilled'
  `);
  const requestIds = (open.rows as unknown as { id: string }[]).map((r) => r.id);
  if (requestIds.length === 0) return { eligible, tried: [], exhausted: false, openRequests: 0 };
  const rows = await ledgerRows(q, sql`r.cigar_id = ${cigarId} AND r.status <> 'fulfilled'`);
  const exhausted = exhaustedRequestIds(eligible, rows, requestIds);
  return {
    eligible,
    tried: summarize(rows),
    exhausted: exhausted.size > 0,
    openRequests: requestIds.length - exhausted.size,
  };
}

// The atomic increment. ON CONFLICT against UNIQUE (request_id, vendor_id) is
// what makes two overlapping same-vendor runs record TWO real looks instead of
// losing one to a read-modify-write — the pre-0023 drain read `attempts` and
// wrote back `attempts + 1`, so concurrent runs silently dropped one (#157
// defect 1). Here the worst case is a benign double-count of two looks that both
// genuinely happened.
//
// `errors` is reset by any completed look because the budget is for CONSECUTIVE
// failures: a vendor that answers once is not permanently broken.
export async function recordEnrichmentAttempt(
  q: Queryer,
  input: { requestId: string; vendorId: string; outcome: EnrichmentOutcome; at: Date; note?: string | null },
): Promise<void> {
  const isError = input.outcome === "error";
  await q.execute(sql`
    INSERT INTO enrichment_attempts
      (request_id, vendor_id, attempts, errors, last_outcome, last_attempt_at, note)
    VALUES (
      ${input.requestId},
      ${input.vendorId},
      ${isError ? 0 : 1},
      ${isError ? 1 : 0},
      ${input.outcome},
      ${input.at},
      ${input.note ?? null}
    )
    ON CONFLICT (request_id, vendor_id) DO UPDATE SET
      attempts = enrichment_attempts.attempts + ${isError ? 0 : 1},
      errors = ${isError ? sql`enrichment_attempts.errors + 1` : sql`0`},
      last_outcome = ${input.outcome},
      last_attempt_at = ${input.at},
      note = COALESCE(${input.note ?? null}, enrichment_attempts.note)
  `);
}
